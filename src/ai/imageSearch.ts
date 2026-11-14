/**
 * Image search by text (plan 6.7): the vault's images and the query go into
 * one SigLIP space (google/siglip-base-patch16-256-multilingual, Apache-2.0,
 * converted by plan 6.0 and served from Lumen's host), and the images are
 * ranked by cosine similarity.
 *
 *   6.7.1  SigLIP base multilingual. Its Hebrew quality is measured on the
 *          image-search golden set (scripts/golden/evals/image-search.mjs)
 *          before Hebrew queries go to it directly.
 *   6.7.2  Until Hebrew is measured as good enough (HEBREW_DIRECT below),
 *          a Hebrew query is first translated to English on this device
 *          (plan 6.4, layers that need no download); the original is used
 *          when no local layer can translate it.
 *   6.7.4  Delta indexing: an image is embedded once per (path, size,
 *          modified); only new or changed images are sent to the worker,
 *          removed ones are dropped. Vectors live in IndexedDB.
 *
 * Nothing is downloaded without consent (requestConvertedModel) and nothing
 * leaves the device. Unavailable until CONVERTED_MODELS_BASE is set (15.9).
 */

export const SIGLIP_ID = "siglip-base-patch16-256-multilingual";

/**
 * Hebrew queries go to SigLIP directly only when the golden set says its
 * Hebrew recall is within 5 points of English (null: not measured yet, so
 * they are translated first).
 */
export const HEBREW_DIRECT: boolean | null = null;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

export function isImagePath(path: string): boolean {
  return IMAGE_EXT.test(path);
}

export interface ImageEntry {
  path: string;
  size: number;
  modified: number;
}

export interface IndexedImage extends ImageEntry {
  vector: number[];
}

export interface ImageIndex {
  model: string;
  images: IndexedImage[];
}

const sameVersion = (a: ImageEntry, b: ImageEntry) => a.size === b.size && a.modified === b.modified;

/** What has to be embedded and what stays: only new or changed images are embedded again. */
export function planDelta(index: ImageIndex | null, entries: ImageEntry[], model: string): { keep: IndexedImage[]; embed: ImageEntry[] } {
  const prev = index && index.model === model ? new Map(index.images.map((i) => [i.path, i])) : new Map<string, IndexedImage>();
  const keep: IndexedImage[] = [];
  const embed: ImageEntry[] = [];
  for (const e of entries) {
    if (!isImagePath(e.path)) continue;
    const old = prev.get(e.path);
    if (old && sameVersion(old, e)) keep.push(old);
    else embed.push(e);
  }
  return { keep, embed };
}

export interface IndexDeps {
  list: () => Promise<ImageEntry[]>;
  read: (path: string) => Promise<Blob>;
  embedImages: (images: Blob[], signal?: AbortSignal) => Promise<number[][]>;
  load: () => Promise<ImageIndex | null>;
  save: (index: ImageIndex) => Promise<void>;
  model?: string;
  /** Images per worker call. */
  batch?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** Bring the index up to date with the vault; returns it and how many images were embedded. */
export async function updateImageIndex(deps: IndexDeps): Promise<{ index: ImageIndex; embedded: number }> {
  const model = deps.model ?? SIGLIP_ID;
  const [entries, prev] = await Promise.all([deps.list(), deps.load()]);
  const { keep, embed } = planDelta(prev, entries, model);
  const images = [...keep];
  const batch = Math.max(1, deps.batch ?? 8);
  for (let i = 0; i < embed.length; i += batch) {
    if (deps.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const part = embed.slice(i, i + batch);
    const blobs = await Promise.all(part.map((e) => deps.read(e.path)));
    const vectors = await deps.embedImages(blobs, deps.signal);
    part.forEach((e, k) => vectors[k] && images.push({ ...e, vector: vectors[k] }));
    deps.onProgress?.(Math.min(i + batch, embed.length), embed.length);
  }
  const index = { model, images };
  if (embed.length || (prev?.images.length ?? 0) !== images.length || prev?.model !== model) await deps.save(index);
  return { index, embedded: embed.length };
}

const dot = (a: number[], b: number[]) => {
  let s = 0;
  for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i];
  return s;
};

export interface ImageHit {
  path: string;
  score: number;
}

/** Images ranked by similarity to a (unit) query vector. */
export function rankImages(index: ImageIndex, query: number[], k = 20): ImageHit[] {
  return index.images
    .map((i) => ({ path: i.path, score: dot(i.vector, query) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, k);
}

const HEBREW = /[֐-׿]/;

export interface QueryDeps {
  embedText: (texts: string[], signal?: AbortSignal) => Promise<number[][]>;
  /** English for a Hebrew query through local translation; null when no local layer can. */
  toEnglish?: (text: string, signal?: AbortSignal) => Promise<string | null>;
  hebrewDirect?: boolean | null;
  signal?: AbortSignal;
}

/** The text actually embedded for a query (6.7.2), and the query vector. */
export async function queryVector(query: string, deps: QueryDeps): Promise<{ text: string; translated: boolean; vector: number[] }> {
  let text = query.trim();
  let translated = false;
  const direct = deps.hebrewDirect === undefined ? HEBREW_DIRECT : deps.hebrewDirect;
  if (HEBREW.test(text) && direct !== true && deps.toEnglish) {
    const en = await deps.toEnglish(text, deps.signal).catch(() => null);
    if (en && en.trim()) {
      text = en.trim();
      translated = true;
    }
  }
  const [vector] = await deps.embedText([text], deps.signal);
  return { text, translated, vector: vector ?? [] };
}

/** recall@k and nDCG@10 over queries with one relevant image each (the golden set's metric). */
export function retrievalMetrics(ranks: Array<number | null>, k = 5): { recallAt1: number; recallAtK: number; ndcg10: number } {
  const n = ranks.length || 1;
  let r1 = 0;
  let rk = 0;
  let ndcg = 0;
  for (const r of ranks) {
    if (r === null) continue;
    if (r === 1) r1++;
    if (r <= k) rk++;
    if (r <= 10) ndcg += 1 / Math.log2(r + 1);
  }
  return { recallAt1: r1 / n, recallAtK: rk / n, ndcg10: ndcg / n };
}
