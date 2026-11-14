/**
 * Scoring for cross-language search (plan W5.28): nDCG@10 of a ranking
 * function over a set of Hebrew questions and an English corpus — the dev
 * probe (eval/probes/crosslingual-he-en.json) or a held-out split built
 * locally (Belebele heb_Hebr questions over eng_Latn passages). Plain
 * JavaScript, shared by the unit test (BM25 only, no model) and the
 * real-model eval (src/agents/eval/crosslingual.eval.ts).
 *
 *   await scoreCrossLingual(rank, { items, corpus })
 *     → { items, ndcg10, recall10, perItem }      rank(query) → ids, best first
 */
import { ndcgAt } from "../golden/evals/retrieval.mjs";

export const TARGET_NDCG = 0.8;

export async function scoreCrossLingual(rank, { items }, { k = 10 } = {}) {
  let sum = 0;
  let found = 0;
  const perItem = {};
  for (const it of items) {
    const ids = (await rank(it.query)).slice(0, k);
    const s = ndcgAt(ids, it.relevant, k);
    perItem[it.id] = Math.round(s * 1000) / 1000;
    sum += s;
    if (ids.some((id) => it.relevant.includes(id))) found++;
  }
  const n = items.length || 1;
  return { items: items.length, ndcg10: Math.round((sum / n) * 10000) / 10000, recall10: Math.round((found / n) * 10000) / 10000, perItem };
}
