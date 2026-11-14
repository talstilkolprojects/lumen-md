/**
 * Month calendar under the file tree (plan 4.12): days that have a daily
 * note are marked; a click opens (or creates) that day's note. Month and
 * weekday names, the first day of the week and the Hebrew months all come
 * from Intl for the UI locale; the grid follows the document direction, so
 * it reads right-to-left in Hebrew and Arabic. Loaded lazily.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Settings2 } from "lucide-react";
import { t } from "../i18n";
import { useAppStore } from "../store/useStore";
import { onWorkspaceChanged } from "../storage/workspaceEvents";
import { dayOf, dayOfPath, isoOf, isolatedHebrewDate, isValidDailyPattern, openDailyNote, type Day } from "../daily/dailyNote";

/** Monday = 1 … Sunday = 7, as Intl.Locale weekInfo has it. */
const FIRST_DAY_FALLBACK: Record<string, number> = { he: 7, ar: 6, en: 7, ja: 7, ru: 1, fr: 1, de: 1, "zh-CN": 1, zh: 1 };

export function firstDayOfWeek(locale: string): number {
  try {
    const loc = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay) return info.firstDay;
  } catch {
    /* why: fall back */
  }
  return FIRST_DAY_FALLBACK[locale] ?? FIRST_DAY_FALLBACK[locale.split("-")[0]] ?? 1;
}

/** The weeks of a month: rows of 7 cells, null outside the month. */
export function monthGrid(y: number, m: number, firstDay: number): Array<Array<Day | null>> {
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const iso = first.getUTCDay() === 0 ? 7 : first.getUTCDay(); // 1..7, Monday first
  const lead = (iso - firstDay + 7) % 7;
  const cells: Array<Day | null> = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push({ y, m, d });
  while (cells.length % 7) cells.push(null);
  const rows: Array<Array<Day | null>> = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

const utcNoon = (day: Day) => new Date(Date.UTC(day.y, day.m - 1, day.d, 12));

/** Every Hebrew month (with its year) that a Gregorian month touches, in order — up to three (May 2022: Nisan, Iyar, Sivan). */
export function hebrewMonthsOf(y: number, m: number): string[] {
  const f = new Intl.DateTimeFormat("he-u-ca-hebrew", { month: "long", year: "numeric", timeZone: "UTC" });
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out: string[] = [];
  for (let d = 1; d <= last; d++) {
    const s = f.format(utcNoon({ y, m, d }));
    if (out[out.length - 1] !== s) out.push(s);
  }
  return out;
}

export function CalendarPanel() {
  const locale = useAppStore((s) => s.locale) as string;
  const settings = useAppStore((s) => s.dailyNotes);
  const setDailyNotes = useAppStore((s) => s.setDailyNotes);
  const today = dayOf(new Date());
  const [month, setMonth] = useState({ y: today.y, m: today.m });
  const [withNotes, setWithNotes] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [patternError, setPatternError] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const ws = await import("../storage/workspace");
      if (!ws.isOPFSAvailable()) return;
      const paths = (await ws.listWorkspace()).map((f) => f.path);
      const set = new Set<string>();
      for (const p of paths) {
        const d = dayOfPath(p, settings);
        if (d) set.add(isoOf(d));
      }
      setWithNotes(set);
    } catch {
      /* why: no workspace */
    }
  }, [settings]);

  useEffect(() => {
    void refresh();
    return onWorkspaceChanged((c) => {
      if (c.kind === "structure") void refresh();
    }, { debounceMs: 300 });
  }, [refresh]);

  const firstDay = firstDayOfWeek(locale);
  const rows = useMemo(() => monthGrid(month.y, month.m, firstDay), [month, firstDay]);
  const weekdays = useMemo(() => {
    const f = new Intl.DateTimeFormat(locale, { weekday: "narrow", timeZone: "UTC" });
    const long = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" });
    // 2024-01-01 was a Monday (ISO day 1).
    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(Date.UTC(2024, 0, 1 + ((firstDay - 1 + i) % 7), 12));
      return { short: f.format(date), long: long.format(date) };
    });
  }, [locale, firstDay]);
  const title = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(utcNoon({ ...month, d: 1 }));
  const heMonths = useMemo(() => hebrewMonthsOf(month.y, month.m).join(" – "), [month]);
  const dayLabel = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" });
  const dayNumber = new Intl.DateTimeFormat(locale, { day: "numeric", timeZone: "UTC" });
  const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
  const Prev = rtl ? ChevronRight : ChevronLeft;
  const Next = rtl ? ChevronLeft : ChevronRight;
  const shift = (n: number) =>
    setMonth(({ y, m }) => {
      const k = y * 12 + (m - 1) + n;
      return { y: Math.floor(k / 12), m: (k % 12) + 1 };
    });

  const btn: React.CSSProperties = { border: "none", background: "transparent", color: "hsl(var(--fg-muted))", cursor: "pointer", padding: 3, borderRadius: 5, display: "inline-flex" };
  const input: React.CSSProperties = { inlineSize: "100%", fontSize: 11, paddingBlock: 2, paddingInline: 5, borderRadius: 4, border: "1px solid hsl(var(--border))", background: "hsl(var(--bg))", color: "hsl(var(--fg))" };

  return (
    <section aria-label={t("calendar.title")} data-testid="calendar" style={{ borderBlockStart: "1px solid hsl(var(--border))", paddingBlock: 8, paddingInline: 8, fontSize: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBlockEnd: 2 }}>
        <CalendarDays size={13} aria-hidden />
        <span style={{ fontWeight: 600, flex: 1 }} data-testid="calendar-title">{title}</span>
        <button type="button" style={btn} onClick={() => shift(-1)} aria-label={t("calendar.prev")} title={t("calendar.prev")}>
          <Prev size={14} aria-hidden />
        </button>
        <button type="button" style={{ ...btn, fontSize: 11 }} onClick={() => setMonth({ y: today.y, m: today.m })}>
          {t("calendar.today")}
        </button>
        <button type="button" style={btn} onClick={() => shift(1)} aria-label={t("calendar.next")} title={t("calendar.next")}>
          <Next size={14} aria-hidden />
        </button>
        <button type="button" style={btn} onClick={() => setEditing((v) => !v)} aria-label={t("calendar.settings")} title={t("calendar.settings")} aria-expanded={editing}>
          <Settings2 size={13} aria-hidden />
        </button>
      </div>
      <div style={{ fontSize: 10, color: "hsl(var(--fg-muted))", marginBlockEnd: 4 }} dir="rtl" lang="he">
        {heMonths}
      </div>
      <div role="grid" aria-label={title} style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 1, textAlign: "center" }}>
        {weekdays.map((w) => (
          <div key={w.long} role="columnheader" aria-label={w.long} style={{ fontSize: 10, color: "hsl(var(--fg-muted))", paddingBlock: 2 }}>
            {w.short}
          </div>
        ))}
        {rows.flat().map((day, i) => {
          if (!day) return <div key={`e${i}`} role="gridcell" aria-hidden />;
          const iso = isoOf(day);
          const has = withNotes.has(iso);
          const isToday = iso === isoOf(today);
          const label = `${dayLabel.format(utcNoon(day))} · ${isolatedHebrewDate(day)}${has ? ` — ${t("calendar.hasNote")}` : ""}`;
          return (
            <button
              key={iso}
              type="button"
              role="gridcell"
              data-date={iso}
              data-has-note={has || undefined}
              aria-label={label}
              title={label}
              aria-current={isToday ? "date" : undefined}
              onClick={() =>
                openDailyNote(day, settings, locale).catch((e: unknown) =>
                  void import("../store/useToastStore").then(({ toast }) => toast.error(t("daily.failed", { error: e instanceof Error ? e.message : String(e) }))),
                )
              }
              style={{
                position: "relative",
                paddingBlock: 3,
                border: isToday ? "1px solid hsl(var(--accent))" : "1px solid transparent",
                borderRadius: 5,
                background: has ? "hsl(var(--accent) / 0.12)" : "transparent",
                color: "hsl(var(--fg))",
                fontWeight: has ? 600 : 400,
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {dayNumber.format(utcNoon(day))}
              {has && <span aria-hidden style={{ position: "absolute", insetBlockEnd: 1, insetInlineStart: "50%", inlineSize: 3, blockSize: 3, marginInlineStart: -1.5, borderRadius: 2, background: "hsl(var(--accent))" }} />}
            </button>
          );
        })}
      </div>
      {editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const pattern = String(f.get("pattern") ?? "").trim() || "YYYY-MM-DD";
            if (!isValidDailyPattern(pattern)) {
              setPatternError(true);
              return;
            }
            setPatternError(false);
            setDailyNotes({ folder: String(f.get("folder") ?? ""), pattern, template: String(f.get("template") ?? "") });
            setEditing(false);
          }}
          style={{ display: "grid", gap: 4, marginBlockStart: 8 }}
        >
          <label style={{ display: "grid", gap: 2 }}>
            <span>{t("calendar.folder")}</span>
            <input name="folder" dir="auto" defaultValue={settings.folder} style={input} />
          </label>
          <label style={{ display: "grid", gap: 2 }}>
            <span>{t("calendar.pattern")}</span>
            <input name="pattern" dir="ltr" defaultValue={settings.pattern} style={input} aria-invalid={patternError || undefined} aria-describedby={patternError ? "daily-pattern-error" : undefined} onChange={() => setPatternError(false)} />
          </label>
          {patternError && (
            <span id="daily-pattern-error" role="alert" style={{ fontSize: 10, color: "hsl(var(--danger, 0 70% 50%))" }}>
              {t("calendar.patternInvalid")}
            </span>
          )}
          <label style={{ display: "grid", gap: 2 }}>
            <span>{t("calendar.template")}</span>
            <textarea name="template" dir="auto" rows={4} defaultValue={settings.template} style={{ ...input, fontFamily: "var(--font-mono, monospace)" }} />
          </label>
          <span style={{ fontSize: 10, color: "hsl(var(--fg-muted))" }}>{t("calendar.templateHint")}</span>
          <button type="submit" style={{ ...btn, justifySelf: "end", color: "hsl(var(--accent))", fontWeight: 600 }}>
            {t("calendar.save")}
          </button>
        </form>
      )}
    </section>
  );
}

export default CalendarPanel;
