/**
 * Plan W5.15 acceptance: 30 golden scenarios, 2026–2028, erev chag and Chol
 * HaMoed included. Each expected date was checked against the Hebrew date
 * Intl gives for it (ICU's Hebrew calendar, independent of our own code —
 * the last test does it again for every rest day used here).
 */
import { describe, it, expect } from "vitest";
import { adjustDeadline, dayOfValue, dayStatus, defaultWorkWeek, isWeekend, noteLabel, offLabels, workingDaysUntil, type DeadlineMove, type TimeOptions, type WorkWeek } from "../daily/israeliTime";
import type { GDay } from "../daily/hebrewCalendar";

const d = (iso: string): GDay => {
  const [y, m, day] = iso.split("-").map(Number);
  return { y, m, d: day };
};
const iso = (g: GDay) => `${g.y}-${String(g.m).padStart(2, "0")}-${String(g.d).padStart(2, "0")}`;
const IL: TimeOptions = { israel: true, workWeek: "sun-thu" };

interface Golden {
  name: string;
  date: string;
  move?: DeadlineMove;
  israel?: boolean;
  week?: WorkWeek;
  due: string;
  /** Why the date is off, in English (empty: a working day). */
  off: string[];
  /** Notes on the day it lands on. */
  notes?: string[];
}

const GOLDEN: Golden[] = [
  // 2026 — 5786/5787
  { name: "Erev Rosh Hashana 5787 is a Friday: off in a Sun–Thu week", date: "2026-09-11", due: "2026-09-14", off: ["Friday"], notes: ["Tzom Gedaliah"] },
  { name: "Rosh Hashana I on Shabbat → Monday, the fast of Gedaliah (noted)", date: "2026-09-12", due: "2026-09-14", off: ["Shabbat", "Rosh Hashana I"], notes: ["Tzom Gedaliah"] },
  { name: "Rosh Hashana II on Sunday → Monday", date: "2026-09-13", due: "2026-09-14", off: ["Rosh Hashana II"], notes: ["Tzom Gedaliah"] },
  { name: "Rosh Hashana II, previous working day → Thursday", date: "2026-09-13", move: "previous", due: "2026-09-10", off: ["Rosh Hashana II"] },
  { name: "Erev Yom Kippur is a working day, with a note", date: "2026-09-20", due: "2026-09-20", off: [], notes: ["Erev Yom Kippur"] },
  { name: "Yom Kippur (Monday) → Tuesday", date: "2026-09-21", due: "2026-09-22", off: ["Yom Kippur"] },
  { name: "Sukkot I on Shabbat → Sunday, Chol HaMoed (noted)", date: "2026-09-26", due: "2026-09-27", off: ["Shabbat", "Sukkot I"], notes: ["Sukkot: Chol HaMoed 1"] },
  { name: "Chol HaMoed Sukkot is a working day, with a note", date: "2026-09-28", due: "2026-09-28", off: [], notes: ["Sukkot: Chol HaMoed 2"] },
  { name: "Shemini Atzeret on Shabbat → Sunday", date: "2026-10-03", due: "2026-10-04", off: ["Shabbat", "Shemini Atzeret and Simchat Torah"] },
  { name: "Erev Pesach 5786 (Wednesday): working, erev and Ta'anit Bechorot noted", date: "2026-04-01", due: "2026-04-01", off: [], notes: ["Ta'anit Bechorot", "Erev Pesach"] },
  { name: "Pesach I (Thursday) → Sunday, over Friday and Shabbat, into Chol HaMoed", date: "2026-04-02", due: "2026-04-05", off: ["Pesach I"], notes: ["Pesach: Chol HaMoed 3"] },
  { name: "Pesach VII (Wednesday) → Thursday", date: "2026-04-08", due: "2026-04-09", off: ["Pesach VII"] },
  { name: "Yom HaZikaron is a working day, with a note", date: "2026-04-21", due: "2026-04-21", off: [], notes: ["Yom HaZikaron"] },
  { name: "Yom HaAtzmaut 5786 (Wednesday) → Thursday", date: "2026-04-22", due: "2026-04-23", off: ["Yom HaAtzmaut"] },
  { name: "Shavuot on Friday → Sunday", date: "2026-05-22", due: "2026-05-24", off: ["Friday", "Shavuot I"] },
  { name: "Tisha B'Av is a working day, with a note", date: "2026-07-23", due: "2026-07-23", off: [], notes: ["Tish'a B'Av"] },
  // 2027 — 5787/5788
  { name: "Pesach I 5787 (Thursday) → Sunday", date: "2027-04-22", due: "2027-04-25", off: ["Pesach I"], notes: ["Pesach: Chol HaMoed 3"] },
  { name: "Yom HaAtzmaut 5787 (Wednesday 12 May) → Thursday", date: "2027-05-12", due: "2027-05-13", off: ["Yom HaAtzmaut"] },
  { name: "Shavuot 5787 on Friday, previous working day → Thursday (erev Shavuot, noted)", date: "2027-06-11", move: "previous", due: "2027-06-10", off: ["Friday", "Shavuot I"], notes: ["Erev Shavuot"] },
  { name: "Rosh Hashana 5788 I on Shabbat → Monday", date: "2027-10-02", due: "2027-10-04", off: ["Shabbat", "Rosh Hashana I"], notes: ["Tzom Gedaliah"] },
  { name: "Yom Kippur 5788 (Monday) → Tuesday", date: "2027-10-11", due: "2027-10-12", off: ["Yom Kippur"] },
  // 2028 — 5788/5789
  { name: "Pesach I 5788 (Tuesday) → Wednesday, Chol HaMoed", date: "2028-04-11", due: "2028-04-12", off: ["Pesach I"], notes: ["Pesach: Chol HaMoed 1"] },
  { name: "Pesach VII 5788 (Monday) → Tuesday", date: "2028-04-17", due: "2028-04-18", off: ["Pesach VII"] },
  { name: "Yom HaAtzmaut 5788: 5 Iyar is a Monday, so it is Tuesday 2 May → Wednesday", date: "2028-05-02", due: "2028-05-03", off: ["Yom HaAtzmaut"] },
  { name: "Shavuot 5788 (Wednesday) → Thursday", date: "2028-05-31", due: "2028-06-01", off: ["Shavuot I"] },
  { name: "Rosh Hashana 5789 Thursday–Friday, then Shabbat → Sunday, the fast of Gedaliah (moved off Shabbat)", date: "2028-09-21", due: "2028-09-24", off: ["Rosh Hashana I"], notes: ["Tzom Gedaliah"] },
  { name: "Yom Kippur 5789 on Shabbat → Sunday", date: "2028-09-30", due: "2028-10-01", off: ["Shabbat", "Yom Kippur"] },
  // The diaspora: two days of yom tov, a Monday–Friday week.
  { name: "Diaspora: Pesach II 5788 (Wednesday) is also off → Thursday", date: "2028-04-12", israel: false, week: "mon-fri", due: "2028-04-13", off: ["Pesach II"], notes: ["Pesach: Chol HaMoed 1"] },
  { name: "Diaspora: a Friday is a working day in a Mon–Fri week", date: "2026-09-11", israel: false, week: "mon-fri", due: "2026-09-11", off: [], notes: ["Erev Rosh Hashana"] },
  { name: "Moving off: the date stays, the reasons are still given", date: "2028-10-12", move: "off", due: "2028-10-12", off: ["Shemini Atzeret and Simchat Torah"] },
];

describe("Israeli time: 30 golden deadlines, 2026–2028", () => {
  it("there are 30 scenarios", () => expect(GOLDEN.length).toBe(30));

  for (const g of GOLDEN) {
    it(g.name, () => {
      const opts = { israel: g.israel ?? true, workWeek: g.week ?? "sun-thu", move: g.move };
      const a = adjustDeadline(d(g.date), opts);
      expect(iso(a.due)).toBe(g.due);
      expect(a.moved).toBe(g.due !== g.date);
      expect(offLabels(a.off, "en")).toEqual(g.off);
      expect(a.notes.map((n) => noteLabel(n, "en"))).toEqual(g.notes ?? []);
    });
  }
});

describe("Israeli time: work week and working days", () => {
  it("Sun–Thu: Friday and Shabbat are the weekend; Mon–Fri: Shabbat and Sunday", () => {
    expect([0, 1, 2, 3, 4, 5, 6].filter((w) => isWeekend(w, "sun-thu"))).toEqual([5, 6]);
    expect([0, 1, 2, 3, 4, 5, 6].filter((w) => isWeekend(w, "mon-fri"))).toEqual([0, 6]);
    expect(defaultWorkWeek(true)).toBe("sun-thu");
    expect(defaultWorkWeek(false)).toBe("mon-fri");
  });

  it("working days until a deadline skip the weekend and the chag", () => {
    // Wednesday 1 Apr 2026 (erev Pesach) → Sunday 5 Apr: Thursday is Pesach, then Friday and Shabbat.
    expect(workingDaysUntil(d("2026-04-01"), d("2026-04-05"), IL)).toBe(1);
    // Thursday 10 Sep 2026 → Monday 14 Sep: Rosh Hashana on Shabbat and Sunday.
    expect(workingDaysUntil(d("2026-09-10"), d("2026-09-14"), IL)).toBe(1);
    expect(workingDaysUntil(d("2026-09-14"), d("2026-09-14"), IL)).toBe(0);
    // A past deadline counts back.
    expect(workingDaysUntil(d("2026-09-14"), d("2026-09-10"), IL)).toBe(-1);
    // A plain week: Sunday 1 Nov 2026 → Sunday 8 Nov is 5 working days.
    expect(workingDaysUntil(d("2026-11-01"), d("2026-11-08"), IL)).toBe(5);
  });

  it("Shabbat itself is off with no holiday", () => {
    expect(dayStatus(d("2026-11-07"), IL)).toMatchObject({ working: false, notes: [] });
    expect(offLabels(dayStatus(d("2026-11-07"), IL).off, "he")).toEqual(["שבת"]);
  });

  it("reads dates from frontmatter values; rejects anything else", () => {
    expect(dayOfValue("2026-09-12")).toEqual({ y: 2026, m: 9, d: 12 });
    expect(dayOfValue("2026-09-12T23:00")).toEqual({ y: 2026, m: 9, d: 12 });
    expect(dayOfValue(new Date(Date.UTC(2026, 8, 12)))).toEqual({ y: 2026, m: 9, d: 12 });
    expect(dayOfValue("2026-02-30")).toBeNull();
    expect(dayOfValue("soon")).toBeNull();
    expect(dayOfValue(20260912)).toBeNull();
  });

  it("every rest day above is the Hebrew date ICU gives (an independent check of the calendar)", () => {
    const f = new Intl.DateTimeFormat("en-u-ca-hebrew", { month: "long", day: "numeric", timeZone: "UTC" });
    const heb = (s: string) => f.format(new Date(`${s}T12:00:00Z`));
    expect(heb("2026-09-12")).toBe("1 Tishri");
    expect(heb("2026-09-21")).toBe("10 Tishri");
    expect(heb("2026-09-26")).toBe("15 Tishri");
    expect(heb("2026-10-03")).toBe("22 Tishri");
    expect(heb("2026-04-02")).toBe("15 Nisan");
    expect(heb("2026-04-08")).toBe("21 Nisan");
    expect(heb("2026-05-22")).toBe("6 Sivan");
    expect(heb("2027-04-22")).toBe("15 Nisan");
    expect(heb("2027-10-02")).toBe("1 Tishri");
    expect(heb("2028-04-11")).toBe("15 Nisan");
    expect(heb("2028-05-31")).toBe("6 Sivan");
    expect(heb("2028-09-21")).toBe("1 Tishri");
    expect(heb("2028-09-30")).toBe("10 Tishri");
    expect(heb("2028-05-02")).toBe("6 Iyar");
  });
});
