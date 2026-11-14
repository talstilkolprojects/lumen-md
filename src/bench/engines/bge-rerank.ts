/** BM25's 20 candidates reordered by the app's reranker (bge-reranker-v2-m3, transformers.js), as search uses it (plan 7.6). */
import { RERANK_MODEL, rerankLocal, transformersDevice } from "../../ai/transformersEngine";
import { Corpus, type RetrievalDoc, type RetrievalInput } from "../retrieval";
import type { BenchEngine } from "../types";

const CANDIDATES = 20;
const corpora = new Map<string, Corpus>();

export const engine: BenchEngine = {
  id: "bge-rerank",
  label: "bge-reranker-v2-m3 over BM25",
  set: "retrieval",
  models: [RERANK_MODEL],
  async load() {
    // The first call loads (and on a cold cache downloads) the model.
    await rerankLocal("טעינה", ["load"]);
    return { device: await transformersDevice(), model: RERANK_MODEL };
  },
  prepare: async (part, shared) => void corpora.set(part, new Corpus(shared as RetrievalDoc[])),
  async run(item) {
    const c = corpora.get(item.part)!;
    const ids = c.candidates(item.input as RetrievalInput, CANDIDATES);
    const scores = await rerankLocal((item.input as RetrievalInput).query, ids.map((id) => (c.text.get(id) ?? "").slice(0, 2000)));
    return ids
      .map((id, i) => ({ id, s: scores[i] ?? 0, i }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.id)
      .slice(0, 10);
  },
  dispose: async () => corpora.clear(),
};
