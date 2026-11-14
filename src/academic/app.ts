/** The academic calendar for the app (plan W7.8): the chosen institution's line for a day, and its ICS file. */
import "./strings";
import { dailyLine, toIcs, type AcademicYear } from "./calendar";
import { CALENDARS, choose, chosen } from "./registry";

export { CALENDARS, choose, chosen };

export function dailyLineFor(day: { y: number; m: number; d: number }, locale: string): string {
  const c = chosen();
  return c ? dailyLine(day, c, locale.startsWith("he") ? "he" : "en") : "";
}

/** Download the year as an .ics file (a Blob link; nothing is sent anywhere). */
export function downloadIcs(c: AcademicYear): void {
  const blob = new Blob([toIcs(c, new Date())], { type: "text/calendar;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${c.institution.id}-${c.year}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
