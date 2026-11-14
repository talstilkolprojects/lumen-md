/**
 * Reranking search hits (T29).
 *
 * Retrieval (BM25 + embeddings, see ./semanticSearch) is good at recall and
 * loose at order. A reranker reads the query and each candidate together
 * and scores how well the candidate answers it.
 *
 *  - "model": the multilingual cross-encoder bge-reranker-v2-m3 (Hebrew
 *    included) on this device via transformers.js — a one-time download
 *    (~570 MB q8), opt-in.
 *  - "lexical" (default): a Hebrew-aware term-coverage score — every query
 *    word (niqqud stripped, prefixes ו/ה/ב/ל/מ/ש/כ tolerated) found in the
 *    passage — blended with the retrieval rank. No download, instant.
 */
import { normalizeForMatch, prefixVariants, words } from "../text/hebrew";

export type RerankMode = "model" | "lexical";
const MODE_KEY = "lumen.ai.rerank";

export function getRerankMode(): RerankMode {
  try {
    return localStorage.getItem(MODE_KEY) === "model" ? "model" : "lexical";
  } catch {
    return "lexical";
  }
}

export function setRerankMode(mode: RerankMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* why: storage denied */
  }
}

/**
 * Plan 7.6: the model reranker is offered only where it is fast enough —
 * a browser with WebGPU, or the desktop app — and after the user agreed to
 * its download. Measured on the retrieval golden set's HeQ dev split, BM25
 * alone already scores nDCG@10 1.0, so the model is off by default
 * (`npm run eval:rerank` measures it on the other parts).
 */
export function modelRerankSupported(): boolean {
  if (typeof window === "undefined") return false;
  const desktop = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
  return desktop || (typeof navigator !== "undefined" && "gpu" in navigator && !!(navigator as Navigator & { gpu?: unknown }).gpu);
}

/** Size of the model's one-time download (q8), shown in the consent. */
export const RERANK_MODEL_MB = 571;

/** Share of the query's words present in `text` (0..1), Hebrew-aware. */
export function lexicalScore(query: string, text: string): number {
  const q = [...new Set(words(normalizeForMatch(query)).filter((w) => w.length > 1))];
  if (!q.length) return 0;
  const bag = new Set<string>();
  for (const w of words(normalizeForMatch(text))) for (const v of prefixVariants(w)) bag.add(v);
  let hit = 0;
  for (const w of q) if (prefixVariants(w).some((v) => bag.has(v))) hit++;
  return hit / q.length;
}

export interface Rankable {
  text: string;
}

/**
 * Reorder `items` by relevance to `query`. The model path falls back to the
 * lexical one on any failure (no WebGPU/wasm, download refused, offline).
 */
export async function rerank<T extends Rankable>(
  query: string,
  items: T[],
  opts: { mode?: RerankMode; signal?: AbortSignal } = {},
): Promise<Array<T & { rerankScore: number }>> {
  if (items.length < 2) return items.map((it) => ({ ...it, rerankScore: 1 }));
  const mode = opts.mode ?? getRerankMode();
  let scores: number[] | null = null;
  if (mode === "model") {
    try {
      const { rerankLocal } = await import("./transformersEngine");
      scores = await rerankLocal(query, items.map((i) => i.text.slice(0, 2000)), { signal: opts.signal });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      scores = null;
    }
  }
  if (!scores) {
    // Blend: term coverage decides, retrieval order breaks ties.
    scores = items.map((it, i) => lexicalScore(query, it.text) + 0.15 / (1 + i));
  }
  return items
    .map((it, i) => ({ ...it, rerankScore: scores![i] ?? 0, _i: i }))
    .sort((a, b) => b.rerankScore - a.rerankScore || a._i - b._i)
    .map(({ _i, ...rest }) => rest as unknown as T & { rerankScore: number });
}
