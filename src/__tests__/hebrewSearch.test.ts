/**
 * Plan W2.11 acceptance on the Hebrew search probe set
 * (eval/probes/hebrew-search.json, written for this repository: dev
 * numbers, not a held-out score) and the HeQ dev split, which must not
 * regress.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Bm25Index } from "../search/bm25";
// @ts-expect-error the harness is plain JavaScript
import { scoreProbe } from "../../scripts/search/hebrew-probe.mjs";
// @ts-expect-error the harness is plain JavaScript
import { scoreWith } from "../../scripts/golden/evals/retrieval.mjs";

const heq = JSON.parse(readFileSync(join(__dirname, "../../eval/golden/retrieval/dev/heq.json"), "utf8"));
const probe = JSON.parse(readFileSync(join(__dirname, "../../eval/probes/hebrew-search.json"), "utf8"));

/**
 * The same probe scored with the BM25 of 5.2 / 7.6 (feat/rerank-library at
 * 44ff3b2c, before W2.11): morphology nDCG@10 0.9004, full/defective
 * pairs 2/30 in the top 10, Hebrew→English 0/5.
 */
const BEFORE = { morph: 0.9004, ktiv: 2, cross: 0 };

describe("Hebrew search with morphology (W2.11)", () => {
  const r = scoreProbe(Bm25Index, probe, heq.corpus) as { morph: number; ktivTop10: number; ktivTotal: number; ktivMissed: string[]; cross: number; crossTotal: number };

  it("morphology queries: nDCG@10 at least 5 points above BM25 of 5.2", () => {
    expect(r.morph).toBeGreaterThanOrEqual(BEFORE.morph + 0.05);
  });

  it("full/defective spelling: 30/30 gold pairs found", () => {
    expect(r.ktivTotal).toBe(30);
    expect(r.ktivMissed).toEqual([]);
    expect(r.ktivTop10).toBeGreaterThan(BEFORE.ktiv);
  });

  it("a Hebrew query finds the English note", () => {
    expect(r.cross).toBe(r.crossTotal);
  });

  it("HeQ dev does not regress (nDCG@10 = 1 before W2.11)", () => {
    const items = heq.items.map((it: object) => ({ ...it, part: "heq" }));
    expect(scoreWith(Bm25Index, { items, corpus: { heq: heq.corpus } })["ndcg@10.heq"]).toBe(1);
  });
});
