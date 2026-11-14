package android.content;
import android.net.Uri;
public class Intent {
  public static final String ACTION_VIEW = "android.intent.action.VIEW", ACTION_OPEN_DOCUMENT_TREE = "android.intent.action.OPEN_DOCUMENT_TREE";
  public static final int FLAG_GRANT_READ_URI_PERMISSION = 1, FLAG_GRANT_WRITE_URI_PERMISSION = 2, FLAG_GRANT_PERSISTABLE_URI_PERMISSION = 64;
  public static final int FLAG_ACTIVITY_NEW_TASK = 0x10000000, FLAG_ACTIVITY_SINGLE_TOP = 0x20000000, FLAG_ACTIVITY_CLEAR_TOP = 0x04000000;
  public Intent() {}
  public Intent(String action) {}
  public Intent(String action, Uri uri) {}
  public Intent(Context packageContext, Class<?> cls) {}
  public Intent(String action, Uri uri, Context packageContext, Class<?> cls) {}
  public Uri getData() { return null; }
  public String getAction() { return null; }
  public Intent addFlags(int flags) { return this; }
  public Intent setFlags(int flags) { return this; }
}
