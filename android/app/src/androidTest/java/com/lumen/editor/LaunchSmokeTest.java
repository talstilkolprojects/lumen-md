package com.lumen.editor;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.os.SystemClock;
import android.webkit.WebView;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Plan W6.24: the launch smoke test for cloud devices (BrowserStack App Automate, the
 * fallback for Firebase Test Lab's robo run). The app starts, Capacitor's WebView loads
 * the bundled web app to 100 %, and the activity is still resumed: no crash, no ANR.
 */
@RunWith(AndroidJUnit4.class)
public class LaunchSmokeTest {
    private static final long LOAD_TIMEOUT_MS = 30_000;

    @Test
    public void appStartsAndLoadsTheEditor() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<String> url = new AtomicReference<>();
            AtomicBoolean loaded = new AtomicBoolean(false);
            long deadline = SystemClock.uptimeMillis() + LOAD_TIMEOUT_MS;
            while (!loaded.get() && SystemClock.uptimeMillis() < deadline) {
                scenario.onActivity(activity -> {
                    WebView web = activity.getBridge() == null ? null : activity.getBridge().getWebView();
                    if (web != null) {
                        url.set(web.getUrl());
                        loaded.set(web.getUrl() != null && web.getProgress() == 100);
                    }
                });
                if (!loaded.get()) SystemClock.sleep(250);
            }
            assertTrue("the web app did not load within 30 s (last URL: " + url.get() + ")", loaded.get());
            assertEquals(Lifecycle.State.RESUMED, scenario.getState());
        }
    }
}
