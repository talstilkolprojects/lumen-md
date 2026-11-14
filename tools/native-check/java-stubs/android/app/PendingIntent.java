package android.app;
import android.content.Context;
import android.content.Intent;
public final class PendingIntent {
  public static final int FLAG_UPDATE_CURRENT = 1 << 27, FLAG_IMMUTABLE = 1 << 26, FLAG_ONE_SHOT = 1 << 30;
  public static PendingIntent getActivity(Context context, int requestCode, Intent intent, int flags) { return null; }
  public static PendingIntent getBroadcast(Context context, int requestCode, Intent intent, int flags) { return null; }
}
