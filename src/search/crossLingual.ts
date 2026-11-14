/**
 * Cross-language search (plan W5.28): ask in Hebrew, find English sources.
 * Smart search already fuses BM25 (with W2.11's Hebrew→English lexicon)
 * and local embeddings; this decides when a search is cross-lingual, which
 * embedding models can bridge the two languages, and marks the hits whose
 * text is in another language so the dialog can show a local translation
 * next to the original (./passageTranslator.ts).
 *
 * Only embedding models that map Hebrew and English into one space are
 * used for it: an English-only model (nomic-embed-text) would put a Hebrew
 * question nowhere near an English paragraph.
 */

export type Script = "he" | "en" | "other";

/** The dominant script of a text: Hebrew letters vs Latin letters. */
export function scriptOf(text: string): Script {
  let he = 0;
  let la = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x05d0 && c <= 0x05ea) he++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) la++;
  }
  if (!he && !la) return "other";
  return he >= la ? "he" : "en";
}

/**
 * Embedding providers (EmbeddingProvider.id) whose vectors are multilingual,
 * Hebrew included. multilingual-e5 is MIT, allowed in models/registry.json.
 */
const MULTILINGUAL = [/multilingual-e5/i, /bge-m3/i, /paraphrase-multilingual/i, /LaBSE/i];

export function isMultilingualEmbedding(providerId: string): boolean {
  return MULTILINGUAL.some((re) => re.test(providerId));
}

export interface CrossLingualMark {
  /** The hit's language differs from the query's: show the translation. */
  crossLingual: boolean;
  lang: Script;
}

/** Mark the hits written in another language than the query. */
export function markCrossLingual<T extends { snippet: string }>(query: string, hits: T[]): Array<T & CrossLingualMark> {
  const q = scriptOf(query);
  return hits.map((h) => {
    const lang = scriptOf(h.snippet);
    return { ...h, lang, crossLingual: q !== "other" && lang !== "other" && lang !== q };
  });
}

/**
 * Rank documents by cosine similarity to a query vector. Vectors should be
 * L2-normalised (e5's are); `norms` is computed once per document set, so a
 * query over 10,000 notes is one pass of dot products.
 */
export function rankByCosine(query: Float32Array, docs: ReadonlyArray<{ id: string; vector: Float32Array }>, k = 10, skip: ReadonlySet<string> = new Set()): Array<{ id: string; score: number }> {
  let qn = 0;
  for (let i = 0; i < query.length; i++) qn += query[i] * query[i];
  qn = Math.sqrt(qn) || 1;
  const top: Array<{ id: string; score: number }> = [];
  for (const d of docs) {
    if (skip.has(d.id)) continue;
    const v = d.vector;
    let dot = 0;
    let n = 0;
    for (let i = 0; i < v.length; i++) {
      dot += query[i] * v[i];
      n += v[i] * v[i];
    }
    const score = dot / (qn * (Math.sqrt(n) || 1));
    if (top.length < k || score > top[top.length - 1].score) {
      top.push({ id: d.id, score });
      top.sort((a, b) => b.score - a.score);
      if (top.length > k) top.pop();
    }
  }
  return top;
}

/** Reciprocal-rank fusion of several rankings (ids), with per-list weights. */
export function fuse(rankings: ReadonlyArray<{ ids: string[]; weight?: number }>, k = 10, rrfK = 60): string[] {
  const score = new Map<string, number>();
  for (const { ids, weight = 1 } of rankings) ids.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + weight / (rrfK + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, k).map(([id]) => id);
}
