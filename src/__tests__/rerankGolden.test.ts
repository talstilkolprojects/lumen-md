/**
 * Plan 7.6 — the reranker, measured on the retrieval golden set's dev split
 * (7.1, HeQ). The model reranker (bge-reranker-v2-m3, ~570 MB) can't run in
 * the unit tests; it is measured by `npm run eval:rerank`
 * (src/agents/eval/rerank.eval.ts). Here: BM25 alone against the default
 * (lexical) reranker over the same candidates, and the decision rule.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Bm25Index } from "../search/bm25";
import { modelRerankSupported, rerank } from "../ai/reranker";
// @ts-expect-error the harness is plain JavaScript
import { compareRerank, rerankDecision, MIN_GAIN_POINTS } from "../../scripts/golden/evals/rerank.mjs";

const heq = JSON.parse(readFileSync(join(__dirname, "../../eval/golden/retrieval/dev/heq.json"), "utf8")) as {
  items: Array<{ id: string; query: string; relevant: string[]; sameArticle?: string[] }>;
  corpus: Array<{ id: string; title: string; text: string }>;
};

describe("reranker on the HeQ dev split (7.6)", () => {
  it("BM25 alone is already at the ceiling there, and the default reranker keeps it", async () => {
    const res = await compareRerank(Bm25Index, (q: string, docs: Array<{ id: string; text: string }>) => rerank(q, docs, { mode: "lexical" }), {
      items: heq.items,
      documents: heq.corpus,
      candidates: 20,
    });
    // Measured on this split (12 queries, 238 paragraphs): 1.0000 and 1.0000.
    expect(res.items).toBe(12);
    expect(res.bm25).toBe(1);
    expect(res.reranked).toBeGreaterThanOrEqual(res.bm25 - 0.01);
    // With BM25 at 1.0 no reranker can add 5 points on this part.
    expect(rerankDecision(res.gain)).toBe("off-by-default");
  });

  it("the decision rule follows the plan: ≥ 5 points keeps the model (WebGPU / desktop, with consent)", () => {
    expect(MIN_GAIN_POINTS).toBe(5);
    expect(rerankDecision(5)).toBe("keep-webgpu-desktop-with-consent");
    expect(rerankDecision(4.99)).toBe("off-by-default");
  });

  it("the model is offered only on WebGPU or the desktop app", () => {
    expect(modelRerankSupported()).toBe(false);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(modelRerankSupported()).toBe(true);
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    Object.defineProperty(navigator, "gpu", { configurable: true, value: {} });
    expect(modelRerankSupported()).toBe(true);
    delete (navigator as unknown as Record<string, unknown>).gpu;
  });
});
