/** Shared by the retrieval engines (plan 7.8): BM25 over a part's corpus, candidates per query. */
import { Bm25Index } from "../search/bm25";

export interface RetrievalDoc {
  id: string;
  title?: string;
  text: string;
}
export interface RetrievalInput {
  query: string;
  /** Unjudged documents of the same article: left out of the ranking (as scripts/golden/evals/retrieval.mjs does). */
  skip: string[];
}

export class Corpus {
  readonly index = new Bm25Index();
  readonly text = new Map<string, string>();
  constructor(readonly docs: RetrievalDoc[]) {
    for (const d of docs) {
      this.index.set(d.id, d.text ?? "", d.title ?? "");
      this.text.set(d.id, d.text ?? "");
    }
  }
  /** BM25's best `n` ids for the query, without the skipped ones. */
  candidates(input: RetrievalInput, n: number): string[] {
    const skip = new Set(input.skip);
    return this.index
      .search(input.query, { limit: n + skip.size })
      .map((h) => h.id)
      .filter((id) => !skip.has(id))
      .slice(0, n);
  }
}
