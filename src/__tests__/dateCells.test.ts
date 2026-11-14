/** Plan W5.15: the Hebrew date in properties and database views, and the deadline note. */
import { describe, it, expect } from "vitest";
import { DEADLINE_KEY, dateCell, hebrewDateOf } from "../daily/dateCells";
import { showHebrewDates } from "../daily/defaults";

const today = { y: 2026, m: 9, d: 10 }; // Thursday, 28 Elul 5786

describe("date cells", () => {
  it("the Hebrew date: in Hebrew letters for a Hebrew UI, transliterated otherwise", () => {
    expect(hebrewDateOf({ y: 2026, m: 9, d: 12 }, "he")).toBe("א׳ בתשרי תשפ״ז");
    expect(hebrewDateOf({ y: 2026, m: 9, d: 12 }, "en")).toBe("1 Tishri 5787");
  });

  it("Hebrew dates default to on for a Hebrew UI, off otherwise; the setting wins", () => {
    expect(showHebrewDates({}, "he")).toBe(true);
    expect(showHebrewDates({}, "en")).toBe(false);
    expect(showHebrewDates({ hebrewDates: true }, "en")).toBe(true);
    expect(showHebrewDates({ hebrewDates: false }, "he")).toBe(false);
  });

  it("a non-date is not a date cell", () => {
    expect(dateCell("next week", { locale: "he", settings: {} })).toBeNull();
    expect(dateCell(42, { locale: "he", settings: {} })).toBeNull();
  });

  it("a deadline on Rosh Hashana (Shabbat) gets Monday, the reason, and the working days left", () => {
    const c = dateCell("2026-09-12", { locale: "he", settings: {}, deadline: true, today });
    expect(c).toMatchObject({ iso: "2026-09-12", hebrew: "א׳ בתשרי תשפ״ז" });
    expect(c!.deadline).toEqual({ due: "2026-09-14", moved: true, off: ["שבת", "ראש השנה א׳"], notes: ["צום גדליה"], left: 1 });
  });

  it("the person's settings apply: the previous working day, a Monday–Friday week, the diaspora", () => {
    const prev = dateCell("2026-09-13", { locale: "en", settings: { deadlineMove: "previous" }, deadline: true, today });
    expect(prev!.deadline).toMatchObject({ due: "2026-09-10", moved: true, left: 0 });
    // Diaspora, Mon–Fri: Friday 11 Sep 2026 is a working day.
    const fri = dateCell("2026-09-11", { locale: "en", settings: { israel: false, workWeek: "mon-fri" }, deadline: true, today });
    expect(fri!.deadline).toMatchObject({ due: "2026-09-11", moved: false, off: [], notes: ["Erev Rosh Hashana"] });
    expect(fri!.hebrew).toBeNull();
  });

  it("deadline keys in properties: due, deadline and their Hebrew names", () => {
    for (const k of ["due", "Deadline", "due_date", "יעד", "תאריך יעד", "דדליין", "מועד אחרון"]) expect(DEADLINE_KEY.test(k), k).toBe(true);
    for (const k of ["date", "created", "updated"]) expect(DEADLINE_KEY.test(k), k).toBe(false);
  });
});
