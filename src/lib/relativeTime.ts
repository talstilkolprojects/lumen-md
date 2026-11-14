import { t, getLocale } from "../i18n";

/**
 * Format a timestamp as a localized "X minutes ago" / "Y days ago"
 * string. Lives in its own module so App.tsx can stay component-only
 * — mixing component + non-component exports kills React Fast Refresh
 * for the whole file.
 */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return t("time.justNow");
  if (mins < 60) return t("time.minutesAgo", { n: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("time.hoursAgo", { n: hours });
  const days = Math.round(hours / 24);
  if (days < 30) return t("time.daysAgo", { n: days });
  return new Date(ts).toLocaleDateString(getLocale());
}
