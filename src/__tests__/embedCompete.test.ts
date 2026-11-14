/**
 * Plan W7.13 — the Hebrew embeddings / reranker competition harness: the
 * hard set's rewrites, the metrics, Matryoshka truncation and the plan's
 * decision rules. The real models run in src/agents/eval/embedCompete.eval.ts
 * (owner step: the downloads).
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error the harness is plain JavaScript
import { ACRONYMS, buildHard, hardenQuery, KINDS } from "../../scripts/golden/sets/retrieval-hard.mjs";
// @ts-expect-error the harness is plain JavaScript
import { chooseDefault, discriminates, evaluateCandidate, recallAt, rerankDecision, truncateMatryoshka } from "../../scripts/golden/evals/embed-compete.mjs";

const heq = JSON.parse(readFileSync(join(__dirname, "../../eval/golden/retrieval/dev/heq.json"), "utf8")) as { items: Array<{ id: string; query: string; relevant: string[]; heqId: string }>; corpus: Array<{ id: string; title?: string; text: string }> };

describe("the hard set", () => {
  it("rewrites each question, deterministically, in the kind asked when it applies", () => {
    expect(hardenQuery("מה עשה צה״ל בשנת 1948?", "acronym", "s")).toEqual({ query: "מה עשה צבא ההגנה לישראל בשנת 1948?", kind: "acronym" });
    expect(hardenQuery("מי בנה את המחשב הראשון?", "loanword", "s")).toEqual({ query: "מי בנה את הקומפיוטר הראשון?", kind: "loanword" });
    expect(hardenQuery("מתי נולד המשורר?", "paraphrase", "s").query).toBe("באיזו שנה נולד המשורר?");
    for (const it of heq.items) {
      for (const k of KINDS) {
        const a = hardenQuery(it.query, k, "seed");
        expect(a.query, `${k}: ${it.query}`).not.toBe(it.query);
        expect(hardenQuery(it.query, k, "seed")).toEqual(a);
      }
    }
    expect(ACRONYMS.every(([a]: string[]) => /״|׳/.test(a))).toBe(true);
  });

  it("builds n items from the pool, never a question retrieval/heq uses, split 70 / 30", () => {
    const pool = {
      items: heq.corpus.slice(0, 120).map((d, i) => ({ id: d.id, sameArticle: [], qas: [{ id: `q${i}a`, question: `מתי נבנה המקום ${d.title ?? ""}?` }, { id: `q${i}b`, question: `איך קראו לעיר הגדולה ${i}?` }] })),
    };
    const { dev, heldout } = buildHard(pool, { n: 200, seed: "x", exclude: new Set(["q0a"]) });
    expect(dev.length + heldout.length).toBe(200);
    expect(heldout.length).toBe(60);
    const all = [...dev, ...heldout];
    expect(all.some((i) => i.heqId === "q0a")).toBe(false);
    expect(new Set(all.map((i) => i.kind)).size).toBeGreaterThanOrEqual(3);
    expect(all.every((i) => i.query !== i.original)).toBe(true);
    expect(buildHard(pool, { n: 200, seed: "x", exclude: new Set(["q0a"]) })).toEqual({ dev, heldout });
  });
});

describe("metrics and Matryoshka", () => {
  it("Recall@20 and a renormalised truncation", () => {
    expect(recallAt(["a", "b", "c"], ["c", "z"], 20)).toBe(0.5);
    const v = truncateMatryoshka([3, 4, 12, 0], 2);
    expect(v[0]).toBeCloseTo(0.6);
    expect(v[1]).toBeCloseTo(0.8);
  });

  it("scores a candidate end to end; a word-overlap model beats a random one on HeQ", async () => {
    const vocab = new Map<string, number>();
    const bag = (t: string) => {
      const v = new Array(512).fill(0);
      for (const w of t.split(/[^א-תa-zA-Z0-9]+/).filter((x) => x.length > 2)) {
        if (!vocab.has(w)) vocab.set(w, vocab.size);
        v[vocab.get(w)! % 512] += 1;
      }
      return v;
    };
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    const set = { items: heq.items, corpus: heq.corpus };
    const good = await evaluateCandidate({ id: "bag", embed: async (ts: string[]) => ts.map(bag) }, set);
    const bad = await evaluateCandidate({ id: "random", embed: async (ts: string[]) => ts.map(() => Array.from({ length: 64 }, rnd)) }, set);
    expect(good.ndcg10).toBeGreaterThan(bad.ndcg10);
    expect(good.items).toBe(heq.items.length);
    expect(good.indexBytes).toBe(heq.corpus.length * 512 * 4);
    expect(discriminates([good, bad])).toBe(true);
    const m256 = await evaluateCandidate({ id: "bag-256", embed: async (ts: string[]) => ts.map(bag), matryoshka: 256 }, set);
    expect(m256.dims).toBe(256);
    expect(m256.indexBytes).toBe(good.indexBytes / 2);
    // A reranker that puts the relevant paragraph first.
    const oracle = await evaluateCandidate({ id: "bag+rr", embed: async (ts: string[]) => ts.map(bag), rerank: async (q: string, docs: Array<{ id: string }>) => [...docs].sort((a, b) => Number(heq.items.find((i) => i.query === q)!.relevant.includes(b.id)) - Number(heq.items.find((i) => i.query === q)!.relevant.includes(a.id))) }, set);
    expect(oracle.ndcg10).toBeGreaterThanOrEqual(good.ndcg10);
  });
});

describe("the plan's rules", () => {
  const r = (id: string, ndcg10: number, msPerQuery = 10) => ({ id, ndcg10, recall20: 0, msPerQuery, dims: 384, indexBytes: 0, items: 90 });
  it("the set discriminates only with a ≥ 5-point spread", () => {
    expect(discriminates([r("a", 0.71), r("b", 0.66)])).toBe(true);
    expect(discriminates([r("a", 0.71), r("b", 0.67)])).toBe(false);
  });

  it("the default changes only for ≥ 5 held-out points and ≤ 150 ms per query at 10,000 notes", () => {
    expect(chooseDefault([r("e5", 0.6), r("gemma", 0.66, 20)], "e5", { notes: 1000 }).id).toBe("e5"); // 200 ms at 10k: too slow
    expect(chooseDefault([r("e5", 0.6), r("gemma", 0.66, 10)], "e5", { notes: 1000 }).id).toBe("gemma");
    expect(chooseDefault([r("e5", 0.6), r("gemma", 0.66, 16)], "e5", { notes: 1000 }).id).toBe("e5");
    expect(chooseDefault([r("e5", 0.6), r("gemma", 0.64)], "e5").id).toBe("e5");
    expect(chooseDefault([r("e5", 0.6), r("gemma", 0.66), r("qwen", 0.7)], "e5").id).toBe("qwen");
  });

  it("the reranker is on only when it adds ≥ 3 points", () => {
    expect(rerankDecision(r("x", 0.73), r("x", 0.7))).toEqual({ on: true, gain: 3 });
    expect(rerankDecision(r("x", 0.72), r("x", 0.7)).on).toBe(false);
  });
});
