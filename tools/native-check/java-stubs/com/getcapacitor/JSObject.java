package com.getcapacitor;
/** Capacitor 7 JSObject: put() overrides swallow JSONException. */
public class JSObject extends org.json.JSONObject {
  public JSObject put(String key, boolean value) { return this; }
  public JSObject put(String key, int value) { return this; }
  public JSObject put(String key, long value) { return this; }
  public JSObject put(String key, double value) { return this; }
  public JSObject put(String key, Object value) { return this; }
  public JSObject put(String key, String value) { return this; }
  public String getString(String key) { return null; }
}
