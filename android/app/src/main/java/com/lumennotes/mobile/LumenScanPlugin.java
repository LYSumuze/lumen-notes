package com.lumennotes.mobile;

import android.content.Intent;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;

/**
 * Local QR scanner for the desktop pairing QR code. Uses ZXing's bundled
 * decoder (no Google Play Services / ML Kit model download), so it works on
 * devices without Play Services and offline.
 */
@CapacitorPlugin(name = "LumenScan")
public class LumenScanPlugin extends Plugin {

    @PluginMethod
    public void scanQr(PluginCall call) {
        try {
            IntentIntegrator integrator = new IntentIntegrator(getActivity());
            integrator.setDesiredBarcodeFormats(IntentIntegrator.QR_CODE);
            integrator.setPrompt("扫描电脑端配对二维码");
            integrator.setBeepEnabled(false);
            integrator.setBarcodeImageEnabled(false);
            integrator.setCaptureActivity(PortraitCaptureActivity.class);
            integrator.setOrientationLocked(true);
            Intent intent = integrator.createScanIntent();
            startActivityForResult(call, intent, "scanQrResult");
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? e.toString() : e.getMessage(), "SCAN_FAILED", e);
        }
    }

    @ActivityCallback
    private void scanQrResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        IntentResult r = IntentIntegrator.parseActivityResult(result.getResultCode(), result.getData());
        if (r == null || r.getContents() == null) {
            call.resolve(); // cancelled
            return;
        }
        JSObject ret = new JSObject();
        ret.put("text", r.getContents());
        call.resolve(ret);
    }
}
