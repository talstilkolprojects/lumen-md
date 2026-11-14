/**
 * Plan W5.2: 20 golden academic citations in APA 7 as Israeli universities
 * teach it (the "il" style of plan W2.16): Hebrew sources in their own list
 * before the others, Hebrew terms (ואחרים, עמ׳, בתוך … (עורך), ללא תאריך),
 * initials with a geresh, א/ב for the same author and year, and a title
 * without an author sorted without its ה. Each was checked by hand against
 * those rules; the law-student review the plan asks for (≥ 38/40 with the
 * legal set) is owed.
 */
import { describe, it, expect } from "vitest";
import { bibliography, formatCluster, yearSuffixes, type CiteContext } from "../citations/cite";
import type { CitationRecord, Run } from "../data/citationStyles";
import type { CiteItem, Cluster } from "../citations/pandoc";

const R: Record<string, CitationRecord> = {
  b1: { type: "book", authors: [{ family: "ברק", given: "אהרן" }], year: "1993", title: "פרשנות במשפט", publisher: "נבו" },
  b2: { type: "book", authors: [{ family: "דרשן", given: "דן" }, { family: "לוי", given: "מיכל" }], year: "2018", title: "מבוא לסטטיסטיקה", publisher: "האוניברסיטה הפתוחה" },
  a1: { type: "article", authors: [{ family: "כהן", given: "רונית" }], year: "2019", title: "למידה מרחוק בעידן הקורונה", container: "דפים", volume: "72", pages: "11–35" },
  a2: { type: "article", authors: [{ family: "Smith", given: "John" }, { family: "Doe", given: "Jane" }], year: "2019", title: "Learning at a distance", container: "Journal of Education", volume: "12", issue: "3", pages: "45–67", doi: "10.1000/xyz" },
  c1: { type: "chapter", authors: [{ family: "שמיר", given: "יעל" }], editors: [{ family: "פרידמן", given: "עמי" }], year: "2015", title: "חינוך והוראה", container: "ספר החינוך", publisher: "מאגנס", pages: "100–120" },
  a3: { type: "article", authors: [{ family: "לוי", given: "א" }, { family: "כהן", given: "ב" }, { family: "מזרחי", given: "ג" }], year: "2021", title: "מחקר משותף", container: "מגמות", volume: "55", pages: "1–20" },
  k1: { type: "article", authors: [{ family: "כהן", given: "רונית" }], year: "2020", title: "שינויים בהוראה", container: "דפים", volume: "72", pages: "36–50" },
  k2: { type: "article", authors: [{ family: "כהן", given: "רונית" }], year: "2020", title: "אתגרי ההערכה", container: "דפים", volume: "73", pages: "1–10" },
  e3: { type: "article", authors: [{ family: "Brown", given: "A." }, { family: "Green", given: "B." }, { family: "White", given: "C." }], year: "2018", title: "Teams", container: "Science", volume: "1", pages: "1–2" },
  nd: { type: "web", authors: [{ family: "משרד החינוך" }], title: "חוזר מנכ״ל", url: "https://example.com/c" },
  ti: { type: "report", authors: [], year: "2022", title: "הדוח השנתי", publisher: "בנק ישראל" },
};
const cited = Object.entries(R).map(([key, record]) => ({ key, record }));
const suffix = yearSuffixes(cited, "il");
const ctx: CiteContext = { style: "il", lang: "he", lookup: (k) => R[k], suffix };
const text = (runs: Run[]) => runs.map((r) => (r.i ? `_${r.t}_` : r.t)).join("");
const lists = bibliography(cited, { style: "il", lang: "he", suffix });
const ref = (key: string) => text(lists.flat().find((e) => e.key === key)!.runs);
type Item = { key: string; locator?: CiteItem["locator"] };
const cite = (items: Item[], inText = false) =>
  formatCluster({ inText, items: items.map((i): CiteItem => ({ prefix: "", suffix: "", suppressAuthor: false, ...i, locator: i.locator ?? null })) } as unknown as Cluster, ctx, "?");

const REFERENCES: Array<[string, string]> = [
  ["b1", "ברק, א׳ (1993). _פרשנות במשפט_. נבו."],
  ["b2", "דרשן, ד׳, ולוי, מ׳ (2018). _מבוא לסטטיסטיקה_. האוניברסיטה הפתוחה."],
  ["a1", "כהן, ר׳ (2019). למידה מרחוק בעידן הקורונה. _דפים_, _72_, 11–35."],
  ["a3", "לוי, א׳, כהן, ב׳, ומזרחי, ג׳ (2021). מחקר משותף. _מגמות_, _55_, 1–20."],
  ["c1", "שמיר, י׳ (2015). חינוך והוראה. בתוך ע׳ פרידמן (עורך), _ספר החינוך_ (עמ׳ 100–120). מאגנס."],
  ["a2", "Smith, J., & Doe, J. (2019). Learning at a distance. _Journal of Education_, _12_(3), 45–67. https://doi.org/10.1000/xyz"],
  ["k2", "כהן, ר׳ (2020א). אתגרי ההערכה. _דפים_, _73_, 1–10."],
  ["k1", "כהן, ר׳ (2020ב). שינויים בהוראה. _דפים_, _72_, 36–50."],
  ["nd", "משרד החינוך. (ללא תאריך). _חוזר מנכ״ל_. https://example.com/c"],
  ["ti", "_הדוח השנתי_. (2022). בנק ישראל."],
  ["e3", "Brown, A., Green, B., & White, C. (2018). Teams. _Science_, _1_, 1–2."],
];

const p12 = { label: "page" as const, value: "12" };
const IN_TEXT: Array<[string, () => string, string]> = [
  ["one Hebrew author with a page", () => cite([{ key: "b1", locator: p12 }]), "(ברק, 1993, עמ׳ 12)"],
  ["two Hebrew authors: ו attached", () => cite([{ key: "b2", locator: p12 }]), "(דרשן ולוי, 2018, עמ׳ 12)"],
  ["three or more: ואחרים", () => cite([{ key: "a3" }]), "(לוי ואחרים, 2021)"],
  ["an English source keeps English terms", () => cite([{ key: "a2", locator: p12 }]), "(Smith & Doe, 2019, p. 12)"],
  ["narrative, with the year suffix", () => cite([{ key: "k1" }], true), "כהן (2020ב)"],
  ["two sources, Hebrew and English", () => cite([{ key: "k2" }, { key: "e3" }]), "(כהן, 2020א; Brown et al., 2018)"],
  ["no date", () => cite([{ key: "nd" }]), "(משרד החינוך, ללא תאריך)"],
  ["a chapter", () => cite([{ key: "c1", locator: p12 }]), "(שמיר, 2015, עמ׳ 12)"],
  ["a single page range locator", () => cite([{ key: "a1", locator: { label: "page", value: "11–12" } }]), "(כהן, 2019, עמ׳ 11–12)"],
];

describe("APA 7, Israeli academic: 20 golden citations", () => {
  it("there are 20 (11 references, 9 in-text)", () => expect(REFERENCES.length + IN_TEXT.length).toBe(20));
  for (const [key, want] of REFERENCES) it(`reference: ${key}`, () => expect(ref(key)).toBe(want));
  for (const [name, got, want] of IN_TEXT) it(`in text: ${name}`, () => expect(got()).toBe(want));
  it("Hebrew sources come in their own list, first; the title-first entry sorts without its ה", () => {
    expect(lists.map((l) => l.map((e) => e.key))).toEqual([["b1", "ti", "b2", "a1", "k2", "k1", "a3", "nd", "c1"], ["e3", "a2"]]);
  });
});
