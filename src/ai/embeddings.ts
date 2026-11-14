/**
 * Workspace RAG engine — BM25+ with bigram phrase matching.
 *
 * NOTE on the filename: despite being called `embeddings.ts`, this module
 * contains NO vector embeddings — it is a pure lexical BM25+ ranker. The real
 * vector-embedding + cosine/RRF hybrid path lives in `semanticSearch.ts`. The
 * name is kept only to avoid churning every import; treat it as "lexical search".
 *
 * Upgraded to Web Worker architecture for zero UI blocking during indexing/search.
 *
 * The index is constructed in the worker and refreshed every 60s.
 */

import { get, set } from "idb-keyval";
import { log } from "../lib/logger";
import { isIndexableTextPath } from "../lib/textPaths";
import {
  ensureIndex,
} from "../storage/workspaceIndex";
import {
  isOPFSAvailable,
  listWorkspace,
  readWorkspaceFile,
  isAssetName,
} from "../storage/workspace";

/* ─── Types ─────────────────────────────────────────────────────── */

export interface RagResult {
  path: string;
  score: number;
  snippet: string;
  content: string;
}

/** Raw search hit returned from the worker (content loaded separately). */
interface SearchHit {
  path: string;
  score: number;
  snippet: string;
}

const IDB_KEY = "lumen-rag-bm25";
const STALE_MS = 60_000; // rebuild if >60s old

// Single active worker instance
let searchWorker: Worker | null = null;
let lastBuildTime = 0;
let currentDocCount = 0;
let isBuilding = false;
let buildQueueResolver: (() => void) | null = null;

// Search request sequence id
let searchSeq = 0;
// Map of seq -> Promise resolver
const searchResolvers = new Map<number, { resolve: (r: SearchHit[]) => void, reject: (e: Error) => void }>();

function initWorker() {
  if (searchWorker) return searchWorker;
  searchWorker = new Worker(new URL("./search.worker.ts", import.meta.url), { type: "module" });
  
  searchWorker.onmessage = (e) => {
    const { type, docCount, results, seq, success, error } = e.data;
    
    if (type === "BUILT") {
      isBuilding = false;
      if (success) {
        lastBuildTime = Date.now();
        currentDocCount = docCount;
        set(IDB_KEY, { builtAt: lastBuildTime, docCount }).catch(() => { /* why: the build time is a hint for the status line; the index itself is in memory */ });
      } else {
        log.error("BM25 build failed in worker", error);
      }
      if (buildQueueResolver) {
        buildQueueResolver();
        buildQueueResolver = null;
      }
    } else if (type === "SEARCH_RESULTS") {
      const resolver = searchResolvers.get(seq);
      if (resolver) {
        searchResolvers.delete(seq);
        if (error) resolver.reject(new Error(error));
        else resolver.resolve(results || []);
      }
    }
  };
  return searchWorker;
}

/* ─── Public API ────────────────────────────────────────────────── */

/**
 * Build or refresh the BM25+ index from the workspace via WebWorker.
 */
export async function buildRagIndex(): Promise<void> {
  if (!isOPFSAvailable() || isBuilding) {
    if (isBuilding) {
      return new Promise<void>((r) => { 
        const old = buildQueueResolver;
        buildQueueResolver = () => { if (old) old(); r(); };
      });
    }
    return;
  }
  
  const worker = initWorker();
  await ensureIndex();

  const list = await listWorkspace({ includeAssets: false });
  const docs: { path: string; content: string }[] = [];

  await Promise.all(
    list
      // Notes and plain text only: a PDF or another binary decoded as text
      // is gibberish in the search worker (review #272, step 2.17).
      .filter((e) => !isAssetName(e.path) && isIndexableTextPath(e.path))
      .map(async (e) => {
        try {
          const content = await readWorkspaceFile(e.path);
          if (content.trim().length > 10) {
            docs.push({ path: e.path, content });
          }
        } catch {
          /* why: an unreadable note is left out of the index; the rest still build */
        }
      }),
  );

  if (docs.length < 2) return; // Not enough docs for meaningful search

  isBuilding = true;
  return new Promise<void>((resolve) => {
    buildQueueResolver = resolve;
    worker.postMessage({ type: "BUILD", docs });
  });
}

/**
 * Search the workspace using BM25+ ranking via WebWorker.
 */
export async function semanticSearch(
  query: string,
  opts: { topK?: number; maxContentChars?: number } = {},
): Promise<RagResult[]> {
  const topK = opts.topK ?? 8;
  const maxChars = opts.maxContentChars ?? 6000;

  // Rebuild if stale or missing
  if (lastBuildTime === 0) {
    const cached = await get<{ builtAt: number; docCount: number }>(IDB_KEY);
    if (cached) {
      lastBuildTime = cached.builtAt;
      currentDocCount = cached.docCount;
    }
  }

  if (lastBuildTime === 0 || Date.now() - lastBuildTime > STALE_MS) {
    await buildRagIndex();
  }
  
  if (currentDocCount === 0) return [];

  const worker = initWorker();
  
  const seq = ++searchSeq;
  const scored = await new Promise<SearchHit[]>((resolve, reject) => {
    searchResolvers.set(seq, { resolve, reject });
    worker.postMessage({ type: "SEARCH", query, topK, seq });
  });

  // Load full content for top results
  const results: RagResult[] = [];
  for (const hit of scored) {
    try {
      const content = await readWorkspaceFile(hit.path);
      results.push({
        path: hit.path,
        score: hit.score,
        snippet: hit.snippet,
        content: content.slice(0, maxChars),
      });
    } catch {
      results.push({ ...hit, content: hit.snippet });
    }
  }

  return results;
}

/**
 * Get the current index stats.
 */
export function getRagStats(): { docCount: number; vocabSize: number } | null {
  if (lastBuildTime === 0) return null;
  return {
    docCount: currentDocCount,
    vocabSize: 0, // Vocab size is tracked inside the worker now
  };
}

