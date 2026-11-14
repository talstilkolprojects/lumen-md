/**
 * Notion's dates as its export writes them, in the language the exporting
 * account uses (plan W11.P1). Ported from obsidian-importer 3.1.15
 * (src/formats/notion/date-values.ts, MIT, © 2023 Obsidian; see
 * THIRD_PARTY_NOTICES.md), without Moment: month names in 15 languages
 * from Intl, day-first or month-first numeric dates, "de" in Spanish and
 * Portuguese, year-first CJK forms, a time with AM/PM, a time-zone suffix
 * dropped (the wall-clock time is what is imported), and a range written as
 * "start → end" read as its start.
 *
 * Added here: Hebrew (he-IL), which the importer does not list. The forms
 * are those Intl's he-IL writes ("23 בספטמבר 2026", "23 בספט׳ 2026",
 * "… בשעה 10:05"), since no Hebrew Notion export was at hand (W10.O9).
 */

export type DateOrder = "day-first" | "month-first";

const LANGUAGES = ["en-US", "en-GB", "fr", "de", "es", "pt-BR", "it", "nl", "da", "sv", "nb", "fi", "pl", "ru", "tr", "he-IL"];

/** month name (lower case, no dots) → month 1–12 and the numeric orders of the languages that use it. */
const MONTHS = new Map<string, { month: number; orders: Set<DateOrder> }>();

function localeOrder(locale: string): DateOrder | undefined {
  try {
    if (!Intl.DateTimeFormat.supportedLocalesOf(locale).length) return undefined;
    const parts = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).formatToParts(new Date(2026, 8, 23));
    return parts.find((p) => p.type === "day" || p.type === "month")?.type === "day" ? "day-first" : "month-first";
  } catch {
    return undefined; // why: an engine without this locale's data; its month names are simply not known
  }
}

const monthKey = (s: string) => s.toLocaleLowerCase().replace(/[.׳']/g, "").trim();

function add(name: string, month: number, order: DateOrder) {
  const key = monthKey(name);
  if (!key) return;
  const e = MONTHS.get(key) ?? { month, orders: new Set<DateOrder>() };
  e.orders.add(order);
  MONTHS.set(key, e);
}

for (const locale of LANGUAGES) {
  const order = localeOrder(locale);
  if (!order) continue;
  for (const month of ["long", "short"] as const) {
    for (const day of [undefined, "numeric"] as const) {
      let f: Intl.DateTimeFormat;
      try {
        f = new Intl.DateTimeFormat(locale, { month, day });
      } catch {
        continue; // why: see localeOrder
      }
      for (let i = 0; i < 12; i++) {
        const name = f.formatToParts(new Date(2026, i, 15)).find((p) => p.type === "month")?.value;
        if (name) add(name, i + 1, order);
      }
    }
  }
}
// Notion also writes the four-letter English abbreviation.
MONTHS.set("sept", { month: 9, orders: new Set(["day-first", "month-first"]) });

/** A month name, also with Hebrew's "in" prefix (בספטמבר → ספטמבר). */
function monthOf(token: string) {
  const k = monthKey(token);
  return MONTHS.get(k) ?? (k.startsWith("ב") ? MONTHS.get(k.slice(1)) : undefined);
}

// "(PDT)", "(GMT+2)", "(UTC-05:30)".
const ZONE = /\s*\((?:(?:GMT|UTC)(?:[+-]\d{1,2}(?::\d{2})?)?|[A-Z]{2,5})\)$/;

function normalize(s: string): string {
  return s
    .replace(/^\s*@\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(ZONE, "")
    .split(/\s*→\s*/)[0]
    .trim();
}

function splitTime(s: string): { date: string; h: number; m: number; sec: number } | null {
  const t = /(?:[ T]+|,? ?בשעה |,? ?à |,? ?um |,? ?alle |,? ?a las |,? ?às |,? ?om |,? ?klo |,? ?kl\.? |,? ?o |,? ?в )(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?\s?m\.?)?$/i.exec(s);
  if (!t) return { date: s.replace(/,/g, "").trim(), h: -1, m: 0, sec: 0 };
  let h = Number(t[1]);
  const m = Number(t[2]);
  const sec = Number(t[3] ?? 0);
  if (t[4]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (t[4].toLowerCase() === "p" ? 12 : 0);
  }
  if (h > 23 || m > 59 || sec > 59) return null;
  return { date: s.slice(0, t.index).replace(/,/g, "").trim(), h, m, sec };
}

const pad = (n: number) => String(n).padStart(2, "0");
function valid(y: number, mo: number, d: number): boolean {
  if (!(y >= 1000 && y <= 9999 && mo >= 1 && mo <= 12 && d >= 1)) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** The numeric order a column's cells settle on: one cell with a first part over 12 is day-first, and so on. */
export function inferOrder(cells: readonly string[]): DateOrder | undefined {
  const seen = new Set<DateOrder>();
  for (const c of cells) {
    const n = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/.exec(splitTime(normalize(c))?.date ?? "");
    if (!n) continue;
    const a = Number(n[1]);
    const b = Number(n[3]);
    if (a > 12 && b <= 12) seen.add("day-first");
    if (b > 12 && a <= 12) seen.add("month-first");
  }
  return seen.size === 1 ? [...seen][0] : undefined;
}

/**
 * A Notion date cell → `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` (seconds when
 * written), or null when it is not a date. `order` settles `03/04/2026`;
 * without it, only an unambiguous numeric date is read.
 */
export function parseNotionDate(cell: string, opts: { order?: DateOrder; year?: number } = {}): string | null {
  const v = normalize(cell);
  if (!v) return null;
  // ISO first: the export's machine-readable form.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (iso) {
    const [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (!valid(y, mo, d)) return null;
    return iso[4] ? `${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}${iso[6] ? `:${iso[6]}` : ""}` : `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const split = splitTime(v);
  if (!split) return null;
  const date = split.date.replace(/ de /g, " ").replace(/\s+/g, " ").trim();
  let y: number | undefined;
  let mo: number | undefined;
  let d: number | undefined;
  const dayFirst = /^(\d{1,2})\.? (\S+?)\.?(?: (\d{4}))?(?: г)?$/.exec(date);
  const monthFirst = /^(\S+?)\.? (\d{1,2})(?: (\d{4}))?$/.exec(date);
  const named = (dayFirst && monthOf(dayFirst[2]) && { day: dayFirst[1], month: monthOf(dayFirst[2])!, year: dayFirst[3] }) || (monthFirst && monthOf(monthFirst[1]) && { day: monthFirst[2], month: monthOf(monthFirst[1])!, year: monthFirst[3] });
  if (named) {
    d = Number(named.day);
    mo = named.month.month;
    y = named.year ? Number(named.year) : opts.year;
  } else {
    const ymd = /^(\d{4})[/.\-年년] ?(\d{1,2})[/.\-月월] ?(\d{1,2})[日일]?$/.exec(date);
    if (ymd) [y, mo, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
    else {
      const n = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/.exec(date);
      if (!n) return null;
      const a = Number(n[1]);
      const b = Number(n[3]);
      let order = opts.order;
      if (!order) {
        if (a > 12 && b <= 12) order = "day-first";
        else if (b > 12 && a <= 12) order = "month-first";
        else if (a !== b) return null; // why: 03/04/2026 without a column to settle it is not guessed
        else order = "day-first";
      }
      [d, mo] = order === "day-first" ? [a, b] : [b, a];
      y = Number(n[4]);
    }
  }
  if (y === undefined || !valid(y, mo!, d!)) return null;
  const day = `${y}-${pad(mo!)}-${pad(d!)}`;
  if (split.h < 0) return day;
  return `${day}T${pad(split.h)}:${pad(split.m)}${split.sec ? `:${pad(split.sec)}` : ""}`;
}
