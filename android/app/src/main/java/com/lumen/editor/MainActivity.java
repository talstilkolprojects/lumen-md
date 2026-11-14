package com.lumen.editor;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plan W3.4: the app's own plugin (widgets, App Shortcuts), registered before the bridge starts.
        registerPlugin(LumenNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
