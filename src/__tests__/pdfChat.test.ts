/**
 * Plan 6.8 — chat with a PDF on this device: chunks with page and line,
 * BM25 + embeddings fused, quotes located and verified, the answerer
 * through the runtime, and retrieval measured on the 7.10 golden PDFs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));
vi.mock("../ai/ocr", () => ({ ocrImage: vi.fn(async () => ({ text: "", confidence: 0, lang: "en" })) }));
// pdf.js with its worker on the main thread, as under node it must be (see storage/fileFormats.ts).
vi.mock("../pdf/pdfjs", () => ({
  openPdf: async (data: Uint8Array) => {
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
      GlobalWorkerOptions: { workerSrc: string };
      getDocument(o: { data: Uint8Array; isEvalSupported: boolean }): { promise: Promise<unknown>; destroy(): Promise<void> };
    };
    pdfjs.GlobalWorkerOptions.workerSrc = "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
    const task = pdfjs.getDocument({ data, isEvalSupported: false });
    return { doc: await task.promise, close: () => task.destroy() };
  },
}));

import { bm25Index, bm25Search, chunkPages, fuse, locateQuote, tokens, type PdfPageText } from "../pdf/pdfChatCore";
import { __clearPdfIndexes, answerFrom, buildIndex, pdfPages, retrieve } from "../pdf/pdfChat";
import { registerExecutor, resetExecutors } from "../agents/executors";
import { fakeExecutor, sequence } from "./helpers/fakeExecutor";

describe("pdfChatCore", () => {
  it("chunks pages by lines, keeps page and line numbers, and cuts a long line at a sentence end", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const chunks = chunkPages([{ page: 1, text: "Title\nshort line" }, { page: 2, text: `first\n${long}\nlast` }], 300);
    expect(chunks[0]).toMatchObject({ page: 1, lineStart: 1, lineEnd: 2, text: "Title\nshort line" });
    const p2 = chunks.filter((c) => c.page === 2);
    expect(p2.length).toBeGreaterThan(3);
    expect(p2.every((c) => c.text.length <= 300 + 40)).toBe(true);
    expect(p2[0].lineStart).toBe(1);
    expect(p2[p2.length - 1].lineEnd).toBe(3);
    // Pieces end on sentence ends, not mid-word.
    expect(p2.slice(1, -1).every((c) => /\.$/.test(c.text.trim()))).toBe(true);
  });

  it("tokenises Hebrew without niqqud and one-letter prefixes, English with a light stem", () => {
    expect(tokens("וְהַבַּיִת הגדול של משה")).toEqual(["בית", "גדול", "משה"]);
    expect(tokens("The soldiers were discharged")).toEqual(["soldier", "discharg"]);
  });

  it("BM25 ranks the passage with the rare words first; fusion keeps what both lists agree on", () => {
    const idx = bm25Index(["the weather in Paris", "Congress met in Philadelphia last session", "bees and honey"]);
    expect(bm25Search(idx, "Where did Congress meet?")[0].i).toBe(1);
    expect(bm25Search(idx, "nothing matches xyzzy")).toEqual([]);
    expect(fuse([[1, 0, 2], [1, 2]], 60, 2)).toEqual([1, 2]);
  });

  it("locates a quote on its page and line, across line breaks and spacing", () => {
    const [chunk] = chunkPages([{ page: 4, text: "one two\nthree four five\nsix seven" }]);
    expect(locateQuote("four   five six", chunk)).toEqual({ page: 4, line: 2 });
    expect(locateQuote("one", chunk)).toEqual({ page: 4, line: 1 });
    expect(locateQuote("not in it", chunk)).toBeNull();
  });
});

const GOLDEN = join(__dirname, "../../eval/golden/pdf-qa/dev");
const golden = JSON.parse(readFileSync(join(GOLDEN, "docs.json"), "utf8")) as {
  items: Array<{ id: string; doc: string; file: string; question: string; answer: string; alt: string[] }>;
  documents: Array<{ id: string; title: string; file: string }>;
};
const squash = (s: string) => s.replace(/\s+/g, " ").toLowerCase();

describe("retrieval on the golden PDFs (7.10 pdf-qa, dev)", () => {
  const pagesOf = new Map<string, PdfPageText[]>();
  beforeEach(async () => {
    if (pagesOf.size) return;
    for (const d of golden.documents) pagesOf.set(d.id, await pdfPages(new Uint8Array(readFileSync(join(GOLDEN, d.file)))));
  }, 60_000);

  it("reads every page's text with pdf.js", () => {
    for (const d of golden.documents) {
      const pages = pagesOf.get(d.id)!;
      expect(pages.length, d.id).toBeGreaterThan(0);
      expect(pages.every((p) => p.text.trim().length > 20 && !p.ocr), d.id).toBe(true);
    }
  });

  it("the passages handed to the answerer contain the answer for the dev questions", async () => {
    let found = 0;
    const misses: string[] = [];
    for (const item of golden.items) {
      __clearPdfIndexes();
      const index = await buildIndex(item.file, "", pagesOf.get(item.doc)!, null);
      const chunks = await retrieve(index, item.question);
      const want = [item.answer, ...item.alt].map(squash);
      if (chunks.some((c) => want.some((a) => squash(c.text).includes(a)))) found++;
      else misses.push(item.id);
    }
    // Measured, not assumed: the number goes to the log; the floor guards regressions.
    console.info(`pdf-qa dev: answer in the retrieved passages for ${found}/${golden.items.length} (misses: ${misses.join(", ") || "none"})`);
    expect(found / golden.items.length).toBeGreaterThanOrEqual(0.75);
  }, 60_000);
});

describe("answerFrom", () => {
  const pages: PdfPageText[] = [
    { page: 1, text: "Report of the year\nThe Congress met in Philadelphia.\nIt then moved to the new city of Washington." },
    { page: 2, text: "The soldiers of the temporary army\nwere discharged in the spring." },
  ];
  beforeEach(() => {
    localStorage.clear();
    resetExecutors();
    __clearPdfIndexes();
  });

  it("returns the answer with verified citations on their page and line; a made-up quote is dropped", async () => {
    const ex = fakeExecutor(
      sequence(JSON.stringify({ answer: "They were discharged.", citations: [{ source: 1, quote: "were discharged in the spring" }, { source: 1, quote: "they were sent home with medals" }] })),
    );
    registerExecutor(ex);
    const index = await buildIndex("reports/year.pdf", "", pages, null);
    const res = await answerFrom(index, "What happened to the soldiers of the temporary army?");
    expect(res.answer).toBe("They were discharged.");
    expect(res.citations).toEqual([{ source: 1, quote: "were discharged in the spring", page: 2, line: 2 }]);
    expect(res.dropped).toBe(1);
    expect(res.notFound).toBe(false);
    // The passages went to the model with their page and line numbers.
    expect(JSON.stringify(ex.calls[0].messages)).toContain("(page 2, lines 1–2)");
  });

  it("an answer without a verified quote is sent back once with the reason", async () => {
    const ex = fakeExecutor(
      sequence(
        JSON.stringify({ answer: "Philadelphia", citations: [{ source: 1, quote: "Congress gathered in Philly" }] }),
        JSON.stringify({ answer: "Philadelphia", citations: [{ source: 1, quote: "The Congress met in Philadelphia." }] }),
      ),
    );
    registerExecutor(ex);
    const index = await buildIndex("reports/year.pdf", "", pages, null);
    const res = await answerFrom(index, "In which city did Congress meet?");
    expect(ex.calls).toHaveLength(2);
    expect(JSON.stringify(ex.calls[1].messages)).toContain("no citation quotes its passage");
    expect(res.citations).toEqual([{ source: 1, quote: "The Congress met in Philadelphia.", page: 1, line: 2 }]);
  });

  it("says so when the PDF doesn't answer", async () => {
    registerExecutor(fakeExecutor(sequence(JSON.stringify({ answer: "", citations: [] }))));
    const index = await buildIndex("reports/year.pdf", "", pages, null);
    const res = await answerFrom(index, "What is the airspeed of a swallow?");
    expect(res).toMatchObject({ notFound: true, citations: [] });
  });

  it("fuses embeddings with BM25 when an embedder is there", async () => {
    // A toy embedder: one dimension per page topic.
    const embed = async (texts: string[]) => texts.map((t) => Float32Array.from([/congress|city|philadelphia/i.test(t) ? 1 : 0, /soldier|army|discharg/i.test(t) ? 1 : 0]));
    const index = await buildIndex("reports/year.pdf", "", pages, embed);
    expect(index.vectors).toHaveLength(index.chunks.length);
    const chunks = await retrieve(index, "Which city hosted Congress?", 1);
    expect(chunks[0].page).toBe(1);
  });
});
