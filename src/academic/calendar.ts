/**
 * The Israeli academic calendar (plan W7.8): semesters, exam periods
 * (מועד א׳ / מועד ב׳ / מועד ג׳), breaks and make-up days, per institution
 * and year, from data files in the repo (`data/academic/<institution>/<year>.json`).
 *
 * Dates are facts, so the files carry no copyright question; each one links
 * to the institution's official document, and a file counts only once its
 * `verified` flag says a person checked every field against that document.
 *
 *  - The daily note: "שבוע 6 בסמסטר א׳ · 23 יום למועד א׳".
 *  - Deadlines (W5.15): a deadline that falls in an academic break gets a
 *    suggestion — the first working day after the break.
 *  - Student mode (W5.13): a course's semester gives its exam periods.
 *  - ICS export per institution and year (RFC 5545, all-day events).
 *
 * Pure: no DOM, no network.
 */

import { fixedOf, gregorianOf, type GDay } from "../daily/hebrewCalendar";
import { adjustDeadline, type TimeOptions } from "../daily/israeliTime";

export type SemesterId = "a" | "b" | "summer";
export type Moed = "a" | "b" | "c";

export interface Range {
  /** YYYY-MM-DD, inclusive. */
  start: string;
  end: string;
}

export interface AcademicYear {
  institution: { id: string; he: string; en: string };
  /** Hebrew year, e.g. 5787 (תשפ״ז). */
  year: number;
  label: string;
  source: { url: string; title: string; retrieved: string | null };
  /** True once every field was checked against `source.url`. Unverified files are never shown as fact. */
  verified: boolean;
  semesters: Array<Range & { id: SemesterId }>;
  exams: Array<Range & { semester: SemesterId; moed: Moed }>;
  breaks: Array<Range & { name: string }>;
  makeupDays: string[];
}

const ISO = /^\d{4}-\d\d-\d\d$/;
export const dayOfIso = (s: string): GDay => {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
};
export const isoOf = (g: GDay) => `${g.y}-${String(g.m).padStart(2, "0")}-${String(g.d).padStart(2, "0")}`;
const fx = (s: string) => fixedOf(dayOfIso(s));
const within = (day: number, r: Range) => day >= fx(r.start) && day <= fx(r.end);

/** Problems with a data file (empty when it is well-formed). */
export function validate(c: AcademicYear): string[] {
  const errs: string[] = [];
  if (!c.institution?.id || !/^[a-z0-9-]+$/.test(c.institution.id)) errs.push("institution.id");
  if (!Number.isInteger(c.year) || c.year < 5780 || c.year > 5900) errs.push("year");
  if (!/^https:\/\//.test(c.source?.url ?? "")) errs.push("source.url");
  const ranges: Array<[string, Range]> = [...c.semesters.map((s) => [`semester ${s.id}`, s] as [string, Range]), ...c.exams.map((e) => [`exams ${e.semester}/${e.moed}`, e] as [string, Range]), ...c.breaks.map((b) => [`break ${b.name}`, b] as [string, Range])];
  for (const [name, r] of ranges) {
    if (!ISO.test(r.start) || !ISO.test(r.end)) errs.push(`${name}: dates`);
    else if (fx(r.end) < fx(r.start)) errs.push(`${name}: ends before it starts`);
  }
  for (const d of c.makeupDays) if (!ISO.test(d)) errs.push(`makeup ${d}`);
  if (c.verified && !c.semesters.length) errs.push("verified with no semesters");
  return errs;
}

export interface Position {
  semester: SemesterId;
  /** 1-based teaching week (weeks start on Sunday, the Israeli week). */
  week: number;
}

/** The teaching week of a day, or null outside the semesters. */
export function weekOfSemester(day: GDay, c: AcademicYear): Position | null {
  const f = fixedOf(day);
  const s = c.semesters.find((x) => within(f, x));
  if (!s) return null;
  const start = fx(s.start);
  // The week of the start counts as week 1; a new week begins each Sunday (RD mod 7 = 0 is Sunday).
  const sunday = (n: number) => n - (n % 7);
  return { semester: s.id, week: Math.floor((sunday(f) - sunday(start)) / 7) + 1 };
}

/** The next exam period from a day (one in progress counts, with 0 days). */
export function nextExams(day: GDay, c: AcademicYear, moed?: Moed): { semester: SemesterId; moed: Moed; days: number; range: Range } | null {
  const f = fixedOf(day);
  const next = c.exams
    .filter((e) => (!moed || e.moed === moed) && fx(e.end) >= f)
    .sort((a, b) => fx(a.start) - fx(b.start))[0];
  if (!next) return null;
  return { semester: next.semester, moed: next.moed, days: Math.max(0, fx(next.start) - f), range: next };
}

const SEM_HE: Record<SemesterId, string> = { a: "סמסטר א׳", b: "סמסטר ב׳", summer: "סמסטר קיץ" };
const MOED_HE: Record<Moed, string> = { a: "מועד א׳", b: "מועד ב׳", c: "מועד ג׳" };
const SEM_EN: Record<SemesterId, string> = { a: "semester A", b: "semester B", summer: "the summer semester" };
const MOED_EN: Record<Moed, string> = { a: "Moed A", b: "Moed B", c: "Moed C" };

/** The daily note's line: "שבוע 6 בסמסטר א׳ · 23 יום למועד א׳"; empty for an unverified file or a day with nothing to say. */
export function dailyLine(day: GDay, c: AcademicYear, lang: "he" | "en" = "he"): string {
  if (!c.verified) return "";
  const parts: string[] = [];
  const f = fixedOf(day);
  const brk = c.breaks.find((b) => within(f, b));
  const pos = weekOfSemester(day, c);
  if (brk) parts.push(lang === "he" ? brk.name : `break: ${brk.name}`);
  else if (pos) parts.push(lang === "he" ? `שבוע ${pos.week} ב${SEM_HE[pos.semester]}` : `week ${pos.week} of ${SEM_EN[pos.semester]}`);
  if (c.makeupDays.includes(isoOf(day))) parts.push(lang === "he" ? "יום השלמה" : "make-up day");
  const ex = nextExams(day, c);
  if (ex) {
    if (ex.days === 0) parts.push(lang === "he" ? `תקופת ${MOED_HE[ex.moed]}` : `${MOED_EN[ex.moed]} exams`);
    else if (ex.days <= 60) parts.push(lang === "he" ? `${ex.days} יום ל${MOED_HE[ex.moed]}` : `${ex.days} days to ${MOED_EN[ex.moed]}`);
  }
  return parts.join(" · ");
}

export interface BreakDeadline {
  name: string;
  /** The first working day after the break (Shabbat and chagim skipped, W5.15). */
  suggestion: GDay;
}

/** A deadline inside an academic break: the break and the day to move it to; null otherwise. */
export function deadlineInBreak(day: GDay, c: AcademicYear, opts: TimeOptions): BreakDeadline | null {
  if (!c.verified) return null;
  const f = fixedOf(day);
  const brk = c.breaks.find((b) => within(f, b));
  if (!brk) return null;
  const after = gregorianOf(fx(brk.end) + 1);
  return { name: brk.name, suggestion: adjustDeadline(after, { ...opts, move: "next" }).due };
}

/** Student mode (W5.13): the exam periods of a course's semester. */
export function examsForSemester(semester: SemesterId, c: AcademicYear): Array<Range & { moed: Moed }> {
  return c.exams.filter((e) => e.semester === semester).map(({ start, end, moed }) => ({ start, end, moed }));
}

// ── ICS ────────────────────────────────────────────────────────────────

const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
const compact = (iso: string) => iso.replace(/-/g, "");

/** Lines longer than 75 octets folded (RFC 5545 §3.1), CRLF line ends. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = "";
  let limit = 75;
  for (const ch of line) {
    if (enc.encode(cur + ch).length > limit) {
      out.push(cur);
      cur = ch;
      limit = 74; // the leading space of a continuation line counts
    } else cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/** The year as an iCalendar file: one all-day event per semester, exam period, break and make-up day. */
export function toIcs(c: AcademicYear, stamp: Date): string {
  const dtstamp = stamp.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Lumen//Academic calendar//HE", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${icsText(`${c.institution.he} ${c.label}`)}`];
  const event = (uid: string, summary: string, r: Range) => {
    const endExclusive = isoOf(gregorianOf(fx(r.end) + 1));
    lines.push("BEGIN:VEVENT", `UID:${uid}@academic.lumen`, `DTSTAMP:${dtstamp}`, `DTSTART;VALUE=DATE:${compact(r.start)}`, `DTEND;VALUE=DATE:${compact(endExclusive)}`, `SUMMARY:${icsText(summary)}`, `URL:${c.source.url}`, "TRANSP:TRANSPARENT", "END:VEVENT");
  };
  const id = `${c.institution.id}-${c.year}`;
  for (const s of c.semesters) event(`${id}-sem-${s.id}`, SEM_HE[s.id], s);
  for (const e of c.exams) event(`${id}-exam-${e.semester}-${e.moed}`, `${MOED_HE[e.moed]} · ${SEM_HE[e.semester]}`, e);
  c.breaks.forEach((b, i) => event(`${id}-break-${i}`, b.name, b));
  for (const d of c.makeupDays) event(`${id}-makeup-${compact(d)}`, "יום השלמה", { start: d, end: d });
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
