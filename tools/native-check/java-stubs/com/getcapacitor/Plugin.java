package com.getcapacitor;
import android.content.Intent;
import androidx.appcompat.app.AppCompatActivity;
public class Plugin {
  public void load() {}
  public android.content.Context getContext() { return null; }
  protected void startActivityForResult(PluginCall call, Intent intent, String callbackName) {}
  public AppCompatActivity getActivity() { return null; }
  protected void notifyListeners(String eventName, JSObject data) {}
  protected void notifyListeners(String eventName, JSObject data, boolean retainUntilConsumed) {}
  protected void handleOnNewIntent(Intent intent) {}
  protected void handleOnStart() {}
  protected void handleOnResume() {}
  protected void handleOnPause() {}
}
