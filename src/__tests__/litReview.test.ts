/**
 * Plan W5.12 — the literature-review matrix: values are kept only with a
 * quote verified in its passage and located on its page; the note per
 * paper; the `.base` table (Obsidian Bases YAML); and the probe of five
 * papers through retrieval and a stand-in model that quotes, misquotes or
 * cites the wrong passage. The real model is `npm run eval:lit-review`.
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { bm25Index, bm25Search, chunkPages, type PdfChunk, type PdfPageText } from "../pdf/pdfChatCore";
import { extractPaper, FIELDS, noteName, paperNote, reviewBase, verifyField, type FieldOut, type LitField } from "../research/litReviewCore";
// @ts-expect-error the harness is plain JavaScript
import { scoreLitReview } from "../../scripts/research/score-lit-review.mjs";

interface GoldPaper {
  id: string;
  title: string;
  pages: PdfPageText[];
  gold: Record<LitField["key"], { page: number; phrase: string }>;
}
const probe = JSON.parse(readFileSync(join(__dirname, "../../eval/probes/lit-review.json"), "utf8")) as { papers: GoldPaper[] };

/** Retrieval as the reader does it (BM25 over line chunks; no embeddings here). */
function retriever(pages: PdfPageText[]) {
  const chunks = chunkPages(pages);
  const index = bm25Index(chunks.map((c) => c.text));
  return async (query: string): Promise<PdfChunk[]> => {
    const hits = bm25Search(index, query, 4).map((h) => chunks[h.i]);
    return hits.length ? hits : chunks.slice(0, 4);
  };
}

/** A stand-in model that quotes the gold phrase from whichever passage holds it. */
const quoting = (p: GoldPaper) => async (field: LitField, chunks: PdfChunk[]): Promise<FieldOut> => {
  const want = p.gold[field.key].phrase;
  const i = chunks.findIndex((c) => c.text.replace(/\s+/g, " ").includes(want));
  return i < 0 ? { value: "", citations: [] } : { value: want, citations: [{ source: i + 1, quote: want }] };
};

describe("verification", () => {
  const [chunk] = chunkPages([{ page: 3, text: "Results\nAfter the restricted week, participants recalled\n18 percent fewer word pairs." }]);

  it("keeps a value with a quote found in its passage, on its page and line", () => {
    const r = verifyField("findings", { value: "18% fewer pairs recalled", citations: [{ source: 1, quote: "recalled 18 percent fewer word pairs" }] }, [chunk]);
    expect(r).toEqual({ key: "findings", value: "18% fewer pairs recalled", citations: [{ quote: "recalled 18 percent fewer word pairs", page: 3, line: 2 }], dropped: 0 });
  });

  it("drops a made-up quote, a wrong source and a too-short quote — and then the value", () => {
    const r = verifyField("findings", { value: "They slept better", citations: [{ source: 1, quote: "participants slept better" }, { source: 2, quote: "recalled 18 percent fewer" }, { source: 1, quote: "week" }] }, [chunk]);
    expect(r).toEqual({ key: "findings", value: null, citations: [], dropped: 3 });
  });

  it("an empty answer is no value and no citation", () => {
    expect(verifyField("sample", { value: "", citations: [] }, [chunk])).toEqual({ key: "sample", value: null, citations: [], dropped: 0 });
  });
});

describe("probe: five papers, English and Hebrew", () => {
  it("with a model that quotes correctly: ≥ 85% of fields right, every citation on the right page, 0 values without a citation", async () => {
    const results = [];
    for (const p of probe.papers) results.push({ id: p.id, ...(await extractPaper(`papers/${p.id}.pdf`, p.title, retriever(p.pages), quoting(p))) });
    const s = scoreLitReview(results, probe.papers);
    expect(s.fields).toBe(25);
    expect(s.fieldAccuracy).toBeGreaterThanOrEqual(0.85);
    expect(s.uncited).toBe(0);
    for (const r of results) for (const f of r.fields) for (const c of f.citations) {
      const gold = probe.papers.find((p) => p.id === r.id)!.gold[f.key];
      expect(c.page, `${r.id}.${f.key}`).toBe(gold.page);
    }
  });

  it("with a model that makes things up: nothing is kept", async () => {
    const p = probe.papers[0];
    const r = await extractPaper("papers/p1.pdf", p.title, retriever(p.pages), async () => ({ value: "A large effect", citations: [{ source: 1, quote: "a very large and robust effect was found" }] }));
    expect(r.fields.every((f) => f.value === null)).toBe(true);
    expect(scoreLitReview([{ id: p.id, ...r }], [p]).uncited).toBe(0);
  });

  it("a model error leaves the field empty, the others go on", async () => {
    const p = probe.papers[1];
    let n = 0;
    const r = await extractPaper("papers/p2.pdf", p.title, retriever(p.pages), async (f, chunks) => {
      if (n++ === 0) throw new Error("model down");
      return quoting(p)(f, chunks);
    });
    expect(r.fields[0].value).toBeNull();
    expect(r.fields.slice(1).every((f) => f.value)).toBe(true);
  });
});

describe("the outputs", () => {
  it("a note per paper: frontmatter for the table, values with quotes and page links", async () => {
    const p = probe.papers[0];
    const r = await extractPaper("papers/p1.pdf", p.title, retriever(p.pages), quoting(p));
    const note = paperNote(r, { date: new Date("2026-11-12") });
    const fm = parse(note.split("---")[1]);
    expect(fm).toMatchObject({ "lit-pdf": "[[papers/p1.pdf]]", "lit-verified": 5, "lit-complete": true, "lit-extracted": "2026-11-12", tags: ["literature-review"] });
    expect(fm["lit-sample"]).toBe("64 adolescents aged 15 to 18");
    expect(note).toContain("> “64 adolescents aged 15 to 18” — [[papers/p1.pdf#page=2|p. 2, line 4]]");
  });

  it("an unverified field is null in the frontmatter and said so in the note", () => {
    const note = paperNote({ pdf: "a.pdf", title: "A", fields: FIELDS.map((f) => ({ key: f.key, value: null, citations: [], dropped: 1 })) });
    const fm = parse(note.split("---")[1]);
    expect(fm["lit-findings"]).toBeNull();
    expect(fm["lit-complete"]).toBe(false);
    expect(note).toContain("_No value with a verified quote._");
  });

  it("the .base is valid Bases YAML: the folder, one column per field, a 'Verified only' view", () => {
    const b = parse(reviewBase("Literature review"));
    expect(b.filters.and).toEqual(['file.inFolder("Literature review")', 'file.hasTag("literature-review")']);
    expect(Object.keys(b.properties)).toEqual([...FIELDS.map((f) => `note.lit-${f.key}`), "note.lit-verified"]);
    expect(b.views.map((v: { name: string }) => v.name)).toEqual(["All papers", "Verified only"]);
    expect(b.views[1].filters.and).toEqual(["note.lit-complete == true"]);
    expect(b.views[0].order[0]).toBe("file.name");
  });

  it("note names are safe file names", () => {
    expect(noteName('A/B: "C"?')).toBe("A B C");
    expect(noteName("שימוש ברשתות חברתיות")).toBe("שימוש ברשתות חברתיות");
  });
});
