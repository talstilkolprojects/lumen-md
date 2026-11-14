/**
 * Plan W2.16 — Zotero-level citations: pandoc `[@key, p. 10]` with
 * locators, the four styles (the 6.13 three and the Israeli APA), the
 * reference list, the library (BibTeX, CSL-JSON, Zotero's CSL-JSON) and its
 * search, and the whole note expanded for the preview and DOCX / PDF.
 */
import { describe, it, expect } from "vitest";
import { inflateRawSync } from "node:zlib";
// @ts-expect-error — plain .mjs module without types
import { RECORDS } from "../../scripts/golden/sets/small/citations.mjs";
import { formatInText, runsToMarkdown, type CitationRecord } from "../data/citationStyles";
import { findCitations, parseBracket, parseLocator, type Cluster } from "../citations/pandoc";
import { bibliography, formatCluster, locatorText, yearSuffixes, type Style } from "../citations/cite";
import { cslToRecord, keyFromNote } from "../citations/csl";
import { baseKey, isKey, uniqueKey } from "../citations/keys";
import { fromBibtex, fromCslJson, mergeLibrary, searchLibrary } from "../citations/library";
import { expandCitations, mayHaveCitations } from "../citations/expand";
import { zoteroCslItems } from "../citations/zoteroSync";

type Gold = { type: "book" | "article"; authors: Array<[string, string, string?]>; year: number; title: string; titleSentence: string; publisher?: string; journal?: string; volume?: string; issue?: string; pages?: string; doi?: string };
const toRecord = (r: Gold): CitationRecord => ({ type: r.type, authors: r.authors.map(([family, given, suffix]) => ({ family, given, suffix })), year: String(r.year), title: r.title, titleSentence: r.titleSentence, container: r.journal, publisher: r.publisher, volume: r.volume, issue: r.issue, pages: r.pages, doi: r.doi });
const gold = (RECORDS as Gold[]).map((g) => ({ key: `${g.authors[0][0].toLowerCase()}${g.year}`, record: toRecord(g) }));
const lookupOf = (xs: ReadonlyArray<{ key: string; record: CitationRecord }>) => {
  const m = new Map(xs.map((x) => [x.key, x.record]));
  return (k: string) => m.get(k);
};
const cluster = (src: string): Cluster => findCitations(src)[0];
/** W11.H15 puts FSI … PDI around parentheticals in Hebrew output; these assertions are about the visible text. */
const noIso = (s: string) => s.replace(/[\u2068\u2069]/g, "");
const cite = (src: string, style: Style, lang: "en" | "he" = "en", lib = gold) => noIso(formatCluster(cluster(src), { style, lang, lookup: lookupOf(lib), suffix: yearSuffixes(lib, style) }, src));

describe("pandoc syntax (W2.16)", () => {
  it("brackets, several sources, prefix, locator, suffix, suppressed author", () => {
    expect(parseBracket("see @doe2020, pp. 33-35 and passim; -@roe")).toEqual([
      { key: "doe2020", prefix: "see", suffix: "and passim", locator: { label: "page", value: "33–35" }, suppressAuthor: false },
      { key: "roe", prefix: "", suffix: "", locator: null, suppressAuthor: true },
    ]);
    expect(parseLocator(", chap. 3")).toEqual({ locator: { label: "chapter", value: "3" }, suffix: "" });
    expect(parseLocator("עמ׳ 12–14")).toEqual({ locator: { label: "page", value: "12–14" }, suffix: "" });
    expect(parseLocator("10")).toEqual({ locator: { label: "page", value: "10" }, suffix: "" });
    expect(parseLocator("sec. 2.3")).toEqual({ locator: { label: "section", value: "2" }, suffix: ".3" });
  });

  it("finds citations in text, not in code, links or e-mail; in-text @key with a locator", () => {
    const md = "As [@austen1813, p. 10] says, and @darwin1859 [chap. 4] too.\n\n`[@code]` and [link](https://x.org) and me@mail.org\n\n```\n[@fenced]\n```\n[@כהן2020] [@x](u)";
    const cs = findCitations(md);
    expect(cs.map((c) => [md.slice(c.start, c.end), c.inText, c.items.map((i) => i.key)])).toEqual([
      ["[@austen1813, p. 10]", false, ["austen1813"]],
      ["@darwin1859 [chap. 4]", true, ["darwin1859"]],
      ["[@כהן2020]", false, ["כהן2020"]],
    ]);
    expect(mayHaveCitations("no cite here, mail me@x.org")).toBe(false);
    expect(mayHaveCitations("text [@k]")).toBe(true);
  });
});

describe("citations in 3 styles + locators, on the 23 gold records (W2.16 on 6.13)", () => {
  it("without a locator: the same as 6.13's in-text citation, every record, every style, both languages", () => {
    for (const { key, record } of gold)
      for (const style of ["apa", "chicago", "mla"] as const)
        for (const lang of ["en", "he"] as const) expect(cite(`[@${key}]`, style, lang), `${key} ${style} ${lang}`).toBe(formatInText(record, style, lang));
  });

  it("with locators, each style's way", () => {
    expect(cite("[@austen1813, p. 10]", "apa")).toBe("(Austen, 1813, p. 10)");
    expect(cite("[@austen1813, p. 10]", "chicago")).toBe("(Austen 1813, 10)");
    expect(cite("[@austen1813, p. 10]", "mla")).toBe("(Austen 10)");
    expect(cite("[@austen1813, pp. 10-12]", "apa")).toBe("(Austen, 1813, pp. 10–12)");
    expect(cite("[@darwin1859, chap. 4]", "apa")).toBe("(Darwin, 1859, chap. 4)");
    expect(cite("[@darwin1859, chap. 4]", "mla")).toBe("(Darwin ch. 4)");
    expect(cite("[@austen1813, p. 10]", "apa", "he")).toBe("(Austen, 1813, עמ׳ 10)");
    expect(cite("[see @austen1813, p. 10; @watson1953]", "apa")).toBe("(see Austen, 1813, p. 10; Watson & Crick, 1953)");
    expect(cite("[-@austen1813, p. 3]", "apa")).toBe("(1813, p. 3)");
    expect(cite("@watson1953 [p. 737]", "apa")).toBe("Watson and Crick (1953, p. 737)");
    expect(cite("@austen1813", "mla")).toBe("Austen");
    expect(cite("[@nobody2000]", "apa")).toBe("[@nobody2000]");
    expect(locatorText({ label: "volume", value: "2" }, "chicago", "he")).toBe("כרך 2");
  });
});

describe("the Israeli APA (W2.16, decision 15.10)", () => {
  const darshanA: CitationRecord = { type: "book", authors: [{ family: "דרשן", given: "דוד" }], year: "2022", title: "ילד אמיץ, ילד רגיש", publisher: "פסיכולוגיה לעם הוצאה לאור" };
  const darshanB: CitationRecord = { ...darshanA, title: "ילדה חכמה" };
  const nevo: CitationRecord = { type: "book", authors: [{ family: "נבו", given: "אורית" }, { family: "מרום", given: "דנה" }], year: "2023", title: "מחקר", publisher: "הוצאה" };
  const lib = [{ key: "d1", record: darshanA }, { key: "d2", record: darshanB }, { key: "n", record: nevo }, ...gold.slice(0, 3)];

  it("Hebrew sources in Hebrew terms with a geresh and א / ב; English ones in English", () => {
    expect(cite("[@d1]", "il", "he", lib)).toBe("(דרשן, 2022א)");
    expect(cite("[@d2]", "il", "he", lib)).toBe("(דרשן, 2022ב)");
    expect(cite("@d1", "il", "he", lib)).toBe("דרשן (2022א)");
    expect(cite("[@n]", "il", "he", lib)).toBe("(נבו ומרום, 2023)");
    expect(cite("[@austen1813, p. 5]", "il", "he", lib)).toBe("(Austen, 1813, p. 5)");
    const lists = bibliography(lib, { style: "il", lang: "he", suffix: yearSuffixes(lib, "il") });
    expect(lists).toHaveLength(2);
    expect(lists[0].map((e) => noIso(runsToMarkdown(e.runs)))).toEqual([
      "דרשן, ד׳ (2022א). *ילד אמיץ, ילד רגיש*. פסיכולוגיה לעם הוצאה לאור.",
      "דרשן, ד׳ (2022ב). *ילדה חכמה*. פסיכולוגיה לעם הוצאה לאור.",
      "נבו, א׳ ומרום, ד׳ (2023). *מחקר*. הוצאה.",
    ]);
    expect(lists[1].map((e) => e.key)).toEqual(["austen1813", "darwin1859", "melville1851"]);
  });
});

describe("the library (W2.16)", () => {
  it("BibTeX, CSL-JSON and Zotero's CSL-JSON; own keys kept, others made, the first source of a key wins", () => {
    const bib = fromBibtex("@book{austen1813,\n  author = {Austen, Jane},\n  title = {Pride and Prejudice},\n  year = {1813},\n  publisher = {T. Egerton}\n}\n", "refs.bib");
    const csl = fromCslJson(
      JSON.stringify([
        { id: "http://zotero.org/users/local/x/items/ABC", type: "article-journal", title: "על קריאה", author: [{ family: "כהן", given: "דנה" }], issued: { "date-parts": [[2020]] }, "container-title": "עיונים", volume: 3, page: "10-20", language: "he" },
        { id: "k2", type: "book", title: "Second", author: [{ family: "Cohen" }], issued: { "date-parts": [[2020]] }, note: "Citation Key: cohen-second" },
        { id: "k3", type: "book", title: "Pride, again", "citation-key": "austen1813" },
        { id: "x", type: "book" },
      ]),
      ".lumen/zotero-library.csl.json",
      "zotero",
    );
    expect(csl.map((x) => x.key)).toEqual(["כהן2020", "cohen-second", "austen1813"]);
    expect(csl[0].record).toMatchObject({ type: "article", container: "עיונים", volume: "3", pages: "10–20", titleSentence: "על קריאה" });
    const lib = mergeLibrary([csl, bib]);
    expect(lib.find((x) => x.key === "austen1813")!.origin).toBe("bibtex");
    expect(searchLibrary(lib, "כהן").map((x) => x.key)).toEqual(["כהן2020"]);
    expect(searchLibrary(lib, "pride 1813").map((x) => x.key)).toEqual(["austen1813"]);
    expect(searchLibrary(lib, "", ["cohen-second"])[0].key).toBe("cohen-second");
    expect(isKey("כהן2020")).toBe(true);
    expect(isKey("bad key")).toBe(false);
    expect(uniqueKey(baseKey(csl[1].record), new Set(["cohen2020"]))).toBe("cohen2020a");
    expect(keyFromNote("Extra line\nCitation Key: smith2001")).toBe("smith2001");
    expect(cslToRecord({ id: 1, title: "T", issued: { raw: "Spring 1999" } }).year).toBe("1999");
  });

  it("Zotero: every top-level item as CSL-JSON, page by page, notes and attachments left out", async () => {
    const all = Array.from({ length: 205 }, (_, i) => ({ id: `i${i}`, type: i % 50 === 0 ? "note" : "book", title: `T${i}` }));
    const seen: string[] = [];
    const items = await zoteroCslItems(async (path) => {
      seen.push(path);
      const start = Number(new URL(path, "http://127.0.0.1").searchParams.get("start"));
      return { status: 200, total: all.length, body: JSON.stringify(all.slice(start, start + 100)) };
    });
    expect(items).toHaveLength(200);
    expect(seen).toEqual([0, 100, 200].map((s) => `/api/users/0/items/top?format=csljson&limit=100&start=${s}`));
  });
});

describe("a note with citations, expanded (preview, DOCX, PDF) (W2.16)", () => {
  it("style from the frontmatter, references where ::: {#refs} is, unknown keys reported", () => {
    const md = "---\ncitation-style: chicago\n---\n# Essay\n\nAs [@austen1813, p. 10] and @darwin1859 show [@ghost].\n\n## Bibliography\n\n::: {#refs}\n:::\n\nAppendix.";
    const r = expandCitations(md, lookupOf(gold));
    expect(r.style).toBe("chicago");
    expect(r.unknown).toEqual(["ghost"]);
    expect(r.cited).toEqual(["austen1813", "darwin1859"]);
    expect(r.markdown).toContain("As (Austen 1813, 10) and Darwin (1859) show [@ghost].");
    expect(r.markdown).toContain("## References\n\nAusten, Jane. 1813. *Pride and Prejudice*. T. Egerton.\n\nDarwin, Charles. 1859.");
    expect(r.markdown.indexOf("## References")).toBeLessThan(r.markdown.indexOf("Appendix."));
  });

  it("a Hebrew note gets Hebrew terms and headings; il puts Hebrew sources first", () => {
    const he: CitationRecord = { type: "book", authors: [{ family: "דרשן", given: "דוד" }], year: "2022", title: "ילד אמיץ", publisher: "הוצאה" };
    const lib = [...gold, { key: "d", record: he }];
    const r = expandCitations("---\ncitation-style: il\n---\nכפי שנכתב [@d, עמ׳ 4] ו-[@austen1813].", lookupOf(lib));
    expect(r.lang).toBe("he");
    expect(noIso(r.markdown)).toContain("כפי שנכתב (דרשן, 2022, עמ׳ 4) ו-(Austen, 1813).");
    expect(r.markdown).toContain("\u2068(דרשן, 2022, עמ׳ 4)\u2069");
    expect(noIso(r.markdown)).toMatch(/## מקורות\n\n### מקורות בעברית\n\nדרשן, ד׳ \(2022\)\. \*ילד אמיץ\*\. הוצאה\.\n\n### מקורות בשפות אחרות\n\nAusten, J\. \(1813\)\./);
  });

  it("markdown in titles is escaped; a note without citations is unchanged", () => {
    const odd: CitationRecord = { type: "book", authors: [{ family: "Star" }], year: "2001", title: "A *bold* [title]", publisher: "P" };
    const r = expandCitations("x [@s]", (k) => (k === "s" ? odd : undefined));
    expect(r.markdown).toContain("\\[title\\]");
    expect(expandCitations("plain", () => undefined).markdown).toBe("plain");
  });
});

/** word/document.xml of a .docx, through the zip's central directory (deflated or stored). */
function docxText(bytes: Uint8Array): string {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd > 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  let at = dv.getUint32(eocd + 16, true);
  const n = dv.getUint16(eocd + 10, true);
  for (let i = 0; i < n; i++) {
    const method = dv.getUint16(at + 10, true);
    const size = dv.getUint32(at + 20, true);
    const nameLen = dv.getUint16(at + 28, true);
    const extra = dv.getUint16(at + 30, true);
    const comment = dv.getUint16(at + 32, true);
    const local = dv.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    if (name === "word/document.xml") {
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + size);
      return new TextDecoder().decode(method === 8 ? inflateRawSync(data) : data);
    }
    at += 46 + nameLen + extra + comment;
  }
  throw new Error("no word/document.xml");
}

describe("DOCX with the bibliography (W2.16)", () => {
  it("the expanded note becomes a .docx whose text has the citations and the Hebrew and English references", async () => {
    const { markdownToDocxBytes } = await import("../storage/exportDocx");
    const he: CitationRecord = { type: "book", authors: [{ family: "דרשן", given: "דוד" }], year: "2022", title: "ילד אמיץ", publisher: "הוצאה" };
    const lib = [...gold, { key: "d", record: he }];
    const md = expandCitations("---\ncitation-style: il\n---\nכפי שנכתב [@d, עמ׳ 4] ו-[@austen1813].", lookupOf(lib)).markdown;
    const bytes = await markdownToDocxBytes(md);
    const text = noIso(docxText(bytes));
    for (const s of ["(דרשן, 2022, עמ׳ 4)", "מקורות בעברית", "דרשן, ד׳ (2022)", "Austen, J. (1813)", "Pride and prejudice"]) expect(text, s).toContain(s);
  });
});
