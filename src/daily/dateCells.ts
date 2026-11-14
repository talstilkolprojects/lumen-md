/**
 * Dates in properties and database views (plan W5.15): the Hebrew date
 * next to the Gregorian one, and for a deadline the working day it moves to
 * when it falls on Shabbat or a chag, with the reason, and the working days
 * left. Loaded with the views that show them (never at startup).
 */
import { hebrewDate } from "./dailyNote";
import { adjustDeadline, dayOfValue, defaultWorkWeek, isoOfDay, noteLabel, offLabels, workingDaysUntil, type DeadlineMove, type WorkWeek } from "./israeliTime";
import { defaultIsrael, type GDay } from "./hebrewCalendar";
import { nameLang } from "./hebrewCalendarNames";
import { showHebrewDates, type DailySettings } from "./defaults";

export interface DateCellOptions {
  locale: string;
  settings: Pick<DailySettings, "israel" | "workWeek" | "hebrewDates" | "deadlineMove">;
  /** Treat the value as a deadline: suggest a working day, count the working days left. */
  deadline?: boolean;
  /** Override the Hebrew-date setting (a database block's `hebrewDate:`). */
  hebrewDates?: boolean;
  today?: GDay;
}

export interface DateCell {
  iso: string;
  /** The Hebrew date in the UI's script: "ז׳ בתשרי תשפ״ז" or "7 Tishri 5787"; null when off. */
  hebrew: string | null;
  deadline?: {
    /** The working day it moves to; equal to `iso` when it doesn't move. */
    due: string;
    moved: boolean;
    /** Why the written date is a day off ("Shabbat", "Rosh Hashana I"). */
    off: string[];
    /** Notes on the due day ("Erev Pesach", "Chol HaMoed"). */
    notes: string[];
    /** Working days from today to the due day; negative when past. */
    left: number;
  };
}

const EN_HEBREW = new Intl.DateTimeFormat("en-u-ca-hebrew", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** The Hebrew date: in Hebrew letters for a Hebrew UI, transliterated otherwise. */
export function hebrewDateOf(day: GDay, locale: string): string {
  return locale === "he" ? hebrewDate(day) : EN_HEBREW.format(new Date(Date.UTC(day.y, day.m - 1, day.d, 12)));
}

const todayOf = (): GDay => {
  const n = new Date();
  return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate() };
};

/** The cell for a frontmatter value, or null when it is not a date. */
export function dateCell(value: unknown, opts: DateCellOptions): DateCell | null {
  const day = dayOfValue(value);
  if (!day) return null;
  const israel = opts.settings.israel ?? defaultIsrael(opts.locale);
  const workWeek: WorkWeek = opts.settings.workWeek ?? defaultWorkWeek(israel);
  const showHebrew = opts.hebrewDates ?? showHebrewDates(opts.settings, opts.locale);
  const cell: DateCell = { iso: isoOfDay(day), hebrew: showHebrew ? hebrewDateOf(day, opts.locale) : null };
  if (opts.deadline) {
    const move: DeadlineMove = opts.settings.deadlineMove ?? "next";
    const a = adjustDeadline(day, { israel, workWeek, move });
    const lang = nameLang(opts.locale);
    cell.deadline = {
      due: isoOfDay(a.due),
      moved: a.moved,
      off: offLabels(a.off, lang),
      notes: a.notes.map((n) => noteLabel(n, lang)),
      left: workingDaysUntil(opts.today ?? todayOf(), a.due, { israel, workWeek }),
    };
  }
  return cell;
}

/** Frontmatter keys read as deadlines in properties: due, deadline and their Hebrew names. */
export const DEADLINE_KEY = /^(due|deadline|due[-_ ]?date|יעד|תאריך[-_ ]יעד|דדליין|מועד[-_ ]אחרון)$/i;
