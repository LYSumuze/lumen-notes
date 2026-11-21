package com.lumennotes.mobile;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Rect;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.view.View;
import android.view.Window;

import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** Same SharedPreferences name as LumenVaultPlugin.PREFS. */
    private static final String PREFS = "lumen-vault";
    private int lastImeDp = -1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Capacitor 6+ no longer auto-discovers local plugins. Register BEFORE
        // super.onCreate(): that call builds the bridge from this builder.
        registerPlugin(LumenVaultPlugin.class);
        registerPlugin(LumenScanPlugin.class);
        super.onCreate(savedInstanceState);
        // The XML theme is light by default; restore the user's last choice
        // before the first frame so a dark theme never flashes a white bar.
        applyStatusBar(this, savedDark());
        installImeInsets();
    }

    @Override
    public void onResume() {
        super.onResume();
        // Capacitor swaps the launch (SplashScreen) theme for the app theme
        // after onCreate. That re-applies the XML's light status-bar flags and
        // used to undo the runtime dark choice, leaving a white strip on top of
        // a dark UI. Re-assert the persisted value on every resume.
        applyStatusBar(this, savedDark());
        // A WebView reload may not produce a fresh insets callback. Re-publish
        // the last known value once the page has had time to load.
        if (lastImeDp >= 0) {
            final int dp = lastImeDp;
            getWindow().getDecorView().postDelayed(() -> pushImeHeight(dp, true), 400);
        }
    }

    /**
     * Android 15 (targetSdk 35) is edge-to-edge: with adjustResize the WebView
     * and window.visualViewport often do NOT shrink for the IME, so the page
     * cannot infer the keyboard height at all. Capacitor's own insets listener
     * lives on the WebView, handles only system bars, and consumes them, so it
     * cannot help either. Read the real IME inset on the decor view and publish
     * it to the page as --m-ime-h (CSS px) plus a lumen:ime event.
     *
     * This is device independent: candidate strips, user-resized keyboard
     * layouts, one-handed and floating keyboards all show up in the inset.
     */
    private void installImeInsets() {
        View decor = getWindow().getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(decor, (v, insets) -> {
            int imePx = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
            if (imePx <= 0) {
                // A few ROMs report zero for ime(); keep the classic
                // visible-frame difference as a secondary source.
                Rect r = new Rect();
                v.getWindowVisibleDisplayFrame(r);
                imePx = Math.max(0, v.getRootView().getHeight() - r.bottom);
            }
            int dp = Math.round(imePx / getResources().getDisplayMetrics().density);
            pushImeHeight(dp, false);
            // Do NOT consume: CapacitorWebView still needs system-bar insets.
            return insets;
        });
        ViewCompat.requestApplyInsets(decor);
    }

    private void pushImeHeight(int dp, boolean force) {
        if (!force && dp == lastImeDp) return;
        lastImeDp = dp;
        final String js =
                "document.documentElement.style.setProperty('--m-ime-h','" + dp + "px');"
              + "document.documentElement.dataset.ime='" + dp + "';"
              + "window.dispatchEvent(new CustomEvent('lumen:ime',{detail:{height:" + dp + "}}));";
        runOnUiThread(() -> {
            try {
                if (getBridge() != null && getBridge().getWebView() != null) {
                    getBridge().getWebView().evaluateJavascript(js, null);
                }
            } catch (Throwable ignored) { /* WebView not ready yet */ }
        });
    }

    private boolean savedDark() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("statusBarDark", false);
    }

    static void applyStatusBar(Activity activity, boolean dark) {
        Window w = activity.getWindow();
        if (w == null) return;
        final int color = dark ? 0xFF1E1E1E : 0xFFFFFFFF;

        // With adjustMarginsForEdgeToEdge="force" the WebView is inset and the
        // top strip is painted by the *window background*, not by the WebView.
        // Colouring only the status bar leaves a white band on some devices.
        w.setBackgroundDrawable(new ColorDrawable(color));
        w.setStatusBarColor(color);

        // setSystemUiVisibility / SYSTEM_UI_FLAG_LIGHT_STATUS_BAR is deprecated
        // and ignored on recent Android versions. The compat controller writes
        // the appearance flag that actually governs icon contrast on API 23-35.
        WindowInsetsControllerCompat controller =
                new WindowInsetsControllerCompat(w, w.getDecorView());
        controller.setAppearanceLightStatusBars(!dark);
    }
}
