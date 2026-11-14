package org.json;
public class JSONObject {
  public long getLong(String name) throws JSONException { return 0; }
  public String getString(String name) throws JSONException { return null; }
  public JSONObject put(String name, boolean value) throws JSONException { return this; }
  public JSONObject put(String name, int value) throws JSONException { return this; }
  public JSONObject put(String name, long value) throws JSONException { return this; }
  public JSONObject put(String name, double value) throws JSONException { return this; }
  public JSONObject put(String name, Object value) throws JSONException { return this; }
}
