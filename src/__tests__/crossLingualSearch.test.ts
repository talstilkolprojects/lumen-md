/**
 * Plan W5.28 — cross-language search: when a hit is in another language
 * than the question, which embedding models can bridge Hebrew and English,
 * the ranking a 10,000-note vault needs within the latency budget, the
 * local-only translation next to the original, and the dev probe scored
 * with BM25 alone (the real-model number is `npm run eval:crosslingual`).
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fuse, isMultilingualEmbedding, markCrossLingual, rankByCosine, scriptOf } from "../search/crossLingual";
import { __resetTranslators, registerLocalTranslator, translatePassage } from "../search/passageTranslator";
import { Bm25Index } from "../search/bm25";
// @ts-expect-error the harness is plain JavaScript
import { scoreCrossLingual } from "../../scripts/search/crosslingual-eval.mjs";

const probe = JSON.parse(readFileSync(join(__dirname, "../../eval/probes/crosslingual-he-en.json"), "utf8")) as { items: Array<{ id: string; query: string; relevant: string[] }>; corpus: Array<{ id: string; text: string }> };
const registry = JSON.parse(readFileSync(join(__dirname, "../../models/registry.json"), "utf8")) as { models: Array<{ id: string; class: string; license: string }> };

describe("languages", () => {
  it("tells Hebrew from English text, by letters", () => {
    expect(scriptOf("מה השפעת שינה על הזיכרון?")).toBe("he");
    expect(scriptOf("Sleep restriction and memory")).toBe("en");
    expect(scriptOf("שינה (sleep) וזיכרון")).toBe("he");
    expect(scriptOf("2024 — 17%")).toBe("other");
  });

  it("marks hits in another language than the question", () => {
    const m = markCrossLingual("שינה וזיכרון", [{ snippet: "Sleep and memory" }, { snippet: "שינה טובה" }, { snippet: "1234" }]);
    expect(m.map((h) => h.crossLingual)).toEqual([true, false, false]);
  });

  it("only multilingual embeddings bridge Hebrew and English; the default one is allowed in the registry", () => {
    expect(isMultilingualEmbedding("transformers:Xenova/multilingual-e5-small")).toBe(true);
    expect(isMultilingualEmbedding("ollama:nomic-embed-text")).toBe(false);
    expect(isMultilingualEmbedding("openai:text-embedding-3-small")).toBe(false);
    const e5 = registry.models.find((m) => m.id === "Xenova/multilingual-e5-small")!;
    expect(e5).toMatchObject({ class: "allowed", license: "MIT" });
  });
});

describe("ranking", () => {
  it("cosine top-k and reciprocal-rank fusion", () => {
    const docs = [
      { id: "a", vector: Float32Array.from([1, 0]) },
      { id: "b", vector: Float32Array.from([0.8, 0.6]) },
      { id: "c", vector: Float32Array.from([0, 1]) },
    ];
    expect(rankByCosine(Float32Array.from([1, 0.1]), docs, 2).map((h) => h.id)).toEqual(["a", "b"]);
    expect(rankByCosine(Float32Array.from([1, 0.1]), docs, 2, new Set(["a"])).map((h) => h.id)).toEqual(["b", "c"]);
    expect(fuse([{ ids: ["x", "y"] }, { ids: ["y", "z"], weight: 1.2 }], 3)).toEqual(["y", "z", "x"]);
  });

  it("ranks 10,000 notes of 384-dim vectors within the 200 ms budget (the query embedding is extra)", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) - 0.5;
    const docs = Array.from({ length: 10_000 }, (_, i) => ({ id: `n${i}`, vector: Float32Array.from({ length: 384 }, rnd) }));
    const q = Float32Array.from({ length: 384 }, rnd);
    rankByCosine(q, docs, 10); // warm up the JIT
    const t0 = performance.now();
    const top = rankByCosine(q, docs, 10);
    const ms = performance.now() - t0;
    expect(top).toHaveLength(10);
    expect(ms).toBeLessThan(200);
  });
});

describe("local translation next to the original", () => {
  beforeEach(() => __resetTranslators());

  it("uses a registered local engine (6.4) first", async () => {
    const off = registerLocalTranslator("opus-mt", async (t, from, to) => `[${from}>${to}] ${t}`);
    expect(await translatePassage("Sleep and memory", "en", "he")).toEqual({ text: "[en>he] Sleep and memory", engine: "opus-mt" });
    off();
  });

  it("uses the browser's on-device translator only for a pair already on the device", async () => {
    const created: string[] = [];
    const Translator = {
      availability: async ({ targetLanguage }: { targetLanguage: string }) => (targetLanguage === "he" ? "available" : "downloadable"),
      create: async (o: { sourceLanguage: string; targetLanguage: string }) => (created.push(`${o.sourceLanguage}>${o.targetLanguage}`), { translate: async (t: string) => `HE(${t})` }),
    } as never;
    expect(await translatePassage("Sleep", "en", "he", { globals: { Translator } })).toEqual({ text: "HE(Sleep)", engine: "browser" });
    // "downloadable" would start a download from a search: not used.
    expect(await translatePassage("Sleep", "en", "fr", { globals: { Translator } })).toEqual({ text: null, engine: null });
    expect(created).toEqual(["en>he"]);
  });

  it("with no local translator, nothing is translated (and nothing is sent)", async () => {
    const calls: string[] = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (u: string) => (calls.push(String(u)), new Response(""))) as typeof fetch;
    try {
      expect(await translatePassage("Sleep", "en", "he", { globals: {} })).toEqual({ text: null, engine: null });
    } finally {
      globalThis.fetch = saved;
    }
    expect(calls).toEqual([]);
  });
});

describe("dev probe: 50 Hebrew questions over English abstracts", () => {
  it("is well-formed: 50 questions, one relevant abstract each, all in the corpus", () => {
    expect(probe.items).toHaveLength(50);
    expect(probe.corpus).toHaveLength(50);
    const ids = new Set(probe.corpus.map((d) => d.id));
    for (const it of probe.items) {
      expect(scriptOf(it.query), it.id).toBe("he");
      expect(it.relevant.every((r) => ids.has(r)), it.id).toBe(true);
    }
    for (const d of probe.corpus) expect(scriptOf(d.text), d.id).toBe("en");
  });

  it("BM25 alone (W2.11's lexicon) is the baseline the model has to beat", async () => {
    const index = new Bm25Index();
    for (const d of probe.corpus) index.set(d.id, d.text, "");
    const r = await scoreCrossLingual((q: string) => index.search(q, { limit: 10 }).map((h) => h.id), probe);
    // A lexicon of common words reaches only a few research questions: this is why W5.28 needs embeddings.
    expect(r.items).toBe(50);
    expect(r.ndcg10).toBeLessThan(0.8);
    // Recorded for the PR: the number this run measured.
    expect(typeof r.ndcg10).toBe("number");
  });
});
