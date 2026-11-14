package android.appwidget;
import android.content.Context;
import android.content.Intent;
public class AppWidgetProvider extends android.content.BroadcastReceiver {
  public void onReceive(Context context, Intent intent) {}
  public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {}
}
