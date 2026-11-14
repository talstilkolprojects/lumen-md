/** BM25 alone (src/search/bm25.ts): the retrieval baseline the model engines are compared with. No model. */
import { Corpus, type RetrievalDoc, type RetrievalInput } from "../retrieval";
import type { BenchEngine } from "../types";

const corpora = new Map<string, Corpus>();

export const engine: BenchEngine = {
  id: "bm25",
  label: "BM25 (baseline)",
  set: "retrieval",
  models: [],
  load: async () => ({ device: "cpu" }),
  prepare: async (part, shared) => void corpora.set(part, new Corpus(shared as RetrievalDoc[])),
  run: async (item) => corpora.get(item.part)!.candidates(item.input as RetrievalInput, 10),
  dispose: async () => corpora.clear(),
};
