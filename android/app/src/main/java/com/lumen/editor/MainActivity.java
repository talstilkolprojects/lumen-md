package com.lumen.editor;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plan W3.4: the app's own plugin (widgets, App Shortcuts), registered before the bridge starts.
        registerPlugin(LumenNativePlugin.class);
        // Plan 4.20 (W10.C14): the vault in a folder the user picks (Storage Access Framework).
        registerPlugin(LumenVaultFolderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
