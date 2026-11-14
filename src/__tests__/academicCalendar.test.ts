/**
 * Plan W7.8: the Israeli academic calendar. Uses a synthetic calendar
 * (fixtures/academic/example-5787.json, marked as such) for the engine; the
 * real institutions' files in data/academic are checked for shape and links.
 * Matching Haifa תשפ״ז against its official document is the owner's step
 * (scripts/academic/check-calendar.mjs with a golden table).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dailyLine, deadlineInBreak, examsForSemester, foldLine, nextExams, toIcs, validate, weekOfSemester, type AcademicYear } from "../academic/calendar";
import { CALENDARS, choose, chosen } from "../academic/registry";
import { renderTemplate } from "../daily/dailyNote";

const EX: AcademicYear = JSON.parse(readFileSync(join(__dirname, "fixtures", "academic", "example-5787.json"), "utf8"));
const day = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
};

describe("the engine", () => {
  it("validates a file", () => {
    expect(validate(EX)).toEqual([]);
    expect(validate({ ...EX, semesters: [{ id: "a", start: "2027-01-21", end: "2026-10-18" }] })).toEqual(["semester a: ends before it starts"]);
    expect(validate({ ...EX, source: { ...EX.source, url: "file:///x" } })).toContain("source.url");
  });

  it("counts teaching weeks from Sunday to Sunday", () => {
    expect(weekOfSemester(day("2026-10-18"), EX)).toEqual({ semester: "a", week: 1 }); // a Sunday
    expect(weekOfSemester(day("2026-10-24"), EX)).toEqual({ semester: "a", week: 1 }); // Saturday
    expect(weekOfSemester(day("2026-10-25"), EX)).toEqual({ semester: "a", week: 2 });
    expect(weekOfSemester(day("2026-11-26"), EX)).toEqual({ semester: "a", week: 6 });
    expect(weekOfSemester(day("2027-02-01"), EX)).toBe(null);
  });

  it("writes the daily note's line", () => {
    expect(dailyLine(day("2026-11-26"), EX)).toBe("שבוע 6 בסמסטר א׳ · 59 יום למועד א׳");
    expect(dailyLine(day("2027-01-01"), EX)).toBe("שבוע 11 בסמסטר א׳ · 23 יום למועד א׳");
    expect(dailyLine(day("2027-01-15"), EX)).toBe("שבוע 13 בסמסטר א׳ · יום השלמה · 9 יום למועד א׳");
    expect(dailyLine(day("2027-02-01"), EX)).toBe("תקופת מועד א׳");
    expect(dailyLine(day("2026-12-06"), EX)).toBe("חופשת חנוכה · 49 יום למועד א׳");
    expect(dailyLine(day("2027-01-01"), EX, "en")).toBe("week 11 of semester A · 23 days to Moed A");
    expect(dailyLine(day("2027-01-01"), { ...EX, verified: false })).toBe("");
  });

  it("the daily note template takes {{academic}}", () => {
    expect(renderTemplate("# {{date}}\n{{academic}}", day("2027-01-01"), "he", { israel: true, academic: dailyLine(day("2027-01-01"), EX) })).toBe("# 2027-01-01\nשבוע 11 בסמסטר א׳ · 23 יום למועד א׳");
    expect(renderTemplate("{{academic}}", day("2027-01-01"), "he")).toBe("");
  });

  it("next exam periods, and a course's exams (student mode)", () => {
    expect(nextExams(day("2027-01-01"), EX)).toMatchObject({ semester: "a", moed: "a", days: 23 });
    expect(nextExams(day("2027-01-01"), EX, "b")).toMatchObject({ semester: "a", moed: "b", days: 44 });
    expect(examsForSemester("a", EX).map((e) => e.moed)).toEqual(["a", "b"]);
  });

  it("a deadline in an academic break gets the first working day after it", () => {
    const opts = { israel: true, workWeek: "sun-thu" as const };
    // Pesach break ends Friday 2027-04-30; Saturday is Shabbat; Sunday 2027-05-02 is a working day.
    expect(deadlineInBreak(day("2027-04-25"), EX, opts)).toEqual({ name: "חופשת פסח", suggestion: { y: 2027, m: 5, d: 2 } });
    expect(deadlineInBreak(day("2027-05-05"), EX, opts)).toBe(null);
  });
});

describe("ICS", () => {
  const ics = toIcs(EX, new Date(Date.UTC(2026, 10, 14, 12)));
  const lines = ics.split("\r\n");

  it("is a well-formed iCalendar file (RFC 5545): CRLF, folded lines, all-day events with an exclusive end", () => {
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("VERSION:2.0");
    expect(lines.filter((l) => l === "BEGIN:VEVENT").length).toBe(2 + 3 + 2 + 1);
    expect(lines.filter((l) => l === "END:VEVENT").length).toBe(8);
    const enc = new TextEncoder();
    expect(lines.filter((l) => enc.encode(l).length > 75)).toEqual([]);
    expect(lines).toContain("DTSTART;VALUE=DATE:20261018");
    expect(lines).toContain("DTEND;VALUE=DATE:20270122"); // the day after 2027-01-21
    expect(lines).toContain("DTSTAMP:20261114T120000Z");
    expect(new Set(lines.filter((l) => l.startsWith("UID:"))).size).toBe(8);
  });

  it("folds long lines without splitting a character", () => {
    const long = `SUMMARY:${"מועד א׳ ".repeat(20)}`;
    const folded = foldLine(long);
    expect(folded.split("\r\n ").join("")).toBe(long);
    for (const part of folded.split("\r\n")) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
  });
});

describe("the data files", () => {
  it("every institution file is well-formed and links its official document; none is shown before it is verified", () => {
    expect(CALENDARS.length).toBeGreaterThanOrEqual(4);
    for (const c of CALENDARS) {
      expect(validate(c), c.institution.id).toEqual([]);
      expect(c.source.url).toMatch(/^https:\/\//);
      if (!c.verified) expect(dailyLine(day("2026-11-26"), c)).toBe("");
    }
  });

  it("remembers the chosen institution", () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    choose(CALENDARS[0], s);
    expect(chosen(s)?.institution.id).toBe(CALENDARS[0].institution.id);
    choose(null, s);
    expect(chosen(s)).toBe(null);
  });
});
