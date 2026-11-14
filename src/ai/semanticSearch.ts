/**
 * Semantic search — workspace RAG layer that complements the existing BM25
 * keyword index with embedding vectors, computed on this device by default
 * (Ollama or transformers.js; see ./embeddingProvider.ts).
 *
 * Flow:
 *   1. `indexWorkspace()` chunks every workspace file at heading boundaries,
 *      embeds each chunk, and stores the vectors keyed by path + content hash.
 *   2. `searchSemantic(query, k)` embeds the query and returns the top-k
 *      chunks ranked by cosine similarity.
 *   3. `searchHybrid(query, k)` merges semantic and BM25 hits with weighted
 *      reciprocal-rank fusion so a query like "deep learning" still finds
 *      a doc titled "Neural networks" even when the surface words don't
 *      match.
 *
 * Vectors live in IndexedDB so the index survives reloads. Re-indexing only
 * re-embeds chunks whose hash changed; an index built by another embedding
 * model is discarded (vectors of different models are not comparable).
 */

import { get, set } from "idb-keyval";
import { forStore, fromStore, isSealedValue } from "../storage/vault/restStore";
import { log } from "../lib/logger";
import { pickEmbeddingProvider, type EmbeddingKind, type EmbeddingProvider } from "./embeddingProvider";
import {
  isOPFSAvailable,
  listWorkspace,
  readWorkspaceFile,
  isAssetName,
} from "../storage/workspace";
import { searchWorkspace } from "../storage/workspaceIndex";
import { getAiPolicy } from "./policy";
import { useAppStore } from "../store/useStore";

const IDB_KEY = "lumen-semantic-index";
const MAX_CHUNK_CHARS = 1800; // ~450 tokens
const EMBED_BATCH_SIZE = 16;

export interface ChunkRecord {
  hash: string;
  start: number;
  end: number;
  preview: string;
  /** base64-encoded Float32Array bytes for storage; deserialised on read. */
  vector: string;
}

export interface FileRecord {
  path: string;
  chunks: ChunkRecord[];
}

export interface SemanticIndex {
  builtAt: number;
  /** Embedding provider + model that built the vectors (absent: legacy OpenAI index). */
  embedding?: string;
  files: Record<string, FileRecord>;
}

export interface SemanticHit {
  path: string;
  score: number;
  snippet: string;
}

/* ─── Hash + base64 helpers ──────────────────────────────────────────── */

async function sha1(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function vectorToBase64(v: Float32Array): string {
  const bytes = new Uint8Array(v.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToVector(s: string): Float32Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/* ─── Chunking ──────────────────────────────────────────────────────── */

/**
 * Split markdown along heading boundaries first, then any chunk that's still
 * too long is sliced at the closest paragraph break under the size limit.
 */
export function chunkMarkdown(text: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  const lines = text.split("\n");
  let cursor = 0;
  let buffer = "";
  let bufferStart = 0;

  const flush = () => {
    if (!buffer.trim()) return;
    let chunk = buffer;
    let chunkStart = bufferStart;
    // Slice oversized buffers at paragraph breaks.
    while (chunk.length > MAX_CHUNK_CHARS) {
      const sliceEnd = chunk.lastIndexOf("\n\n", MAX_CHUNK_CHARS);
      const cut = sliceEnd > 200 ? sliceEnd : MAX_CHUNK_CHARS;
      out.push({ start: chunkStart, end: chunkStart + cut, text: chunk.slice(0, cut) });
      chunk = chunk.slice(cut);
      chunkStart += cut;
    }
    out.push({ start: chunkStart, end: chunkStart + chunk.length, text: chunk });
    buffer = "";
  };

  for (const line of lines) {
    const isHeading = /^#{1,6}\s+/.test(line);
    if (isHeading && buffer.trim().length > 0) flush();
    if (!buffer) bufferStart = cursor;
    buffer += (buffer ? "\n" : "") + line;
    cursor += line.length + 1;
  }
  flush();
  return out;
}

/* ─── Embedding ─────────────────────────────────────────────────────── */

/**
 * The provider is re-picked whenever what decides it changes — the AI
 * policy, a cloud key, the Ollama address — and at least once a minute, so
 * starting Ollama or pulling an embedding model is noticed without a
 * reload. (The index records which provider built it; a switch rebuilds.)
 */
const PROVIDER_TTL_MS = 60_000;
let picked: { sig: string; at: number; promise: Promise<EmbeddingProvider> } | null = null;

function providerSignature(): string {
  let policy = "";
  let ollama = "";
  try {
    policy = localStorage.getItem("lumen.ai.policy") ?? "";
    ollama = localStorage.getItem("lumen.ollama.baseUrl") ?? "";
  } catch {
    /* why: storage denied */
  }
  return [policy, getAiPolicy(), useAppStore.getState().aiKey ? "key" : "", ollama].join("|");
}

const provider = (): Promise<EmbeddingProvider> => {
  const sig = providerSignature();
  if (picked && picked.sig === sig && Date.now() - picked.at < PROVIDER_TTL_MS) return picked.promise;
  const entry = {
    sig,
    at: Date.now(),
    promise: pickEmbeddingProvider().catch((e) => {
      if (picked === entry) picked = null;
      throw e;
    }),
  };
  picked = entry;
  return entry.promise;
};

/** Tests: pick the provider again on next use. */
export function resetEmbeddingProvider(): void {
  picked = null;
}

/** Tests. */
export const __embedForTests = (texts: string[]): Promise<Float32Array[]> => embedTexts(texts);

async function embedTexts(texts: string[], kind: EmbeddingKind = "passage"): Promise<Float32Array[]> {
  return (await provider()).embed(texts, kind);
}

async function embedTextsInBatches(texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const slice = texts.slice(i, i + EMBED_BATCH_SIZE);
    const vecs = await embedTexts(slice, "passage");
    out.push(...vecs);
  }
  return out;
}

/* ─── Index lifecycle ───────────────────────────────────────────────── */

// C4: the index is read from IndexedDB once per session and its vectors
// decoded once — not on every query.
let memIndex: SemanticIndex | null = null;

/**
 * Plan 8.4: the vectors of one file, decoded once into ONE Float32Array —
 * chunk i is `data[i * dims … (i + 1) * dims)` — with each chunk's norm
 * precomputed. A query is then one tight loop per file over contiguous
 * memory, and a 10,000-note vault keeps 10,000 typed arrays alive, not one
 * per chunk.
 */
export interface FileVectors {
  dims: number;
  count: number;
  data: Float32Array;
  /** Euclidean norm of each chunk vector (float64, as `cosine` computes it). */
  norms: Float64Array;
}

/** Pack same-length vectors; null when their lengths differ (then each is scored on its own). */
export function packVectors(vectors: Float32Array[]): FileVectors | null {
  const dims = vectors[0]?.length ?? 0;
  if (vectors.some((v) => v.length !== dims)) return null;
  const data = new Float32Array(dims * vectors.length);
  const norms = new Float64Array(vectors.length);
  vectors.forEach((v, i) => {
    data.set(v, i * dims);
    let nb = 0;
    for (let j = 0; j < dims; j++) nb += v[j] * v[j];
    norms[i] = Math.sqrt(nb);
  });
  return { dims, count: vectors.length, data, norms };
}

/**
 * The chunk of `v` most similar to `q` (cosine; 0 for a length mismatch or
 * a zero vector, like `cosine`), first one on ties. Null for no chunks.
 */
export function bestChunk(q: Float32Array, v: FileVectors): { index: number; score: number } | null {
  if (!v.count) return null;
  let best = { index: 0, score: 0 };
  if (q.length !== v.dims) return best;
  let na = 0;
  for (let j = 0; j < q.length; j++) na += q[j] * q[j];
  const qNorm = Math.sqrt(na);
  for (let i = 0; i < v.count; i++) {
    const off = i * v.dims;
    let dot = 0;
    for (let j = 0; j < v.dims; j++) dot += q[j] * v.data[off + j];
    const denom = qNorm * v.norms[i];
    const s = denom === 0 ? 0 : dot / denom;
    if (i === 0 || s > best.score) best = { index: i, score: s };
  }
  return best;
}

const packed = new WeakMap<FileRecord, FileVectors | null>();

// In an encrypted vault (plan 11.4) the index (vectors and chunk text) is
// stored sealed, and not written while the vault is locked.
const LABEL = "semantic-index";

async function loadIndex(): Promise<SemanticIndex> {
  if (memIndex) return memIndex;
  const stored: unknown = await get(IDB_KEY).catch(() => undefined);
  const cached = await fromStore<SemanticIndex>(LABEL, stored as SemanticIndex | undefined);
  // Sealed and locked: an empty index for now, read again once unlocked.
  if (cached === undefined && isSealedValue(stored)) return { builtAt: 0, files: {} };
  memIndex = cached ?? { builtAt: 0, files: {} };
  return memIndex;
}

async function saveIndex(index: SemanticIndex): Promise<void> {
  memIndex = index;
  try {
    const v = await forStore(LABEL, index);
    if (v !== undefined) await set(IDB_KEY, v);
  } catch (err) {
    log.warn("semantic index persist failed", err);
  }
}

/** Store the index again — sealed now that the vault is encrypted (plan 11.4). */
export async function resealSemanticIndex(): Promise<void> {
  await saveIndex(await loadIndex());
}

/** A file's vectors, decoded from base64 and packed once. */
function vectorsOf(file: FileRecord): FileVectors | null {
  if (!packed.has(file)) packed.set(file, packVectors(file.chunks.map((c) => base64ToVector(c.vector))));
  return packed.get(file) ?? null;
}

let inFlightIndex: Promise<SemanticIndex> | null = null;

/**
 * Build (or refresh) the semantic index over the OPFS workspace.
 * Concurrent calls share the same in-flight promise.
 */
export async function indexWorkspace(opts: { force?: boolean } = {}): Promise<SemanticIndex> {
  if (inFlightIndex && !opts.force) return inFlightIndex;
  inFlightIndex = (async () => {
    if (!isOPFSAvailable()) return { builtAt: 0, files: {} };
    const embedding = (await provider()).id;
    const entries = await listWorkspace({ includeAssets: false });
    const files = entries.filter(
      (n) => /\.(md|markdown|txt)$/i.test(n.path) && !isAssetName(n.name),
    );
    let index = await loadIndex();
    // Vectors from another model are not comparable: start over.
    if ((index.embedding ?? "openai:text-embedding-3-small") !== embedding) index = { builtAt: 0, embedding, files: {} };
    index.embedding = embedding;
    const wantedPaths = new Set(files.map((f) => f.path));

    // Drop entries for files that no longer exist.
    for (const path of Object.keys(index.files)) {
      if (!wantedPaths.has(path)) delete index.files[path];
    }

    for (const file of files) {
      const content = await readWorkspaceFile(file.path).catch(() => "");
      if (!content.trim()) {
        delete index.files[file.path];
        continue;
      }
      const chunks = chunkMarkdown(content);
      const existing = index.files[file.path]?.chunks ?? [];
      const hashes = await Promise.all(chunks.map((c) => sha1(c.text)));
      // Re-use vectors for chunks whose hash matches the previous run.
      const reusable = new Map(existing.map((c) => [c.hash, c]));
      const toEmbedIdx: number[] = [];
      const toEmbedTexts: string[] = [];
      const records: (ChunkRecord | null)[] = chunks.map((c, i) => {
        const hash = hashes[i];
        const cached = reusable.get(hash);
        if (cached) return cached;
        toEmbedIdx.push(i);
        toEmbedTexts.push(c.text);
        return null;
      });

      if (toEmbedTexts.length > 0) {
        const vecs = await embedTextsInBatches(toEmbedTexts);
        toEmbedIdx.forEach((idx, k) => {
          const c = chunks[idx];
          records[idx] = {
            hash: hashes[idx],
            start: c.start,
            end: c.end,
            preview: c.text.slice(0, 200),
            vector: vectorToBase64(vecs[k]),
          };
        });
      }
      index.files[file.path] = {
        path: file.path,
        chunks: records.filter((r): r is ChunkRecord => r !== null),
      };
    }

    index.builtAt = Date.now();
    await saveIndex(index);
    return index;
  })();
  try {
    return await inFlightIndex;
  } finally {
    inFlightIndex = null;
  }
}

/* ─── Search ────────────────────────────────────────────────────────── */

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export async function searchSemantic(query: string, k = 8, filter?: (path: string) => boolean): Promise<SemanticHit[]> {
  if (!query.trim()) return [];
  const index = await loadIndex();
  if (!Object.keys(index.files).length) return [];
  const p = await provider();
  if ((index.embedding ?? "openai:text-embedding-3-small") !== p.id) return [];
  const [qVec] = await embedTexts([query], "query");
  if (p.dims && qVec.length !== p.dims) {
    log.warn("query vector unexpected dim", qVec.length);
  }
  const all: SemanticHit[] = [];
  for (const file of Object.values(index.files)) {
    if (filter && !filter(file.path)) continue;
    const vectors = vectorsOf(file);
    let best: { chunk: ChunkRecord; score: number } | null = null;
    if (vectors) {
      const b = bestChunk(qVec, vectors);
      if (b) best = { chunk: file.chunks[b.index], score: b.score };
    } else {
      // Mixed vector lengths (should not happen): score each chunk on its own.
      for (const chunk of file.chunks) {
        const s = cosine(qVec, base64ToVector(chunk.vector));
        if (!best || s > best.score) best = { chunk, score: s };
      }
    }
    if (best) {
      all.push({ path: file.path, score: best.score, snippet: best.chunk.preview });
    }
  }
  return all.sort((a, b) => b.score - a.score).slice(0, k);
}

/**
 * Hybrid retrieval: pulls the top BM25 hits and the top semantic hits, then
 * fuses them with reciprocal rank weighting. The result favours documents
 * that match BOTH the keyword and the semantic intent.
 */
export async function searchHybrid(
  query: string,
  k = 8,
  /** `filter`: search only these paths (scoped before the `k` limit). */
  opts: { filter?: (path: string) => boolean } = {},
): Promise<SemanticHit[]> {
  const [bmHits, semHits] = await Promise.all([
    searchWorkspace(query, { limit: k * 2, filter: opts.filter }).catch(() => []),
    searchSemantic(query, k * 2, opts.filter).catch(() => [] as SemanticHit[]),
  ]);
  // Reciprocal Rank Fusion (k=60 is the conventional constant).
  const fusion = new Map<string, { score: number; snippet: string }>();
  const RRF_K = 60;
  bmHits.forEach((h, i) => {
    const cur = fusion.get(h.path) ?? { score: 0, snippet: h.snippet ?? "" };
    cur.score += 1 / (RRF_K + i + 1);
    cur.snippet = cur.snippet || (h.snippet ?? "");
    fusion.set(h.path, cur);
  });
  semHits.forEach((h, i) => {
    const cur = fusion.get(h.path) ?? { score: 0, snippet: h.snippet };
    cur.score += 1.2 * (1 / (RRF_K + i + 1)); // slight semantic boost
    cur.snippet = cur.snippet || h.snippet;
    fusion.set(h.path, cur);
  });
  return [...fusion.entries()]
    .map(([path, v]) => ({ path, score: v.score, snippet: v.snippet }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export async function clearSemanticIndex(): Promise<void> {
  memIndex = null;
  await set(IDB_KEY, undefined).catch(() => { /* why: the in-memory index is already cleared; IndexedDB unavailable means nothing was stored */ });
}
