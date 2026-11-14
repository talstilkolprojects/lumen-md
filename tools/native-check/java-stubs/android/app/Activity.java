package android.app;
import android.content.Intent;
import android.os.Bundle;
public class Activity extends android.content.Context {
  public static final int RESULT_OK = -1, RESULT_CANCELED = 0;
  public String getPackageName() { return null; }
  protected void onCreate(Bundle savedInstanceState) {}
  protected void onNewIntent(Intent intent) {}
  public Intent getIntent() { return null; }
}
