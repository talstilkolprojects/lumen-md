/**
 * W2.10 — the Hebrew calendar: our own arithmetic against the browser's ICU
 * Hebrew calendar, every holiday rule against a hand-checked table for
 * 2025–2030, the Torah portions (Israel and the diaspora), {{holiday}} and
 * {{parasha}} in the daily note, and the time to compute a year.
 *
 * The table was checked by hand: the Hebrew dates come from Intl (not from
 * the code under test), the weekday rules were applied one by one, and the
 * well-known dates (Rosh Hashana, Pesach, Chanukah, Yom HaAtzmaut) agree with
 * the published calendars of those years.
 */
import { describe, expect, it } from "vitest";
import {
  AV,
  ELUL,
  PARASHOT,
  TISHREI,
  __clearHebrewCalendarCaches,
  calendarOfRange,
  daysInMonth,
  defaultIsrael,
  fixedOf,
  fixedOfHebrew,
  gregorianOf,
  hebrewOfFixed,
  holidaysOfHebrewYear,
  holidaysOn,
  isLeapYear,
  readingsOfHebrewYear,
  roshHashana,
  weekdayOf,
  weeklyReading,
  type GDay,
  type ParashaId,
} from "../daily/hebrewCalendar";
import { NAMED_HOLIDAYS, holidayLabel, holidayName, readingName } from "../daily/hebrewCalendarNames";
import { renderTemplate } from "../daily/dailyNote";

const g = (iso: string): GDay => {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
};
const iso = (fixed: number) => {
  const x = gregorianOf(fixed);
  return `${x.y}-${String(x.m).padStart(2, "0")}-${String(x.d).padStart(2, "0")}`;
};
const IL = { israel: true };
const DIASPORA = { israel: false };

/** Every date of `id` in Gregorian years 2025–2030. */
function datesOf(id: string, opts = IL): string[] {
  return calendarOfRange(g("2025-01-01"), g("2030-12-31"), opts)
    .holidays.filter((h) => h.id === id)
    .map((h) => iso(h.fixed));
}

describe("the arithmetic", () => {
  it("agrees with the ICU Hebrew calendar on every day from 1990 to 2060", () => {
    const f = new Intl.DateTimeFormat("en-u-ca-hebrew", { day: "numeric", month: "numeric", year: "numeric", timeZone: "UTC" });
    let checked = 0;
    for (let x = fixedOf(g("1990-01-01")); x <= fixedOf(g("2060-12-31")); x++) {
      const h = hebrewOfFixed(x);
      expect(fixedOfHebrew(h)).toBe(x);
      // ICU (77 here) gets Hebrew year 5806 (2045–46) wrong: a 30-day
      // Cheshvan in a 384-day year, which has 29, an Elul one day short, and
      // Rosh Hashana 5807 on Tuesday 2 October 2046 — its molad is Sunday
      // 17h 87p, so lo ADU moves it to Monday 1 October. Those two years are
      // checked by their lengths below instead.
      const d = gregorianOf(x);
      const p = Object.fromEntries(f.formatToParts(new Date(Date.UTC(d.y, d.m - 1, d.d, 12))).map((q) => [q.type, q.value]));
      if (h.year === 5806 || h.year === 5807 || p.year === "5806" || p.year === "5807") continue;
      if (Number(p.year) !== h.year || Number(p.day) !== h.day) expect(`${iso(x)}: ${p.day} ${p.month} ${p.year}`).toBe(`${h.day} ${h.month} ${h.year}`);
      checked++;
    }
    expect(checked).toBeGreaterThan(25_000);
  });

  it("keeps Rosh Hashana off Sunday, Wednesday and Friday, and every year 353–355 or 383–385 days", () => {
    for (let y = 5600; y <= 6000; y++) {
      expect([0, 3, 5]).not.toContain(weekdayOf(roshHashana(y)));
      const len = roshHashana(y + 1) - roshHashana(y);
      expect(isLeapYear(y) ? [383, 384, 385] : [353, 354, 355]).toContain(len);
      expect(daysInMonth(ELUL, y)).toBe(29);
    }
    expect(roshHashana(5807) - roshHashana(5806)).toBe(384);
    expect(iso(roshHashana(5807))).toBe("2046-10-01");
  });

  it("puts Rosh Hashana where the published calendars do", () => {
    const rh = [5785, 5786, 5787, 5788, 5789, 5790, 5791].map((y) => iso(roshHashana(y)));
    expect(rh).toEqual(["2024-10-03", "2025-09-23", "2026-09-12", "2027-10-02", "2028-09-21", "2029-09-10", "2030-09-28"]);
  });
});

describe("holidays 2025–2030, by rule (hand-checked)", () => {
  it("Rosh Hashana, Yom Kippur and Sukkot", () => {
    expect(datesOf("rosh-hashana-1")).toEqual(["2025-09-23", "2026-09-12", "2027-10-02", "2028-09-21", "2029-09-10", "2030-09-28"]);
    expect(datesOf("rosh-hashana-2")).toEqual(["2025-09-24", "2026-09-13", "2027-10-03", "2028-09-22", "2029-09-11", "2030-09-29"]);
    expect(datesOf("yom-kippur")).toEqual(["2025-10-02", "2026-09-21", "2027-10-11", "2028-09-30", "2029-09-19", "2030-10-07"]);
    expect(datesOf("sukkot-1")).toEqual(["2025-10-07", "2026-09-26", "2027-10-16", "2028-10-05", "2029-09-24", "2030-10-12"]);
    expect(datesOf("hoshana-raba")).toEqual(["2025-10-13", "2026-10-02", "2027-10-22", "2028-10-11", "2029-09-30", "2030-10-18"]);
  });

  it("Tzom Gedaliah: 3 Tishrei, or Sunday when that is Shabbat (2028)", () => {
    expect(datesOf("tzom-gedaliah")).toEqual(["2025-09-25", "2026-09-14", "2027-10-04", "2028-09-24", "2029-09-12", "2030-09-30"]);
  });

  it("Shemini Atzeret and Simchat Torah: one day in Israel, two in the diaspora", () => {
    expect(datesOf("shemini-atzeret-simchat-torah")).toEqual(["2025-10-14", "2026-10-03", "2027-10-23", "2028-10-12", "2029-10-01", "2030-10-19"]);
    expect(datesOf("shemini-atzeret", DIASPORA)).toEqual(datesOf("shemini-atzeret-simchat-torah"));
    expect(datesOf("simchat-torah", DIASPORA)).toEqual(["2025-10-15", "2026-10-04", "2027-10-24", "2028-10-13", "2029-10-02", "2030-10-20"]);
    expect(datesOf("simchat-torah")).toEqual([]);
    expect(datesOf("sukkot-2", DIASPORA)).toEqual(["2025-10-08", "2026-09-27", "2027-10-17", "2028-10-06", "2029-09-25", "2030-10-13"]);
  });

  it("Chanukah: 25 Kislev, eight days, into Tevet by the length of Kislev", () => {
    expect(datesOf("chanukah-1")).toEqual(["2025-12-15", "2026-12-05", "2027-12-25", "2028-12-13", "2029-12-02", "2030-12-21"]);
    // A 30-day Kislev (5785, 5786) ends Chanukah on 2 Tevet, a 29-day one (5790) on 3 Tevet.
    expect(datesOf("chanukah-8")).toEqual(["2025-01-02", "2025-12-22", "2026-12-12", "2028-01-01", "2028-12-20", "2029-12-09", "2030-12-28"]);
  });

  it("10 Tevet: never moved, even on Friday (January 2025)", () => {
    expect(datesOf("asara-btevet")).toEqual(["2025-01-10", "2025-12-30", "2026-12-20", "2028-01-09", "2028-12-28", "2029-12-16"]);
  });

  it("Tu BiShvat, Purim Katan (leap years only) and Purim (Adar II in a leap year)", () => {
    expect(datesOf("tu-bishvat")).toEqual(["2025-02-13", "2026-02-02", "2027-01-23", "2028-02-12", "2029-01-31", "2030-01-19"]);
    expect(datesOf("purim-katan")).toEqual(["2027-02-21", "2030-02-17"]);
    expect(datesOf("purim")).toEqual(["2025-03-14", "2026-03-03", "2027-03-23", "2028-03-12", "2029-03-01", "2030-03-19"]);
    expect(datesOf("shushan-purim")).toEqual(["2025-03-15", "2026-03-04", "2027-03-24", "2028-03-13", "2029-03-02", "2030-03-20"]);
  });

  it("Ta'anit Esther: 13 Adar, or Thursday when that is Shabbat (2028)", () => {
    expect(datesOf("taanit-esther")).toEqual(["2025-03-13", "2026-03-02", "2027-03-22", "2028-03-09", "2029-02-28", "2030-03-18"]);
  });

  it("Ta'anit Bechorot: 14 Nisan, or Thursday when that is Shabbat (2025)", () => {
    expect(datesOf("taanit-bechorot")).toEqual(["2025-04-10", "2026-04-01", "2027-04-21", "2028-04-10", "2029-03-30", "2030-04-17"]);
  });

  it("Pesach: seven days in Israel, eight in the diaspora", () => {
    expect(datesOf("pesach-1")).toEqual(["2025-04-13", "2026-04-02", "2027-04-22", "2028-04-11", "2029-03-31", "2030-04-18"]);
    expect(datesOf("pesach-7")).toEqual(["2025-04-19", "2026-04-08", "2027-04-28", "2028-04-17", "2029-04-06", "2030-04-24"]);
    expect(datesOf("pesach-8")).toEqual([]);
    expect(datesOf("pesach-8", DIASPORA)).toEqual(["2025-04-20", "2026-04-09", "2027-04-29", "2028-04-18", "2029-04-07", "2030-04-25"]);
    expect(datesOf("pesach-chm-1")).toEqual(["2025-04-14", "2026-04-03", "2027-04-23", "2028-04-12", "2029-04-01", "2030-04-19"]);
    expect(datesOf("pesach-chm-1", DIASPORA)).toEqual(["2025-04-15", "2026-04-04", "2027-04-24", "2028-04-13", "2029-04-02", "2030-04-20"]);
  });

  it("Yom HaShoah: 27 Nisan; Friday → Thursday (2025), Sunday → Monday (2028)", () => {
    expect(datesOf("yom-hashoah")).toEqual(["2025-04-24", "2026-04-14", "2027-05-04", "2028-04-24", "2029-04-12", "2030-04-30"]);
  });

  it("Yom HaZikaron and Yom HaAtzmaut: moved back from Shabbat (2025) and Friday (2029), on from Monday (2028)", () => {
    expect(datesOf("yom-hazikaron")).toEqual(["2025-04-30", "2026-04-21", "2027-05-11", "2028-05-01", "2029-04-18", "2030-05-07"]);
    expect(datesOf("yom-haatzmaut")).toEqual(["2025-05-01", "2026-04-22", "2027-05-12", "2028-05-02", "2029-04-19", "2030-05-08"]);
  });

  it("Lag BaOmer, Yom Yerushalayim and Shavuot", () => {
    expect(datesOf("lag-baomer")).toEqual(["2025-05-16", "2026-05-05", "2027-05-25", "2028-05-14", "2029-05-03", "2030-05-21"]);
    expect(datesOf("yom-yerushalayim")).toEqual(["2025-05-26", "2026-05-15", "2027-06-04", "2028-05-24", "2029-05-13", "2030-05-31"]);
    expect(datesOf("shavuot-1")).toEqual(["2025-06-02", "2026-05-22", "2027-06-11", "2028-05-31", "2029-05-20", "2030-06-07"]);
    expect(datesOf("shavuot-2")).toEqual([]);
    expect(datesOf("shavuot-2", DIASPORA)).toEqual(["2025-06-03", "2026-05-23", "2027-06-12", "2028-06-01", "2029-05-21", "2030-06-08"]);
  });

  it("17 Tammuz and 9 Av: Sunday when on Shabbat (2029)", () => {
    expect(datesOf("tzom-tammuz")).toEqual(["2025-07-13", "2026-07-02", "2027-07-22", "2028-07-11", "2029-07-01", "2030-07-18"]);
    expect(datesOf("tisha-bav")).toEqual(["2025-08-03", "2026-07-23", "2027-08-12", "2028-08-01", "2029-07-22", "2030-08-08"]);
    expect(datesOf("erev-tisha-bav")).toEqual(["2025-08-02", "2026-07-22", "2027-08-11", "2028-07-31", "2029-07-21", "2030-08-07"]);
    expect(datesOf("tu-bav")).toEqual(["2025-08-09", "2026-07-29", "2027-08-18", "2028-08-07", "2029-07-27", "2030-08-14"]);
  });

  it("Rosh Chodesh: one day after a 29-day month, two after a 30-day one, never in Tishrei", () => {
    // Kislev 5786 has 30 days: Rosh Chodesh Tevet is 30 Kislev and 1 Tevet.
    expect(datesOf("rosh-chodesh-10").filter((d) => d.startsWith("2025-12"))).toEqual(["2025-12-20", "2025-12-21"]);
    // Kislev 5790 has 29 days: one day.
    expect(datesOf("rosh-chodesh-10").filter((d) => d.startsWith("2029-12"))).toEqual(["2029-12-07"]);
    expect(datesOf("rosh-chodesh-7")).toEqual([]);
    // Rosh Chodesh Av always one day (Tammuz has 29), Elul always two (Av has 30).
    for (let y = 5786; y <= 5790; y++) {
      const h = holidaysOfHebrewYear(y, IL);
      expect(h.filter((x) => x.id === `rosh-chodesh-${AV}`).length).toBe(1);
      expect(h.filter((x) => x.id === `rosh-chodesh-${ELUL}`).length).toBe(2);
    }
  });

  it("names every holiday in Hebrew and English", () => {
    const ids = new Set<string>();
    for (let y = 5785; y <= 5791; y++) for (const opts of [IL, DIASPORA]) for (const h of holidaysOfHebrewYear(y, opts)) ids.add(h.id);
    for (const id of ids) {
      expect(holidayName(id, "he"), id).toMatch(/[֐-׿]/);
      expect(holidayName(id, "en"), id).toMatch(/^[A-Z]/);
    }
    for (const id of NAMED_HOLIDAYS) expect(ids.has(id), id).toBe(true);
    expect(holidayName("chanukah-3", "he")).toBe("חנוכה: נר ג׳");
    expect(holidayName("chanukah-3", "en")).toBe("Chanukah: 3 candles");
    const adar = holidaysOn(g("2027-02-08"), IL).find((h) => h.kind === "roshChodesh")!;
    expect(holidayLabel(adar, "he")).toBe("ראש חודש אדר א׳");
  });
});

describe("Torah portions", () => {
  const read = (date: string, opts = IL) => weeklyReading(g(date), opts).parashot.join("-") || `(${weeklyReading(g(date), opts).holiday})`;

  it("reads every portion once a year, in order, with Vezot Haberakhah on Simchat Torah", () => {
    for (let y = 5770; y <= 5791; y++) {
      for (const opts of [IL, DIASPORA]) {
        const rs = readingsOfHebrewYear(y, opts);
        const flat = rs.flatMap((r) => r.parashot);
        const start = flat.indexOf("bereshit");
        const main = flat.slice(start);
        expect(main, `${y}`).toEqual(PARASHOT.slice(0, main.length));
        expect(["nitzavim", "vayeilech"], `${y}`).toContain(main[main.length - 1]);
        const before = flat.slice(0, start);
        expect(before.length === 1 ? ["haazinu"] : ["vayeilech", "haazinu"], `${y}`).toEqual(before);
        expect(flat).not.toContain("vezot-haberakhah");
        // Last year's Vayeilech is read now exactly when it wasn't then.
        const lastYear = readingsOfHebrewYear(y - 1, opts).flatMap((r) => r.parashot);
        expect(lastYear[lastYear.length - 1] === "vayeilech", `${y}`).toBe(before.length === 1);
      }
    }
  });

  it("joins the pairs of 5785 and 5786 as published (hand-checked)", () => {
    // 5785: Vayakhel and Pekudei apart (a complete year from Thursday).
    expect([read("2025-03-22"), read("2025-03-29"), read("2025-04-05"), read("2025-04-12")]).toEqual(["vayakhel", "pekudei", "vayikra", "tzav"]);
    expect([read("2025-04-26"), read("2025-05-03"), read("2025-05-10"), read("2025-05-17"), read("2025-05-24"), read("2025-05-31")]).toEqual(["shmini", "tazria-metzora", "achrei-mot-kedoshim", "emor", "behar-bechukotai", "bamidbar"]);
    expect([read("2025-07-26"), read("2025-08-02"), read("2025-08-09")]).toEqual(["matot-masei", "devarim", "vaetchanan"]);
    // Rosh Hashana 5786 on Tuesday: Nitzavim alone, Vayeilech on Shabbat Shuva.
    expect([read("2025-09-20"), read("2025-09-27"), read("2025-10-04"), read("2025-10-11"), read("2025-10-18")]).toEqual(["nitzavim", "vayeilech", "haazinu", "(sukkot-chm-4)", "bereshit"]);
    // 5786: Vayakhel–Pekudei joined, Tzav on Shabbat HaGadol.
    expect([read("2026-03-14"), read("2026-03-21"), read("2026-03-28"), read("2026-04-04"), read("2026-04-11")]).toEqual(["vayakhel-pekudei", "vayikra", "tzav", "(pesach-chm-2)", "shmini"]);
  });

  it("splits Israel and the diaspora after the second day of Shavuot on Shabbat (2026), and rejoins at Chukat–Balak", () => {
    const days = ["2026-05-23", "2026-05-30", "2026-06-06", "2026-06-13", "2026-06-20", "2026-06-27", "2026-07-04", "2026-07-11", "2026-07-18"];
    expect(days.map((d) => read(d, DIASPORA))).toEqual(["(shavuot-2)", "nasso", "behaalotcha", "shlach", "korach", "chukat-balak", "pinchas", "matot-masei", "devarim"]);
    expect(days.map((d) => read(d, IL))).toEqual(["nasso", "behaalotcha", "shlach", "korach", "chukat", "balak", "pinchas", "matot-masei", "devarim"]);
  });

  it("splits after the eighth day of Pesach on Shabbat (2029), and rejoins at Behar–Bechukotai", () => {
    const days = ["2029-04-07", "2029-04-14", "2029-04-21", "2029-04-28", "2029-05-05", "2029-05-12", "2029-05-19"];
    expect(days.map((d) => read(d, DIASPORA))).toEqual(["(pesach-8)", "shmini", "tazria-metzora", "achrei-mot-kedoshim", "emor", "behar-bechukotai", "bamidbar"]);
    expect(days.map((d) => read(d, IL))).toEqual(["shmini", "tazria-metzora", "achrei-mot-kedoshim", "emor", "behar", "bechukotai", "bamidbar"]);
  });

  it("in a leap year, nothing is joined before Pesach: Metzora on Shabbat HaGadol (2027, 2030)", () => {
    expect(read("2027-04-17")).toBe("metzora");
    expect(read("2030-04-13")).toBe("metzora");
    // 5787 joins Nitzavim–Vayeilech before a Thursday Rosh Hashana (2027-10-02 is Shabbat: also joined).
    expect(read("2027-09-25")).toBe("nitzavim-vayeilech");
  });

  it("reads Devarim on 9 Av itself when that is Shabbat (2029)", () => {
    expect(read("2029-07-21")).toBe("devarim");
    expect(read("2029-07-28")).toBe("vaetchanan");
  });

  it("names a reading in Hebrew and English", () => {
    expect(readingName(weeklyReading(g("2029-05-09"), DIASPORA), "he")).toBe("פרשת בהר-בחוקותי");
    expect(readingName(weeklyReading(g("2029-05-09"), DIASPORA), "en")).toBe("Behar-Bechukotai");
    expect(readingName(weeklyReading(g("2026-04-01"), IL), "en")).toBe("Pesach: Chol HaMoed 2");
    for (const p of PARASHOT) expect(readingName({ fixed: 0, parashot: [p as ParashaId] }, "he")).toMatch(/^פרשת [֐-׿]/);
  });
});

describe("in the daily note", () => {
  it("fills {{holiday}} and {{parasha}} for Israel or the diaspora", () => {
    const tpl = "{{holiday}}|{{parasha}}";
    expect(renderTemplate(tpl, g("2026-05-23"), "he", { israel: true })).toBe("|פרשת נשא");
    expect(renderTemplate(tpl, g("2026-05-23"), "en", { israel: false })).toBe("Shavuot II|Shavuot II");
    expect(renderTemplate(tpl, g("2025-12-15"), "en", { israel: true })).toBe("Chanukah: 1 candle|Miketz");
    expect(renderTemplate(tpl, g("2025-05-01"), "he", { israel: true })).toBe("יום העצמאות|פרשת תזריע-מצורע");
    // A day with no holiday: an empty {{holiday}}.
    expect(renderTemplate("[{{holiday}}]", g("2026-11-17"), "en", { israel: true })).toBe("[]");
    // 30 Cheshvan 5787 is Rosh Chodesh Kislev.
    expect(renderTemplate("{{holiday}}", g("2026-11-10"), "he", { israel: true })).toBe("ראש חודש כסלו");
  });

  it("defaults to Israel for a Hebrew UI or the Israeli time zone", () => {
    expect(defaultIsrael("he", "Europe/London")).toBe(true);
    expect(defaultIsrael("en", "Asia/Jerusalem")).toBe(true);
    expect(defaultIsrael("en", "America/New_York")).toBe(false);
  });
});

describe("speed", () => {
  it("computes a whole year — holidays and readings, Israel and the diaspora — in under 20 ms", () => {
    // Warm the JIT on other years, then time a year from cold caches.
    for (let y = 2000; y < 2004; y++) calendarOfRange(g(`${y}-01-01`), g(`${y}-12-31`), IL);
    const times: number[] = [];
    for (const y of [2026, 2027, 2028]) {
      __clearHebrewCalendarCaches();
      const t0 = performance.now();
      const il = calendarOfRange(g(`${y}-01-01`), g(`${y}-12-31`), IL);
      const d = calendarOfRange(g(`${y}-01-01`), g(`${y}-12-31`), DIASPORA);
      times.push(performance.now() - t0);
      expect(il.holidays.length).toBeGreaterThan(60);
      expect(d.readings.length).toBeGreaterThanOrEqual(52);
    }
    expect(Math.max(...times)).toBeLessThan(20);
  });

  it("knows the Hebrew date of Rosh Hashana itself", () => {
    expect(hebrewOfFixed(roshHashana(5787))).toEqual({ year: 5787, month: TISHREI, day: 1 });
  });
});
