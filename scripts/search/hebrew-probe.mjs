/**
 * Scores the Hebrew search probe set (eval/probes/hebrew-search.json, plan
 * W2.11) with a BM25 index class: nDCG@10 on the morphology queries over
 * the HeQ dev corpus, how many full/defective spelling pairs are found in
 * the top 10 (and at rank 1), and the Hebrew→English queries.
 *
 *   scoreProbe(Bm25Index, probe, heqCorpus) → { morph, ktivTop10, ktivTop1, ktivTotal, cross, crossTotal }
 *
 * Plain JavaScript, no imports: the unit test (src/__tests__/hebrewSearch.test.ts)
 * passes the app's index class in.
 */
import { ndcgAt } from "../golden/evals/retrieval.mjs";

function indexOf(Index, docs) {
  const index = new Index();
  for (const d of docs) index.set(d.id, d.text ?? "", d.title ?? "");
  return index;
}

export function scoreProbe(Index, probe, heqCorpus, { k = 10 } = {}) {
  const heq = indexOf(Index, heqCorpus);
  let sum = 0;
  const perQuery = {};
  for (const it of probe.morph) {
    const ranking = heq.search(it.query, { limit: k }).map((h) => h.id);
    const s = ndcgAt(ranking, it.relevant, k);
    perQuery[it.id] = Math.round(s * 1000) / 1000;
    sum += s;
  }
  const withKtiv = indexOf(Index, [...heqCorpus, ...probe.ktiv.map((p) => p.doc)]);
  let top10 = 0;
  let top1 = 0;
  const missed = [];
  for (const p of probe.ktiv) {
    const ids = withKtiv.search(p.query, { limit: k }).map((h) => h.id);
    if (ids.includes(p.doc.id)) top10++;
    else missed.push(p.id);
    if (ids[0] === p.doc.id) top1++;
  }
  const withEn = indexOf(Index, [...heqCorpus, ...probe.crosslingual.map((c) => c.doc)]);
  let cross = 0;
  for (const c of probe.crosslingual) if (withEn.search(c.query, { limit: k }).some((h) => c.relevant.includes(h.id))) cross++;
  return {
    morph: Math.round((sum / probe.morph.length) * 10000) / 10000,
    ktivTop10: top10,
    ktivTop1: top1,
    ktivTotal: probe.ktiv.length,
    ktivMissed: missed,
    cross,
    crossTotal: probe.crosslingual.length,
    perQuery,
  };
}
