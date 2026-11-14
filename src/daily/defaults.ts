/** Daily-note settings and their defaults (plan 4.12) — tiny, so the store can hold them without loading the daily-note code. */
export interface DailySettings {
  /** Folder in the vault ("" = the root). */
  folder: string;
  /** File name pattern: YYYY, MM, DD (".md" is added when missing). */
  pattern: string;
  /** New-note template: {{date}}, {{hebrewDate}}, {{weekday}}, {{title}}. */
  template: string;
}

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
