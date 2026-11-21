package com.lumennotes.mobile;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.net.Uri;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * The phone's own local vault, backed by a SAF document tree the user picks once.
 *
 * Contract mirrors src/native/platform.ts (VaultFs) and src/lib/mobileVault.ts:
 * paths are vault-relative POSIX paths, dot directories (.lumen-vcs, .lumen-history)
 * are ordinary files, writes create missing parents, binary payloads travel as
 * base64 because the Capacitor bridge only carries JSON.
 *
 * No .md is ever written to the desktop over the network: only the published
 * cloud snapshot uses REST. All methods here are device-local.
 */
@CapacitorPlugin(name = "LumenVault")
public class LumenVaultPlugin extends Plugin {

    private static final String PREFS = "lumen-vault";
    private static final String KEY_URI = "treeUri";
    private static final String KEY_NAME = "treeName";

    /**
     * Read the system clipboard natively. navigator.clipboard.readText() is
     * unreliable inside an Android WebView (permission and user-gesture rules),
     * while this is always a foreground, user-initiated action.
     */
    @PluginMethod
    public void readClipboard(PluginCall call) {
        try {
            ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            String text = "";
            if (cm != null && cm.hasPrimaryClip()) {
                ClipData clip = cm.getPrimaryClip();
                if (clip != null && clip.getItemCount() > 0) {
                    CharSequence cs = clip.getItemAt(0).getText();
                    if (cs != null) text = cs.toString();
                }
            }
            JSObject ret = new JSObject();
            ret.put("text", text);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("读取剪贴板失败", "CLIPBOARD_FAILED", e);
        }
    }

    /**
     * Status-bar colours live in the native theme, so the WebView cannot
     * change them. Called whenever the resolved app theme changes; the last
     * value is persisted so the very next cold start is already correct.
     */
    @PluginMethod
    public void setStatusBarStyle(PluginCall call) {
        final boolean dark = Boolean.TRUE.equals(call.getBoolean("dark"));
        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(() -> {
                MainActivity.applyStatusBar(activity, dark);
                prefs().edit().putBoolean("statusBarDark", dark).apply();
            });
        }
        call.resolve();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private Uri savedUri() {
        String s = prefs().getString(KEY_URI, null);
        return s == null ? null : Uri.parse(s);
    }

    /** A tree URI is useless once its persistable grant is gone (e.g. user
     *  revoked it in system settings). Treat that as "no vault configured". */
    private boolean hasPersisted(Uri uri) {
        for (UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (p.getUri().equals(uri) && p.isReadPermission() && p.isWritePermission()) return true;
        }
        return false;
    }

    private DocumentFile root() {
        Uri uri = savedUri();
        if (uri == null || !hasPersisted(uri)) return null;
        return DocumentFile.fromTreeUri(getContext(), uri);
    }

    private DocumentFile requireRoot() throws IOException {
        DocumentFile r = root();
        if (r == null) throw new IOException("NO_VAULT: 请先在欢迎页选择仓库文件夹");
        return r;
    }

    private String displayName(DocumentFile root) {
        if (root != null && root.getName() != null && !root.getName().isEmpty()) return root.getName();
        String saved = prefs().getString(KEY_NAME, "");
        return saved.isEmpty() ? "手机仓库" : saved;
    }

    /* ------------------------------------------------------------ vault pick */

    @PluginMethod
    public void getVault(PluginCall call) {
        DocumentFile r = root();
        JSObject ret = new JSObject();
        ret.put("vault", displayName(r));
        ret.put("configured", r != null);
        call.resolve(ret);
    }

    @PluginMethod
    public void chooseVault(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, i, "pickVaultResult");
    }

    @ActivityCallback
    private void pickVaultResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        Uri uri = data == null ? null : data.getData();
        if (uri == null || result.getResultCode() != Activity.RESULT_OK) {
            call.resolve(); // cancelled -> JS receives null
            return;
        }
        int flags = data.getFlags()
                & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if (flags == 0) flags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, flags);
            DocumentFile r = DocumentFile.fromTreeUri(getContext(), uri);
            String name = (r != null && r.getName() != null && !r.getName().isEmpty())
                    ? r.getName() : "手机仓库";
            prefs().edit().putString(KEY_URI, uri.toString()).putString(KEY_NAME, name).apply();
            JSObject ret = new JSObject();
            ret.put("vault", name);
            ret.put("configured", true);
            call.resolve(ret);
        } catch (Exception e) {
            reject(call, e);
        }
    }

    /* -------------------------------------------------------- path helpers */

    /** Reject absolute paths, drive letters, traversal and empty segments. Dot
     *  directories ARE allowed: the version chain lives in .lumen-vcs/. */
    private static String clean(String rel) {
        if (rel == null) throw new IllegalArgumentException("路径为空");
        String s = rel.replace('\\', '/');
        while (s.startsWith("/")) s = s.substring(1);
        if (s.isEmpty()) throw new IllegalArgumentException("路径为空");
        for (String part : s.split("/")) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")
                    || part.indexOf(':') >= 0 || part.indexOf('\0') >= 0) {
                throw new SecurityException("非法路径：" + rel);
            }
        }
        return s;
    }

    private DocumentFile parentOf(String rel, boolean create) throws IOException {
        DocumentFile cur = requireRoot();
        String[] parts = rel.split("/");
        for (int i = 0; i < parts.length - 1; i++) {
            DocumentFile next = cur.findFile(parts[i]);
            if (next != null && !next.isDirectory()) throw new IOException("路径被文件占用：" + parts[i]);
            if (next == null) {
                if (!create) throw new FileNotFoundException(rel);
                next = cur.createDirectory(parts[i]);
            }
            if (next == null) throw new IOException("无法创建目录：" + parts[i]);
            cur = next;
        }
        return cur;
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".md") || n.endsWith(".markdown") || n.endsWith(".txt")) return "text/plain";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    private DocumentFile ensureFile(String rel) throws IOException {
        String path = clean(rel);
        DocumentFile parent = parentOf(path, true);
        String name = path.substring(path.lastIndexOf('/') + 1);
        DocumentFile f = parent.findFile(name);
        if (f == null) {
            f = parent.createFile(mimeOf(name), name);
            if (f == null) throw new IOException("无法创建文件：" + name);
            // Some providers append an extension when the MIME does not match.
            if (!name.equals(f.getName())) f.renameTo(name);
        }
        return f;
    }

    private DocumentFile requireFile(String rel) throws IOException {
        String path = clean(rel);
        DocumentFile parent = parentOf(path, false);
        String name = path.substring(path.lastIndexOf('/') + 1);
        DocumentFile f = parent.findFile(name);
        if (f == null || f.isDirectory()) throw new FileNotFoundException(path);
        return f;
    }

    private byte[] readAll(DocumentFile f) throws IOException {
        try (InputStream is = getContext().getContentResolver().openInputStream(f.getUri())) {
            if (is == null) throw new IOException("无法读取：" + f.getName());
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        }
    }

    private void writeAll(DocumentFile f, byte[] data) throws IOException {
        try (OutputStream os = getContext().getContentResolver().openOutputStream(f.getUri(), "wt")) {
            if (os == null) throw new IOException("无法写入：" + f.getName());
            os.write(data);
            os.flush();
        }
    }

    private static void reject(PluginCall call, Exception e) {
        String msg = e.getMessage() == null ? e.toString() : e.getMessage();
        call.reject(msg, e.getClass().getSimpleName(), e);
    }

    /* ------------------------------------------------------------- VaultFs */

    @PluginMethod
    public void listFiles(PluginCall call) {
        try {
            JSArray files = new JSArray();
            walk(requireRoot(), "", files);
            JSObject ret = new JSObject();
            ret.put("files", files);
            call.resolve(ret);
        } catch (Exception e) {
            reject(call, e);
        }
    }

    private void walk(DocumentFile dir, String prefix, JSArray out) {
        DocumentFile[] children = dir.listFiles();
        if (children == null) return;
        for (DocumentFile f : children) {
            String name = f.getName();
            if (name == null) continue;
            String rel = prefix.isEmpty() ? name : prefix + "/" + name;
            if (f.isDirectory()) {
                walk(f, rel, out);
                continue;
            }
            JSObject o = new JSObject();
            o.put("path", rel);
            o.put("size", f.length());
            o.put("mtime", f.lastModified());
            out.put(o);
        }
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        try {
            byte[] bytes = readAll(requireFile(call.getString("path")));
            String text = new String(bytes, StandardCharsets.UTF_8);
            if (!text.isEmpty() && text.charAt(0) == '\uFEFF') text = text.substring(1);
            JSObject ret = new JSObject();
            ret.put("content", text);
            call.resolve(ret);
        } catch (Exception e) {
            reject(call, e);
        }
    }

    @PluginMethod
    public void writeFile(PluginCall call) {
        try {
            String content = call.getString("content");
            writeAll(ensureFile(call.getString("path")),
                    (content == null ? "" : content).getBytes(StandardCharsets.UTF_8));
            call.resolve();
        } catch (Exception e) {
            reject(call, e);
        }
    }

    @PluginMethod
    public void removeFile(PluginCall call) {
        try {
            DocumentFile f = requireFile(call.getString("path"));
            if (!f.delete()) throw new IOException("删除失败：" + f.getName());
            call.resolve();
        } catch (FileNotFoundException e) {
            call.resolve(); // idempotent
        } catch (Exception e) {
            reject(call, e);
        }
    }

    @PluginMethod
    public void readBinary(PluginCall call) {
        try {
            byte[] bytes = readAll(requireFile(call.getString("path")));
            JSObject ret = new JSObject();
            ret.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            reject(call, e);
        }
    }

    @PluginMethod
    public void writeBinary(PluginCall call) {
        try {
            String b64 = call.getString("base64");
            byte[] bytes = Base64.decode(b64 == null ? "" : b64, Base64.DEFAULT);
            writeAll(ensureFile(call.getString("path")), bytes);
            call.resolve();
        } catch (Exception e) {
            reject(call, e);
        }
    }

    @PluginMethod
    public void removeBinary(PluginCall call) {
        removeFile(call);
    }
}
