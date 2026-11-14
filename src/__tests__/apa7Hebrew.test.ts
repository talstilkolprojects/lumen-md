/**
 * W11.H15 — Hebrew APA 7 by the Bar-Ilan and Haifa library guides, with our
 * own templates (no citeproc): no comma before the last author's ו,
 * "ואחרים", Hebrew list first, and FSI … PDI around every parenthetical in
 * a right-to-left document.
 *
 * The examples are transcribed from the guides (fixtures/apa7-he-guides.json,
 * a source per entry). Only 8 could be transcribed completely here; the
 * acceptance (≥ 38/40 identical) needs the remaining entries from the full
 * guides (owed).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { bibliography, formatCluster, isolateParentheticals, yearSuffixes, type CiteContext } from "../citations/cite";
import { cslToRecord } from "../citations/csl";
import { runsToMarkdown, type CitationRecord } from "../data/citationStyles";
import type { CiteItem, Cluster } from "../citations/pandoc";

type Example = { id: string; source: string; kind: "reference" | "parenthetical" | "narrative"; record: CitationRecord; expected: string; note?: string };
const guide = JSON.parse(readFileSync("src/__tests__/fixtures/apa7-he-guides.json", "utf8")) as { examples: Example[] };

const FSI = "⁨";
const PDI = "⁩";
/** The fixture's normalisation: isolates and italics out, one initial mark, one apostrophe. */
function norm(s: string): string {
  return s
    .replace(/[⁨⁩]/g, "")
    .replace(/\*/g, "")
    .replace(/([א-ת])[׳'.](?=[\s,)]|$)/g, "$1׳")
    .replace(/[’]/g, "'");
}

function render(e: Example): string {
  const lib = [{ key: "k", record: e.record }];
  const suffix = yearSuffixes(lib, "il");
  if (e.kind === "reference") return runsToMarkdown(bibliography(lib, { style: "il", lang: "he", suffix })[0][0].runs);
  const ctx: CiteContext = { style: "il", lang: "he", lookup: () => e.record, suffix };
  const item: CiteItem = { key: "k", prefix: "", suffix: "", suppressAuthor: false, locator: null } as CiteItem;
  return formatCluster({ inText: e.kind === "narrative", items: [item] } as unknown as Cluster, ctx, "?");
}

describe("examples from the Bar-Ilan and Haifa guides", () => {
  const results = guide.examples.map((e) => ({ e, got: render(e), ok: norm(render(e)) === norm(e.expected) }));
  it("every example has a source and an expectation", () => {
    for (const e of guide.examples) {
      expect(["biu", "haifa"]).toContain(e.source);
      expect(e.expected.length).toBeGreaterThan(5);
    }
  });
  for (const { e, got, ok } of results) {
    it(`${e.id}${e.note ? " (guide quirk noted)" : ""}`, () => {
      if (e.note && !ok) return; // why: a known inconsistency inside the guide, counted as a miss below, not hidden
      expect(norm(got)).toBe(norm(e.expected));
    });
  }
  it("the score is reported, and the guide-consistent examples all match", () => {
    const matched = results.filter((r) => r.ok).length;
    // Today: 8 transcribed, 6 identical; the 2 misses are the guide quirks noted in the fixture.
    expect(results.filter((r) => !r.ok).map((r) => r.e.id)).toEqual(["biu-book-2", "haifa-book-1"]);
    expect(matched).toBe(6);
  });
});

describe("the rules the guides state", () => {
  const he = (family: string, given: string) => ({ family, given });
  const rec = (authors: CitationRecord["authors"]): CitationRecord => ({ type: "book", authors, year: "2020", title: "ספר", publisher: "הוצאה" });
  const ref = (r: CitationRecord) => runsToMarkdown(bibliography([{ key: "k", record: r }], { style: "il", lang: "he", suffix: new Map() })[0][0].runs).replace(/[⁨⁩]/g, "");
  it("no comma before the ו of the last Hebrew author (two and five authors)", () => {
    // Before W11.H15 these read "כהן, א׳, ולוי, ב׳" — against both guides.
    expect(ref(rec([he("כהן", "א"), he("לוי", "ב")]))).toBe("כהן, א׳ ולוי, ב׳ (2020). *ספר*. הוצאה.");
    expect(ref(rec([he("לוין", "נ"), he("לוצאטו", "א"), he("מינץ", "ר"), he("יצחקי", "ח"), he("אילן", "א")]))).toBe("לוין, נ׳, לוצאטו, א׳, מינץ, ר׳, יצחקי, ח׳ ואילן, א׳ (2020). *ספר*. הוצאה.");
  });
  it("English sources keep APA's serial comma and &, in their own list after the Hebrew one", () => {
    const lib = [
      { key: "e", record: { type: "book", authors: [{ family: "Smith", given: "John" }, { family: "Doe", given: "Jane" }], year: "2019", title: "A book", publisher: "Pub" } as CitationRecord },
      { key: "h", record: rec([he("כהן", "א")]) },
    ];
    const lists = bibliography(lib, { style: "il", lang: "he", suffix: new Map() });
    expect(lists.map((l) => l.map((x) => x.key))).toEqual([["h"], ["e"]]);
    expect(runsToMarkdown(lists[1][0].runs)).toBe("Smith, J., & Doe, J. (2019). *A book*. Pub.");
  });
});

describe("FSI … PDI around parentheticals in right-to-left output", () => {
  it("wraps each top-level balanced parenthetical once, and leaves unbalanced brackets alone", () => {
    expect(isolateParentheticals("א (ב (ג) ד) ה (ו)")).toBe(`א ${FSI}(ב (ג) ד)${PDI} ה ${FSI}(ו)${PDI}`);
    expect(isolateParentheticals(isolateParentheticals("(x)"))).toBe(`${FSI}(x)${PDI}`);
    expect(isolateParentheticals("(open")).toBe("(open");
  });
  it("an English citation inside a Hebrew document is an isolate; an English document gets none", () => {
    const austen: CitationRecord = { type: "book", authors: [{ family: "Austen", given: "Jane" }], year: "1813", title: "Pride and Prejudice", publisher: "T. Egerton" };
    const item = { key: "a", prefix: "", suffix: "", suppressAuthor: false, locator: null } as CiteItem;
    const cl = { inText: false, items: [item] } as unknown as Cluster;
    expect(formatCluster(cl, { style: "il", lang: "he", lookup: () => austen, suffix: new Map() }, "?")).toBe(`${FSI}(Austen, 1813)${PDI}`);
    expect(formatCluster(cl, { style: "apa", lang: "en", lookup: () => austen, suffix: new Map() }, "?")).toBe("(Austen, 1813)");
    const lists = bibliography([{ key: "a", record: austen }], { style: "il", lang: "he", suffix: new Map() });
    expect(runsToMarkdown(lists[0][0].runs)).not.toContain(FSI); // the English list stays as it is
  });
  it("a Hebrew reference's year and page parentheticals are isolates", () => {
    const r: CitationRecord = { type: "chapter", authors: [{ family: "שמיר", given: "יעל" }], editors: [{ family: "פרידמן", given: "עמי" }], year: "2015", title: "חינוך", container: "ספר", publisher: "מאגנס", pages: "100–120" };
    const md = runsToMarkdown(bibliography([{ key: "c", record: r }], { style: "il", lang: "he", suffix: new Map() })[0][0].runs);
    expect(md).toBe(`שמיר, י׳ ${FSI}(2015)${PDI}. חינוך. בתוך ע׳ פרידמן ${FSI}(עורך)${PDI}, *ספר* ${FSI}(עמ׳ 100–120)${PDI}. מאגנס.`);
  });
});

describe("input: CSL-JSON (W2.16, Zotero sync W5.23)", () => {
  it("a Zotero CSL-JSON item with Hebrew authors is formatted by the same rules", () => {
    const r = cslToRecord({ id: "x", type: "book", title: "אימוץ: מסע להורות חדשה", author: [{ family: "דיאמונד", given: "ג" }, { family: "ארבל", given: "א" }], issued: { "date-parts": [[2009]] }, publisher: "הקיבוץ המאוחד" });
    const md = runsToMarkdown(bibliography([{ key: "x", record: r }], { style: "il", lang: "he", suffix: new Map() })[0][0].runs);
    expect(norm(md)).toBe(norm("דיאמונד, ג. וארבל, א. (2009). אימוץ: מסע להורות חדשה. הקיבוץ המאוחד."));
  });
});
