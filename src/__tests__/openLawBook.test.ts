/**
 * W11.H16 — the Open Book of Laws (gkour/israeli_law, CC BY-SA 4.0,
 * Wikisource) as an offline W7.5 source, and Supreme Court rulings as
 * link-only. The corpus here is SYNTHETIC (fixtures/openlaw/README.md: real
 * law titles, made-up section texts); the 20-lookup check on the real
 * dataset is owed until it is pinned and downloaded.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildCorpus,
  lookupOpenLaw,
  parseLawQuery,
  parseOpenLawRows,
  plainLawText,
  renderOpenLawNote,
  verdictLink,
  OPEN_LAW_REVISION,
  OPEN_LAW_RIGHTS,
  VERDICT_RIGHTS,
} from "../sources/openlaw/book";
import { mayCopy } from "../sources/open/rights";
// @ts-expect-error — plain .mjs helper without types
import { validateEntry } from "../../scripts/lib/licenses.mjs";

const corpus = buildCorpus(parseOpenLawRows(readFileSync("src/__tests__/fixtures/openlaw/israeli_law.synthetic.jsonl", "utf8")));

// 20 lookups, written the ways people write them: [query, law title, section].
const LOOKUPS: [string, string, string | null][] = [
  ["סעיף 1 לחוק הגנת הפרטיות", 'חוק הגנת הפרטיות, התשמ"א-1981', "1"],
  ["חוק הגנת הפרטיות, סעיף 7", 'חוק הגנת הפרטיות, התשמ"א-1981', "7"],
  ["ס' 2 לחוק הגנת הפרטיות התשמ״א-1981", 'חוק הגנת הפרטיות, התשמ"א-1981', "2"],
  ["סעיף 2 לחוק הגנת הצרכן", 'חוק הגנת הצרכן, התשמ"א-1981', "2"],
  ["סעיף 14ג לחוק הגנת הצרכן", 'חוק הגנת הצרכן, התשמ"א-1981', "14ג"],
  ["סעיף 12 לחוק החוזים (חלק כללי)", 'חוק החוזים (חלק כללי), התשל"ג-1973', "12"],
  ["סעיף 39 לחוק החוזים (חלק כללי), התשל״ג-1973", 'חוק החוזים (חלק כללי), התשל"ג-1973', "39"],
  ["חוק החוזים חלק כללי סעיף 1", 'חוק החוזים (חלק כללי), התשל"ג-1973', "1"],
  ["סעיף 11 לחוק המכר", 'חוק המכר, התשכ"ח-1968', "11"],
  ["סעיף 6 לחוק השכירות והשאילה", 'חוק השכירות והשאילה, התשל"א-1971', "6"],
  ["סעיף 1 לחוק פיצויי פיטורים", 'חוק פיצויי פיטורים, התשכ"ג-1963', "1"],
  ["סעיף 300 לחוק העונשין", 'חוק העונשין, התשל"ז-1977', "300"],
  ["חוק העונשין סעיף 34ג", 'חוק העונשין, התשל"ז-1977', "34ג"],
  ["סעיף 8 לחוק יסוד: כבוד האדם וחירותו", "חוק-יסוד: כבוד האדם וחירותו", "8"],
  ["ח״י: כבוד האדם וחירותו, סעיף 1", "חוק-יסוד: כבוד האדם וחירותו", "1"],
  ["סעיף 1 לחוק חופש המידע", 'חוק חופש המידע, התשנ"ח-1998', "1"],
  ["סעיף 6 לחוק זכות יוצרים", 'חוק זכות יוצרים, התשס"ח-2007', "6"],
  ["חוק זכות יוצרים", 'חוק זכות יוצרים, התשס"ח-2007', null],
  ["חוק המכר", 'חוק המכר, התשכ"ח-1968', null],
  ["חוק הגנת הצרכן התשמ״א", 'חוק הגנת הצרכן, התשמ"א-1981', null],
];

describe("20 law and section lookups (synthetic corpus)", () => {
  const results = LOOKUPS.map(([q, law, sec]) => {
    const hit = lookupOpenLaw(q, corpus);
    return { q, ok: !!hit && hit.law.name === law && (hit.section?.number ?? null) === sec };
  });
  for (const r of results) it(r.q, () => expect(r.ok).toBe(true));
  it("at least 18 of 20 are right (W11.H16 acceptance, on the synthetic corpus)", () => {
    expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(18);
  });
  it("a section the law does not have, and a law the corpus does not have, find nothing", () => {
    expect(lookupOpenLaw("סעיף 999 לחוק המכר", corpus)).toBeNull();
    expect(lookupOpenLaw("חוק הגנת הצמחים", corpus)).toBeNull();
  });
});

describe("parsing", () => {
  it("splits a query into the law and the section", () => {
    expect(parseLawQuery("סעיף 12 לחוק החוזים (חלק כללי)")).toEqual({ law: "חוק החוזים (חלק כללי)", section: "12" });
    expect(parseLawQuery("חוק המכר, סעיף 11")).toEqual({ law: "חוק המכר", section: "11" });
    expect(parseLawQuery("חוק המכר")).toEqual({ law: "חוק המכר", section: null });
  });
  it("Wikisource's ח: templates become numbered section lines; refs, other templates and link markup go", () => {
    expect(plainLawText("{{ח:פתיח-התחלה}}\n{{ח:סעיף|5|הגדרות|תיקון: 2005}}\n{{ח:ת}} ב[[חוק]] זה '''מידע''' הוא<ref>x</ref> נתון.\n{{ח:תת|(א)}} ראשון")).toBe("5. הגדרות\nבחוק זה מידע הוא נתון.\n(א) ראשון");
  });
  it("an export with other column names fails with the fields it found", () => {
    expect(() => parseOpenLawRows('{"heading":"x","body2":"y"}')).toThrow(/heading, body2/);
  });
});

describe("rights: every stored text carries its licence tag", () => {
  it("each saved note has rights cc-by-sa, the licence, Wikisource's credit, the link and 'not official'", () => {
    const notes = LOOKUPS.map(([q]) => lookupOpenLaw(q, corpus)).filter(Boolean).map((h) => renderOpenLawNote(h!, "2026-11-15"));
    expect(notes).toHaveLength(20);
    for (const n of notes) {
      expect(n).toMatch(/^---\n[\s\S]*\nrights: cc-by-sa\nlicense: CC-BY-SA-4\.0\ncredit: "ספר החוקים הפתוח — ויקיטקסט/);
      expect(n).toContain("official: false");
      expect(n).toMatch(/url: https:\/\/he\.wikisource\.org\/wiki\//);
    }
    expect(OPEN_LAW_RIGHTS).toBe("cc-by-sa");
    expect(mayCopy(OPEN_LAW_RIGHTS)).toBe(true);
  });
  it("the source is not offered until the dataset revision is pinned", () => {
    expect(OPEN_LAW_REVISION).toBeNull();
  });
});

describe("Supreme Court rulings: link only", () => {
  it("a case reference is a title and a link, with rights that forbid a copy", () => {
    const v = verdictLink('בג"ץ 6821/93 בנק המזרחי נ׳ מגדל');
    expect(v).toMatchObject({ title: "בג״ץ 6821/93 בנק המזרחי נ׳ מגדל", rights: "link-only" });
    expect(v!.url).toMatch(/^https:\/\/supreme\.court\.gov\.il\//);
    expect(mayCopy(VERDICT_RIGHTS)).toBe(false);
    expect(verdictLink("סתם טקסט")).toBeNull();
  });
});

describe("registry (licence gate 0.10)", () => {
  const reg = JSON.parse(readFileSync("models/registry.json", "utf8")).models as Record<string, unknown>[];
  it("the corpus is CC BY-SA, conditional and unmodified; the rulings are unknown and never downloaded", () => {
    const law = reg.find((e) => e.id === "gkour/israeli_law")!;
    const court = reg.find((e) => e.id === "LevMuchnik/SupremeCourtOfIsrael")!;
    expect(validateEntry(law)).toEqual([]);
    expect(validateEntry(court)).toEqual([]);
    expect([law.class, law.unmodified, law.delivery]).toEqual(["conditional", true, "download"]);
    expect([court.class, court.delivery]).toEqual(["unknown", "none"]);
  });
});
