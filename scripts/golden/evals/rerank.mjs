/**
 * Harness for plan 7.6: does a reranker improve the retrieval golden set
 * (7.1)? nDCG@10 of BM25 alone against BM25 + a reranker over the same
 * candidates, per part. Plain JavaScript, like retrieval.mjs, so the tests,
 * the real-model eval (src/agents/eval/rerank.eval.ts) and CI share it.
 *
 *   compareRerank(Index, rerankFn, { items, documents, candidates })
 *     → { items, bm25, reranked, gain }      (gain = reranked − bm25, in nDCG points ×100)
 *
 * `rerankFn(query, [{ id, text }])` returns the same objects in its order.
 * The plan's rule: a gain under 5 points → the model reranker is removed or
 * off by default; otherwise it runs only on WebGPU / the desktop app, after
 * the user agrees to its download.
 */
import { ndcgAt } from "./retrieval.mjs";

export const MIN_GAIN_POINTS = 5;

export async function compareRerank(Index, rerankFn, { items, documents, candidates = 20, k = 10 }) {
  const index = new Index();
  for (const d of documents) index.set(d.id, d.text ?? "", d.title ?? "");
  const text = new Map(documents.map((d) => [d.id, d.text ?? ""]));
  let base = 0;
  let rr = 0;
  for (const it of items) {
    const skip = new Set(it.sameArticle ?? []);
    const ids = index
      .search(it.query, { limit: candidates + skip.size })
      .map((h) => h.id)
      .filter((id) => !skip.has(id));
    base += ndcgAt(ids, it.relevant, k);
    const ranked = await rerankFn(it.query, ids.map((id) => ({ id, text: text.get(id) ?? "" })));
    rr += ndcgAt(ranked.map((r) => r.id), it.relevant, k);
  }
  const n = items.length || 1;
  const bm25 = base / n;
  const reranked = rr / n;
  return { items: items.length, bm25: round(bm25), reranked: round(reranked), gain: round((reranked - bm25) * 100, 2) };
}

/** The decision the plan asks for, from a measured gain (points). */
export function rerankDecision(gainPoints) {
  return gainPoints >= MIN_GAIN_POINTS ? "keep-webgpu-desktop-with-consent" : "off-by-default";
}

function round(x, d = 4) {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
