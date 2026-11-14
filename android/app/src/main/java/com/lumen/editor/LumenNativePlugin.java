package com.lumen.editor;

import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The native half of src/mobile/nativeActions.ts (plan W3.4), as the
 * Capacitor plugin {@code LumenNative}: forwards lumen:// links from the
 * home-screen widget and App Shortcuts to the WebView. Android has no
 * Shortcuts app, so the pending-captures queue is always empty here.
 */
@CapacitorPlugin(name = "LumenNative")
public class LumenNativePlugin extends Plugin {
    private String launchUrl;

    @Override
    public void load() {
        Intent intent = getActivity() != null ? getActivity().getIntent() : null;
        launchUrl = urlOf(intent);
    }

    private static String urlOf(Intent intent) {
        if (intent == null) return null;
        Uri data = intent.getData();
        String url = data != null ? data.toString() : null;
        return LumenActions.isAction(url) ? LumenActions.stamped(url, System.currentTimeMillis()) : null;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String url = urlOf(intent);
        if (url == null) return;
        JSObject ev = new JSObject();
        ev.put("url", url);
        notifyListeners("url", ev);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        notifyListeners("resume", new JSObject());
    }

    @PluginMethod
    public void getLaunchUrl(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("url", launchUrl);
        launchUrl = null;
        call.resolve(ret);
    }

    @PluginMethod
    public void pendingCaptures(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("items", new JSArray());
        call.resolve(ret);
    }

    @PluginMethod
    public void removeCaptures(PluginCall call) {
        call.resolve();
    }
}
