/**
 * Plan 7.10 — the small golden sets: the generators' reference rules
 * (formulas, bidi, Hebrew dates, citations, PDF) and the committed dev
 * items' own consistency (offsets, spans, answers).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
// @ts-expect-error — plain .mjs module without types
import { loadSet } from "../../scripts/lib/golden.mjs";
// @ts-expect-error — plain .mjs module without types
import { bidi, citations, formatApa, formatBibtex, formulas, gematria, hebrewDate, hebrewDates, inText, lineDir, textPdf, unlinkedMentions } from "../../scripts/golden/sets/small.mjs";

type Item = Record<string, unknown> & { id: string };
const golden = join(resolve(__dirname, "../.."), "eval", "golden");
const dev = (set: string): Item[] => loadSet(golden, set).items;
const opts = (part: string, nDev: number, nTest = 0, secret?: string) => ({ set: "t", part, nDev, nTest, secret });

describe("reference rules", () => {
  it("Hebrew numerals and calendar", () => {
    expect(gematria(15)).toBe("ט״ו");
    expect(gematria(16)).toBe("ט״ז");
    expect(gematria(7)).toBe("ז׳");
    expect(gematria(787)).toBe("תשפ״ז");
    expect(hebrewDate("2026-10-18").text).toBe("ז׳ בחשוון תשפ״ז");
    expect(hebrewDate("2024-03-15")).toMatchObject({ day: 5, month: "Adar II", year: 5784 });
    expect(hebrewDate("2026-09-12")).toMatchObject({ day: 1, month: "Tishri", year: 5787 });
  });

  it("line direction: first strong character after Markdown markers", () => {
    expect(lineDir("- [ ] שלום world")).toBe("rtl");
    expect(lineDir("## PDF מצורף")).toBe("ltr");
    expect(lineDir("10:30 😀")).toBe("neutral");
    expect(lineDir("[שלום](https://example.com/a)")).toBe("rtl");
    expect(lineDir("`code` שלום")).toBe("rtl");
    expect(lineDir("‏10:30 PDF")).toBe("rtl");
  });

  it("APA 7 and BibTeX", () => {
    const book = { type: "book", authors: [["Melville", "Herman"]], year: 1851, title: "Moby-Dick; or, The Whale", titleSentence: "Moby-Dick; or, The whale", publisher: "Harper & Brothers" };
    expect(formatApa(book)).toBe("Melville, H. (1851). *Moby-Dick; or, The whale*. Harper & Brothers.");
    expect(inText(book)).toBe("(Melville, 1851)");
    const art = { type: "article", authors: [["Watson", "James D."], ["Crick", "Francis H. C."]], year: 1953, title: "Molecular Structure of Nucleic Acids", titleSentence: "Molecular structure of nucleic acids", journal: "Nature", volume: "171", issue: "4356", pages: "737–738", doi: "10.1038/171737a0" };
    expect(formatApa(art)).toBe("Watson, J. D., & Crick, F. H. C. (1953). Molecular structure of nucleic acids. *Nature*, *171*(4356), 737–738. https://doi.org/10.1038/171737a0");
    expect(inText(art)).toBe("(Watson & Crick, 1953)");
    expect(formatBibtex(art)).toContain("pages = {737--738}");
  });

  it("writes a well-formed, deterministic PDF", () => {
    const a = textPdf("Title", "One (two) three — four.\n\nNext paragraph.", "canary");
    expect(a.equals(textPdf("Title", "One (two) three — four.\n\nNext paragraph.", "canary"))).toBe(true);
    const s = a.toString("latin1");
    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(s).toContain("\\(two\\)");
    const xref = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(xref, xref + 4)).toBe("xref");
  });
});

describe("generators: same seed, same items; test never overlaps dev", () => {
  it.each([
    ["formulas", formulas],
    ["unlinked", unlinkedMentions],
    ["bidi", bidi],
    ["hebrew-dates", hebrewDates],
    ["citations", citations],
  ])("%s", (_, spec) => {
    const pool = spec.pool({});
    const a = spec.select(pool, opts("p", 5, 10, "seed-a"));
    const b = spec.select(pool, opts("p", 5, 10, "seed-a"));
    const c = spec.select(pool, opts("p", 5, 10, "seed-b"));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.dev).toEqual(c.dev); // dev uses the public seed only
    const devIds = new Set(a.dev.map((x: Item) => x.id));
    expect(a.test.some((x: Item) => devIds.has(x.id))).toBe(false);
    expect(a.test.length).toBe(10);
  });
});

describe("the committed dev items are consistent", () => {
  it("spell-en: every edit's offsets point at the wrong word, and undoing them gives the clean sentence", () => {
    for (const it of dev("spell-en") as Array<Item & { noisy: string; clean: string; edits: Array<{ start: number; end: number; wrong: string; right: string }> }>) {
      let fixed = it.noisy;
      for (const e of [...it.edits].reverse()) {
        expect(it.noisy.slice(e.start, e.end)).toBe(e.wrong);
        fixed = fixed.slice(0, e.start) + e.right + fixed.slice(e.end);
      }
      expect(fixed).toBe(it.clean);
    }
  });

  it("unlinked: mention spans are the target titles, never inside links or code", () => {
    for (const it of dev("unlinked") as Array<Item & { text: string; title: string; mentions: Array<{ start: number; end: number; target: string }> }>) {
      for (const m of it.mentions) {
        expect(it.text.slice(m.start, m.end).toLowerCase()).toBe(m.target.toLowerCase());
        expect(m.target).not.toBe(it.title);
        const line = it.text.slice(it.text.lastIndexOf("\n", m.start) + 1, it.text.indexOf("\n", m.end));
        expect(line).not.toMatch(/\[\[|`|https?:/);
      }
    }
  });

  it("pdf-qa: answers are spans of their documents, and the PDFs are there", () => {
    const data = JSON.parse(readFileSync(join(golden, "pdf-qa", "dev", "docs.json"), "utf8"));
    const docs = new Map(data.documents.map((d: { id: string; text: string }) => [d.id, d.text.replace(/\s+/g, " ")]));
    for (const it of data.items) expect(docs.get(it.doc)).toContain(it.answer);
    for (const it of dev("pdf-qa") as Array<Item & { file: string }>) expect(readFileSync(it.file).subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
  });

  it("data-analysis: answers recompute from the committed CSV", () => {
    const data = JSON.parse(readFileSync(join(golden, "data-analysis", "dev", "rose.json"), "utf8"));
    const rows = data.table.csv.trim().split("\n").slice(1).map((l: string) => l.split(","));
    expect(rows).toHaveLength(24);
    for (const it of data.items as Array<{ id: string; answer: number | string }>) {
      const m = /^rose-total-(disease|wounds|other)-(\d{4})$/.exec(it.id);
      if (!m) continue;
      const col = { disease: 2, wounds: 3, other: 4 }[m[1] as "disease" | "wounds" | "other"];
      expect(it.answer).toBe(rows.filter((r: string[]) => r[0].startsWith(m[2])).reduce((a: number, r: string[]) => a + Number(r[col]), 0));
    }
  });

  it("clipper: noise never inside the expected article, and every page carries the canary", () => {
    for (const it of dev("clipper") as Array<Item & { file: string; expected: { paragraphs: string[]; mustExclude: string[] } }>) {
      const html = readFileSync(it.file, "utf8");
      expect(html).toContain("canary GUID");
      const article = it.expected.paragraphs.join("\n");
      for (const n of it.expected.mustExclude) {
        expect(article).not.toContain(n);
      }
      expect(html).toContain(it.expected.paragraphs[0].slice(0, 40).replace(/&/g, "&amp;"));
    }
  });

  it("summarize: every key word occurs in its document", () => {
    for (const it of dev("summarize") as Array<Item & { document: string; keywords: string[] }>) for (const k of it.keywords) expect(it.document.toLowerCase()).toContain(k.toLowerCase());
  });

  it("meetings: an owner slot with nothing committed", () => {
    const m = JSON.parse(readFileSync(join(golden, "meetings", "manifest.json"), "utf8"));
    expect(m.parts).toEqual([expect.objectContaining({ id: "owner", dev: 0, test: 5, status: "owner-pending", owner: "15.11" })]);
    expect(dev("meetings")).toEqual([]);
  });
});
