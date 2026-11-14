/** Daily-note settings and their defaults (plan 4.12) — tiny, so the store can hold them without loading the daily-note code. */
export interface DailySettings {
  /** Folder in the vault ("" = the root). */
  folder: string;
  /** File name pattern: YYYY, MM, DD (".md" is added when missing). */
  pattern: string;
  /** New-note template: {{date}}, {{hebrewDate}}, {{weekday}}, {{title}}, {{holiday}}, {{parasha}}, {{academic}} (plan W7.8). */
  template: string;
  /** Holidays and Torah portions as in Israel (true) or the diaspora (false); unset: from the UI language / time zone. */
  israel?: boolean;
  /** "Your morning" block in today's note (plan W5.19): changes, tasks, reviews, the Hebrew date. Off by default. */
  morning?: boolean;
  /** Working days (plan W5.15): Sunday–Thursday or Monday–Friday; unset: Sunday–Thursday for Israel. */
  workWeek?: "sun-thu" | "mon-fri";
  /** Show the Hebrew date next to dates in properties and database views; unset: on for a Hebrew UI. */
  hebrewDates?: boolean;
  /** A deadline on Shabbat or a chag: suggest the next working day, the previous one, or don't move it. Unset: next. */
  deadlineMove?: "next" | "previous" | "off";
}

/** The Hebrew-date setting, with its default. */
export const showHebrewDates = (s: Pick<DailySettings, "hebrewDates">, locale: string): boolean => s.hebrewDates ?? locale === "he";

export const DEFAULT_DAILY: DailySettings = {
  folder: "journal",
  pattern: "YYYY-MM-DD",
  template: "# {{title}}\n\n{{weekday}} · {{hebrewDate}}\n\n",
};

/**
 * A pattern must name the year, the month and the day: without one of them
 * different days would share a file (`YYYY-MM` → one note per month).
 */
export const isValidDailyPattern = (pattern: string): boolean => ["YYYY", "MM", "DD"].every((tok) => pattern.includes(tok));
