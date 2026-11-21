package com.lumennotes.mobile;

import com.journeyapps.barcodescanner.CaptureActivity;

/**
 * ZXing's bundled CaptureActivity is declared sensorLandscape inside the
 * library manifest, and IntentIntegrator.setOrientationLocked() cannot change
 * a manifest attribute. An empty subclass lets our own manifest declare the
 * same behaviour with screenOrientation="portrait" instead.
 *
 * The activity's theme and window flags are copied from the library
 * declaration in AndroidManifest.xml so the scanner keeps its full-screen
 * camera view without an action bar.
 */
public class PortraitCaptureActivity extends CaptureActivity {
}
