/**
 * The embeddings / reranker competition (plan W7.13) on retrieval/hard.
 * Plain JavaScript like retrieval.mjs and rerank.mjs, so tests and the
 * real-model eval (src/agents/eval/embedCompete.eval.ts) share it.
 *
 *   evaluateCandidate(candidate, { items, corpus })
 *     → { ndcg10, recall20, msPerQuery, indexBytes, dims }
 *   candidate = { id, embed(texts, "query" | "document") → number[][], dims?, matryoshka?, rerank?(query, docs) }
 *
 * The plan's rules, as functions:
 *   discriminates   the set separates models: best − worst ≥ 5 nDCG@10 points
 *   chooseDefault   the default changes only for ≥ 5 points on the held-out
 *                   part AND ≤ 150 ms per query at 10,000 notes
 *   rerankDecision  a reranker is on only when it adds ≥ 3 points
 */
import { ndcgAt } from "./retrieval.mjs";

export const DISCRIMINATE_POINTS = 5;
export const SWITCH_POINTS = 5;
export const MAX_MS_PER_QUERY_10K = 150;
export const RERANK_POINTS = 3;

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const norm = (v) => {
  const n = Math.sqrt(dot(v, v)) || 1;
  return v.map((x) => x / n);
};

/** Matryoshka: keep the first `d` dimensions and renormalise (EmbeddingGemma 768 → 256 / 128). */
export function truncateMatryoshka(vec, d) {
  return norm(Array.from(vec).slice(0, d));
}

export function recallAt(ranking, relevant, k = 20) {
  const want = new Set(relevant);
  if (!want.size) return 1;
  return ranking.slice(0, k).filter((id) => want.has(id)).length / want.size;
}

const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

/** One candidate on one set: rank the corpus by cosine for every query (then rerank the top 20). */
export async function evaluateCandidate(candidate, { items, corpus, k = 10, recallK = 20, rerankTop = 20, now = () => performance.now() }) {
  const dims = candidate.matryoshka ?? candidate.dims;
  const fit = (v) => (dims && v.length > dims ? truncateMatryoshka(v, dims) : norm(Array.from(v)));
  const docVecs = (await candidate.embed(corpus.map((d) => `${d.title ? d.title + "\n" : ""}${d.text}`), "document")).map(fit);
  const text = new Map(corpus.map((d) => [d.id, d.text]));
  let nd = 0;
  let rc = 0;
  let ms = 0;
  for (const it of items) {
    const t0 = now();
    const [qv] = (await candidate.embed([it.query], "query")).map(fit);
    const skip = new Set(it.sameArticle ?? []);
    let ranking = corpus
      .map((d, i) => ({ id: d.id, s: dot(qv, docVecs[i]) }))
      .filter((x) => !skip.has(x.id))
      .sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1))
      .map((x) => x.id);
    if (candidate.rerank) {
      const top = ranking.slice(0, rerankTop);
      const re = await candidate.rerank(it.query, top.map((id) => ({ id, text: text.get(id) ?? "" })));
      ranking = [...re.map((r) => r.id), ...ranking.slice(rerankTop)];
    }
    ms += now() - t0;
    nd += ndcgAt(ranking, it.relevant, k);
    rc += recallAt(ranking, it.relevant, recallK);
  }
  const n = items.length || 1;
  const d = docVecs[0]?.length ?? 0;
  return { id: candidate.id, ndcg10: round(nd / n), recall20: round(rc / n), msPerQuery: round(ms / n, 2), dims: d, indexBytes: corpus.length * d * 4, items: items.length };
}

/** nDCG points (×100) between two results. */
export const points = (a, b) => round((a - b) * 100, 2);

export function discriminates(results) {
  const s = results.map((r) => r.ndcg10);
  return s.length >= 2 && points(Math.max(...s), Math.min(...s)) >= DISCRIMINATE_POINTS;
}

/**
 * Which model is the default after the competition. `current` keeps it
 * unless a challenger beats it by ≥ 5 points on the held-out part and its
 * query time, scaled to 10,000 notes, is ≤ 150 ms.
 */
export function chooseDefault(heldout, current, { notes, scaleTo = 10_000 } = {}) {
  const base = heldout.find((r) => r.id === current);
  if (!base) return { id: current, reason: "the current model was not measured" };
  let best = { id: current, reason: "no challenger is ≥ 5 points better and fast enough" };
  let bestScore = base.ndcg10;
  for (const r of heldout) {
    if (r.id === current) continue;
    const ms10k = notes ? (r.msPerQuery * scaleTo) / notes : r.msPerQuery;
    if (points(r.ndcg10, base.ndcg10) >= SWITCH_POINTS && ms10k <= MAX_MS_PER_QUERY_10K && r.ndcg10 > bestScore) {
      best = { id: r.id, reason: `+${points(r.ndcg10, base.ndcg10)} nDCG@10 points on the held-out part, ${round(ms10k, 1)} ms per query at ${scaleTo} notes` };
      bestScore = r.ndcg10;
    }
  }
  return best;
}

export function rerankDecision(withRerank, without) {
  const gain = points(withRerank.ndcg10, without.ndcg10);
  return { on: gain >= RERANK_POINTS, gain };
}
