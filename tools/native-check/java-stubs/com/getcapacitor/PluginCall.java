package com.getcapacitor;
public class PluginCall {
  public void resolve() {}
  public void resolve(JSObject data) {}
  public void reject(String msg) {}
  public String getString(String name) { return null; }
  public String getString(String name, String defaultValue) { return null; }
  public void reject(String msg, Exception e) {}
  public JSObject getData() { return null; }
}
