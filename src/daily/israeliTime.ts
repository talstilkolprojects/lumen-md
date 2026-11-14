/**
 * Israeli time (plan W5.15): which days are working days, a deadline that
 * falls on Shabbat or a chag moved with a note saying why, and the working
 * days left until a deadline, for the database views. Built on our own
 * Hebrew calendar (./hebrewCalendar, plan W2.10). Pure: no DOM, no Intl
 * beyond what the names module uses.
 *
 * Rules (sources in docs/…/workspace/israeli-time.md):
 *  - Work week: Sunday–Thursday (Israel) or Monday–Friday. In Israel
 *    Friday and Saturday are the weekend; elsewhere Saturday and Sunday.
 *  - Days off: Shabbat, every yom tov (Rosh Hashana ×2, Yom Kippur, the first
 *    and last days of Sukkot and Pesach, Shavuot; two days each in the
 *    diaspora) — the Jewish rest days of the Hours of Work and Rest Law 1951
 *    §18A — and, in Israel, Yom HaAtzmaut, a statutory holiday
 *    (Independence Day Law 1949).
 *  - Working days that get a note: erev chag (a short day for many), Chol
 *    HaMoed (many offices close), fasts, Yom HaZikaron and Yom HaShoah.
 *  - A deadline on a day off moves to the next working day, the way Israeli
 *    law counts periods (Interpretation Law 1981 §10: days of rest count,
 *    unless they are the last days of the period, and then it ends on the
 *    next day) — or, if asked, to the previous one. Nothing is rewritten:
 *    the moved date is a suggestion shown next to the original.
 */
import { fixedOf, gregorianOf, holidaysOn, weekdayOf, SHABBAT, type GDay, type Holiday } from "./hebrewCalendar";
import { holidayLabel, type NameLang } from "./hebrewCalendarNames";

export type WorkWeek = "sun-thu" | "mon-fri";
export type DeadlineMove = "next" | "previous" | "off";

export interface TimeOptions {
  /** Holidays as in Israel (one day of yom tov) or the diaspora. */
  israel: boolean;
  workWeek: WorkWeek;
}

/** Why a day is off. */
export type OffReason = { kind: "weekend"; weekday: number } | { kind: "holiday"; holiday: Holiday };

/** A working day's note: erev chag, Chol HaMoed, a fast, a memorial day. */
export type DayNote = { kind: "erev" | "cholHamoed" | "fast" | "memorial"; holiday: Holiday };

export interface DayStatus {
  working: boolean;
  off: OffReason[];
  notes: DayNote[];
}

const FRIDAY = 5;
const SUNDAY = 0;
/** Erev of a day off: the eve of a yom tov, not of a fast (erev Tisha b'Av is an ordinary day). */
const EREV_CHAG = new Set(["erev-rosh-hashana", "erev-yom-kippur", "erev-sukkot", "erev-pesach", "erev-shavuot"]);
const MEMORIAL = new Set(["yom-hazikaron", "yom-hashoah"]);

/** The work week when the person hasn't chosen: Sunday–Thursday for Israel, Monday–Friday elsewhere. */
export const defaultWorkWeek = (israel: boolean): WorkWeek => (israel ? "sun-thu" : "mon-fri");

/** Is this weekday (0 = Sunday … 6 = Shabbat) a weekend day in the work week? */
export function isWeekend(weekday: number, week: WorkWeek): boolean {
  return week === "sun-thu" ? weekday === FRIDAY || weekday === SHABBAT : weekday === SHABBAT || weekday === SUNDAY;
}

/** Is this holiday a day off? */
export function isRestHoliday(h: Holiday, israel: boolean): boolean {
  return h.yomTov === true || (israel && h.id === "yom-haatzmaut");
}

/** Working or not, and why. */
export function dayStatus(day: GDay, opts: TimeOptions): DayStatus {
  const fixed = fixedOf(day);
  const weekday = weekdayOf(fixed);
  const holidays = holidaysOn(day, { israel: opts.israel });
  const off: OffReason[] = [];
  if (isWeekend(weekday, opts.workWeek)) off.push({ kind: "weekend", weekday });
  for (const h of holidays) if (isRestHoliday(h, opts.israel)) off.push({ kind: "holiday", holiday: h });
  const notes: DayNote[] = [];
  for (const h of holidays) {
    if (isRestHoliday(h, opts.israel)) continue;
    // Hoshana Raba is Chol HaMoed and the eve of Shemini Atzeret.
    if (h.cholHamoed) notes.push({ kind: "cholHamoed", holiday: h });
    else if (EREV_CHAG.has(h.id)) notes.push({ kind: "erev", holiday: h });
    else if (h.kind === "fast") notes.push({ kind: "fast", holiday: h });
    else if (MEMORIAL.has(h.id)) notes.push({ kind: "memorial", holiday: h });
  }
  return { working: off.length === 0, off, notes };
}

export interface DeadlineAdjustment {
  /** The date as written. */
  original: GDay;
  /** The working day it moves to (the original when it is a working day, or moving is off). */
  due: GDay;
  moved: boolean;
  /** Why the original is a day off (empty when it is a working day). */
  off: OffReason[];
  /** Notes about the day it lands on (erev chag, Chol HaMoed…). */
  notes: DayNote[];
}

/** Longest run of days off: Rosh Hashana on Thursday–Friday then Shabbat (3), or the diaspora's 2-day yom tov next to a weekend (4). */
const MAX_SEARCH = 14;

/** A deadline moved off a day off, the way the person chose (next working day by default). */
export function adjustDeadline(day: GDay, opts: TimeOptions & { move?: DeadlineMove }): DeadlineAdjustment {
  const move = opts.move ?? "next";
  const status = dayStatus(day, opts);
  if (status.working || move === "off") return { original: day, due: day, moved: false, off: status.off, notes: status.notes };
  const step = move === "previous" ? -1 : 1;
  let fixed = fixedOf(day);
  for (let i = 0; i < MAX_SEARCH; i++) {
    fixed += step;
    const d = gregorianOf(fixed);
    const s = dayStatus(d, opts);
    if (s.working) return { original: day, due: d, moved: true, off: status.off, notes: s.notes };
  }
  return { original: day, due: day, moved: false, off: status.off, notes: status.notes };
}

/**
 * Working days from `from` to `to`: the working days after `from`, up to and
 * including `to` — 0 for today, 1 when the deadline is the next working day.
 * Negative when the deadline is past (the working days since it, counted the
 * same way).
 */
export function workingDaysUntil(from: GDay, to: GDay, opts: TimeOptions): number {
  const a = fixedOf(from);
  const b = fixedOf(to);
  if (a === b) return 0;
  const [lo, hi, sign] = a < b ? [a, b, 1] : [b, a, -1];
  let n = 0;
  for (let f = lo + 1; f <= hi; f++) if (dayStatus(gregorianOf(f), opts).working) n++;
  return sign * n;
}

/** A day from a frontmatter value: "2026-09-12", "2026-09-12T10:00", a YAML date, or null. */
export function dayOfValue(v: unknown): GDay | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate() };
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(v.trim());
  if (!m) return null;
  const day = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  const check = gregorianOf(fixedOf(day));
  return check.y === day.y && check.m === day.m && check.d === day.d ? day : null;
}

const WEEKDAY: Record<NameLang, string[]> = {
  he: ["יום ראשון", "יום שני", "יום שלישי", "יום רביעי", "יום חמישי", "יום שישי", "שבת"],
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Shabbat"],
};

/** Why a day is off, in words: "Shabbat", "Friday", "Rosh Hashana I". */
export function offLabel(r: OffReason, lang: NameLang): string {
  return r.kind === "weekend" ? WEEKDAY[lang][r.weekday] : holidayLabel(r.holiday, lang);
}

/** The labels of every reason, without repeating Shabbat when a chag is also on Shabbat. */
export function offLabels(off: readonly OffReason[], lang: NameLang): string[] {
  return [...new Set(off.map((r) => offLabel(r, lang)))];
}

/** A day's note in words: "Erev Pesach", "Chol HaMoed", the fast's name. */
export function noteLabel(n: DayNote, lang: NameLang): string {
  return holidayLabel(n.holiday, lang);
}

export const isoOfDay = (d: GDay): string => `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
