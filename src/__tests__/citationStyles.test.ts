/**
 * Plan 6.13 — citations in three styles, offline, in Hebrew and English.
 *
 * Acceptance: 20 gold records formatted correctly in 3 styles offline, in
 * Hebrew and English. The 7.10 citations set (all 23 records of its pool,
 * the 5 committed dev items with their expected strings) is the gold for
 * APA 7; Chicago and MLA use the hand-checked table in
 * fixtures/citation-styles.json for the same 23 records. Nothing touches
 * the network.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
// @ts-expect-error — plain .mjs module without types
import { RECORDS } from "../../scripts/golden/sets/small/citations.mjs";
// @ts-expect-error — plain .mjs module without types
import { formatApa, inText } from "../../scripts/golden/sets/small.mjs";
import { parseBibtex } from "../data/bibtex";
import {
  formatInText,
  formatReference,
  initials,
  mlaPublisher,
  pageRange,
  parseNames,
  recordFromBibtex,
  runsToMarkdown,
  sentenceCase,
  type CitationRecord,
  type CitationStyle,
} from "../data/citationStyles";

type GoldRecord = {
  type: "book" | "article";
  authors: Array<[string, string, string?]>;
  year: number;
  title: string;
  titleSentence: string;
  publisher?: string;
  journal?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
};

const ROOT = resolve(__dirname, "../..");
const toRecord = (r: GoldRecord): CitationRecord => ({
  type: r.type,
  authors: r.authors.map(([family, given, suffix]) => ({ family, given, suffix })),
  year: String(r.year),
  title: r.title,
  titleSentence: r.titleSentence,
  container: r.journal,
  publisher: r.publisher,
  volume: r.volume,
  issue: r.issue,
  pages: r.pages,
  doi: r.doi,
});
const records = RECORDS as GoldRecord[];
const idOf = (r: GoldRecord) => `${r.authors[0][0]}${r.year}`;
const table = JSON.parse(readFileSync(join(__dirname, "fixtures", "citation-styles.json"), "utf8")) as Record<string, Record<string, [string, string]>>;
const dev = JSON.parse(readFileSync(join(ROOT, "eval", "golden", "citations", "dev", "records.json"), "utf8")) as {
  items: Array<{ id: string; record: GoldRecord; expected: { apa: string; inText: string; bibtex: string } }>;
};

describe("acceptance: the gold records in 3 styles, Hebrew and English, offline", () => {
  it("covers at least 20 records", () => {
    expect(records.length).toBeGreaterThanOrEqual(20);
    expect(Object.keys(table).filter((k) => !k.startsWith("_"))).toHaveLength(records.length);
  });

  it("APA 7 matches the 7.10 gold for every record (reference and in-text)", () => {
    for (const r of records) {
      expect(runsToMarkdown(formatReference(toRecord(r), "apa", "en")), idOf(r)).toBe(formatApa(r));
      expect(formatInText(toRecord(r), "apa", "en"), idOf(r)).toBe(inText(r));
    }
    // Offline by construction: the formatter fetches nothing and imports no network code.
    const src = readFileSync(join(ROOT, "src", "data", "citationStyles.ts"), "utf8");
    expect(src).not.toMatch(/\bfetch\(|XMLHttpRequest|import\(/);
  });

  it("APA 7 matches the committed dev items' expected strings", () => {
    expect(dev.items.length).toBe(5);
    for (const it of dev.items) {
      expect(runsToMarkdown(formatReference(toRecord(it.record), "apa")), it.id).toBe(it.expected.apa);
      expect(formatInText(toRecord(it.record), "apa"), it.id).toBe(it.expected.inText);
    }
  });

  for (const style of ["chicago", "mla"] as CitationStyle[]) {
    for (const lang of ["en", "he"] as const) {
      it(`${style}, ${lang}: every record`, () => {
        for (const r of records) {
          const [ref, cite] = table[idOf(r)][`${style}.${lang}`];
          expect(runsToMarkdown(formatReference(toRecord(r), style, lang)), `${idOf(r)} ${style}.${lang}`).toBe(ref);
          expect(formatInText(toRecord(r), style, lang), `${idOf(r)} ${style}.${lang} in-text`).toBe(cite);
        }
      });
    }
  }

  it("APA in Hebrew: the conjunction and et al. change, the rest stays", () => {
    const watson = toRecord(records.find((r) => idOf(r) === "Watson1953")!);
    expect(runsToMarkdown(formatReference(watson, "apa", "he"))).toBe(
      "Watson, J. D. ו-Crick, F. H. C. (1953). Molecular structure of nucleic acids: A structure for deoxyribose nucleic acid. *Nature*, *171*(4356), 737–738. https://doi.org/10.1038/171737a0",
    );
    expect(formatInText(watson, "apa", "he")).toBe("(Watson ו-Crick, 1953)");
    const three: CitationRecord = { type: "book", authors: [{ family: "כהן", given: "דנה" }, { family: "לוי", given: "רון" }, { family: "מזרחי", given: "שי" }], year: "2020", title: "ספר", publisher: "הוצאה" };
    expect(formatInText(three, "apa", "he")).toBe("(כהן ואחרים, 2020)");
    expect(runsToMarkdown(formatReference(three, "apa", "he"))).toBe("כהן, ד., לוי, ר. ומזרחי, ש. (2020). *ספר*. הוצאה.");
    expect(runsToMarkdown(formatReference(three, "mla", "he"))).toBe("כהן, דנה, ואחרים. *ספר*. הוצאה, 2020.");
  });
});

describe("the rules", () => {
  it("initials, names, sentence case", () => {
    expect(initials("Alan M.")).toBe("A. M.");
    expect(initials("H. G.")).toBe("H. G.");
    expect(initials("Jean-Paul")).toBe("J.-P.");
    expect(parseNames("Watson, James D. and Francis H. C. Crick and {World Health Organization} and Ludwig van Beethoven and King, Jr., Martin Luther")).toEqual([
      { family: "Watson", given: "James D." },
      { family: "Crick", given: "Francis H. C." },
      { family: "World Health Organization" },
      { family: "van Beethoven", given: "Ludwig" },
      { family: "King", suffix: "Jr.", given: "Martin Luther" },
    ]);
    expect(sentenceCase("Molecular Structure of Nucleic Acids: A Structure for {DNA} in {Wonderland}")).toBe("Molecular structure of nucleic acids: A structure for DNA in Wonderland");
    expect(sentenceCase("Deep Learning with GPUs")).toBe("Deep learning with GPUs");
  });

  it("page ranges: Chicago 9.61 and MLA", () => {
    const cases: Array<[string, string, string]> = [
      ["737--738", "737–38", "737–38"],
      ["891–921", "891–921", "891–921"],
      ["230-265", "230–65", "230–65"],
      ["3–47", "3–47", "3–47"],
      ["101–108", "101–8", "101–08"],
      ["1103–1104", "1103–4", "1103–04"],
      ["1496–1500", "1496–500", "1496–500"],
      ["100–104", "100–104", "100–04"],
      ["321–328", "321–28", "321–28"],
      ["xii", "xii", "xii"],
    ];
    for (const [p, chicago, mla] of cases) {
      expect(pageRange(p, "chicago"), p).toBe(chicago);
      expect(pageRange(p, "mla"), p).toBe(mla);
    }
  });

  it("MLA publishers drop business words and shorten University Press", () => {
    expect(mlaPublisher("Oxford University Press")).toBe("Oxford UP");
    expect(mlaPublisher("University of Illinois Press")).toBe("U of Illinois P");
    expect(mlaPublisher("Smith, Elder & Co.")).toBe("Smith, Elder");
    expect(mlaPublisher("Archibald Constable and Company")).toBe("Archibald Constable");
    expect(mlaPublisher("Harper & Brothers")).toBe("Harper & Brothers");
  });

  it("reads a BibTeX entry: names, en dash, DOI, container", () => {
    const [e] = parseBibtex(dev.items.find((i) => i.record.type === "article")?.expected.bibtex ?? "@article{x,\n  author = {Einstein, Albert},\n  title = {{T}},\n  journal = {J},\n  volume = {1},\n  pages = {1--2},\n  year = {1905}\n}");
    const r = recordFromBibtex(e);
    expect(r.type).toBe("article");
    expect(r.authors[0].family).toBeTruthy();
    expect(r.pages).toMatch(/^\d+(–\d+)?$/);
    expect(r.container).toBeTruthy();

    const [book] = parseBibtex("@book{austen1813pride,\n  author = {Austen, Jane},\n  title = {Pride and {Prejudice}},\n  year = {1813},\n  publisher = {T. Egerton}\n}");
    const rb = recordFromBibtex(book);
    expect(runsToMarkdown(formatReference(rb, "apa"))).toBe("Austen, J. (1813). *Pride and Prejudice*. T. Egerton.");
    expect(runsToMarkdown(formatReference(rb, "mla"))).toBe("Austen, Jane. *Pride and Prejudice*. T. Egerton, 1813.");
  });
});
