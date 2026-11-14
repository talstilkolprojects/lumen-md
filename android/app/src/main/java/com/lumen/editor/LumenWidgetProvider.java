package com.lumen.editor;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

/**
 * The home-screen widget (plan W3.4): search, a quick note, today's note.
 * Each button opens the app on a lumen:// link. The layout uses start/end,
 * so in Hebrew the row runs right to left.
 */
public class LumenWidgetProvider extends AppWidgetProvider {
    private static PendingIntent open(Context ctx, String url, int request) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url), ctx, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(ctx, request, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @Override
    public void onUpdate(Context ctx, AppWidgetManager manager, int[] ids) {
        for (int id : ids) {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_lumen);
            v.setOnClickPendingIntent(R.id.widget_search, open(ctx, LumenActions.SEARCH, 1));
            v.setOnClickPendingIntent(R.id.widget_capture, open(ctx, LumenActions.CAPTURE, 2));
            v.setOnClickPendingIntent(R.id.widget_daily, open(ctx, LumenActions.DAILY, 3));
            manager.updateAppWidget(id, v);
        }
    }
}
