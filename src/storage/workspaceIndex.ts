import { noteKey } from "../lib/slug";
import { WORKSPACE_CHANGED, changeOf } from "./workspaceEvents";
import { hasHebrew, hebrewFind } from "../text/hebrew";
import {
  basename,
  isAssetName,
  isOPFSAvailable,
  listWorkspace,
  readWorkspaceFile,
} from "./workspace";

export interface IndexedFile {
  /** Full workspace path. */
  path: string;
  /** Basename. */
  name: string;
  content: string;
  modified: number;
  /** Wiki-link targets referenced by this file (raw `[[target]]` text). */
  wikiTargets: string[];
}

const cache = {
  byPath: new Map<string, IndexedFile>(),
  builtAt: 0,
  inflight: null as Promise<void> | null,
  /** Files whose text changed since they were indexed (C3). */
  dirty: new Set<string>(),
  /** Files were added / removed / renamed: rebuild on next use. */
  stale: false,
  /** When the index was last checked against the vault listing. */
  checkedAt: 0,
  /** Bumped whenever `byPath` changes, so views can cache what they derive from it. */
  version: 0,
};

/**
 * Not every writer announces its writes (agent tools, the page-hide flush,
 * sync): at most this often, a use of the index re-lists the vault and
 * re-reads only the files whose mtime changed — or that appeared.
 */
export const REVALIDATE_MS = 30_000;
const WIKI_RE = /\[\[([^\]\r\n|]+?)(?:\|[^\]\r\n]+?)?\]\]/g;

/** Read one file into an index entry, or null if unreadable. */
async function indexFile(e: { path: string; name: string; modified: number }): Promise<IndexedFile | null> {
  try {
    const content = await readWorkspaceFile(e.path);
    const wikiTargets: string[] = [];
    let m: RegExpExecArray | null;
    WIKI_RE.lastIndex = 0;
    while ((m = WIKI_RE.exec(content)) !== null) wikiTargets.push(m[1].trim());
    return { path: e.path, name: e.name, content, modified: e.modified, wikiTargets };
  } catch {
    return null;
  }
}

/** Run `fn` over `items` with at most `limit` in flight (a 10k vault must not open 10k reads at once). */
async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

/** Build the whole index from OPFS (first use, or after files were added / removed). */
async function build(): Promise<void> {
  if (!isOPFSAvailable()) return;
  // Clear before reading: a change announced while the build runs (it may
  // have read that file already) must survive for the next ensureIndex.
  cache.dirty.clear();
  cache.stale = false;
  const list = await listWorkspace({ includeAssets: false });
  const next = new Map<string, IndexedFile>();
  await mapLimit(
    list.filter((e) => !isAssetName(e.path)),
    16,
    async (e) => {
      const f = await indexFile(e);
      if (f) next.set(e.path, f);
    },
  );
  cache.byPath = next;
  cache.builtAt = cache.checkedAt = Date.now();
  cache.version++;
}

/** Fallback for unannounced writes: re-read what the listing says changed. */
async function revalidate(): Promise<void> {
  cache.checkedAt = Date.now();
  const list = (await listWorkspace({ includeAssets: false })).filter((e) => !isAssetName(e.path));
  const seen = new Set(list.map((e) => e.path));
  const size = cache.byPath.size;
  for (const path of [...cache.byPath.keys()]) if (!seen.has(path)) cache.byPath.delete(path);
  const changed = list.filter((e) => cache.byPath.get(e.path)?.modified !== e.modified);
  await mapLimit(changed, 16, async (e) => {
    const f = await indexFile(e);
    if (f) cache.byPath.set(e.path, f);
    else cache.byPath.delete(e.path);
  });
  if (changed.length || cache.byPath.size !== size) cache.version++;
}

/**
 * C3: after an autosave only the saved files are re-read — not the whole
 * vault. Returns false when a full rebuild is needed instead.
 */
async function refreshDirty(): Promise<void> {
  const paths = [...cache.dirty];
  cache.dirty.clear();
  await Promise.all(
    paths.map(async (path) => {
      const prev = cache.byPath.get(path);
      const f = await indexFile({ path, name: prev?.name ?? path.split("/").pop() ?? path, modified: Date.now() });
      if (f) cache.byPath.set(path, f);
      else cache.byPath.delete(path);
    }),
  );
  cache.version++;
}

export async function ensureIndex(force = false): Promise<void> {
  if (!isOPFSAvailable()) return;
  if (cache.inflight) {
    await cache.inflight;
    if (!force && !cache.stale && !cache.dirty.size) return;
  }
  if (force || cache.stale || !cache.builtAt) {
    cache.inflight = build().finally(() => {
      cache.inflight = null;
    });
  } else if (cache.dirty.size) {
    cache.inflight = refreshDirty().finally(() => {
      cache.inflight = null;
    });
  } else if (Date.now() - cache.checkedAt >= REVALIDATE_MS) {
    cache.inflight = revalidate().finally(() => {
      cache.inflight = null;
    });
  } else return;
  await cache.inflight;
}

/** Listen for workspace changes: content changes mark files dirty, anything else forces a rebuild. */
let listenerAttached = false;
function attachInvalidator() {
  if (listenerAttached || typeof window === "undefined") return;
  listenerAttached = true;
  window.addEventListener(WORKSPACE_CHANGED, (e) => {
    const c = changeOf(e);
    if (c.kind === "content" && c.paths) for (const p of c.paths) cache.dirty.add(p);
    else cache.stale = true;
  });
}
attachInvalidator();

/** Every indexed note (after ensureIndex) — for the tags panel and other views. */
export function indexedFiles(): IndexedFile[] {
  return [...cache.byPath.values()];
}

/** Changes whenever the indexed files do: a cache of something derived from them is good while it is the same. */
export function indexVersion(): number {
  return cache.version;
}

/** Test hook. */
export function __resetWorkspaceIndex(): void {
  cache.byPath = new Map();
  cache.builtAt = 0;
  cache.inflight = null;
  cache.dirty.clear();
  cache.stale = false;
  cache.checkedAt = 0;
  cache.version++;
}

export interface BacklinkHit {
  /** Full path of the source file. */
  fromPath: string;
  /** Basename for display. */
  fromName: string;
  /** A short snippet of the surrounding text (one line). */
  snippet: string;
  /** Char offset in the source file where the wiki-link starts. */
  offset: number;
}

/** Find files whose wiki-links point at the given target (path or basename). */
export async function findBacklinks(targetPath: string): Promise<BacklinkHit[]> {
  await ensureIndex();
  const targetName = basename(targetPath);
  const stem = targetName.replace(/\.md$/i, "");
  // By normalized name, not slug: the old ASCII slug made every Hebrew
  // target "" and so every Hebrew link a backlink of every Hebrew note.
  const wanted = noteKey(stem);
  const out: BacklinkHit[] = [];
  for (const file of cache.byPath.values()) {
    if (file.path === targetPath) continue;
    let m: RegExpExecArray | null;
    WIKI_RE.lastIndex = 0;
    while ((m = WIKI_RE.exec(file.content)) !== null) {
      // `[[target#heading|label]]` → the note part only.
      const target = m[1].split("#")[0].trim();
      if (target && noteKey(basename(target)) === wanted) {
        const offset = m.index;
        out.push({
          fromPath: file.path,
          fromName: file.name,
          offset,
          snippet: snippetAround(file.content, offset),
        });
      }
    }
  }
  return out;
}

export interface SearchHit {
  /** Full workspace path. */
  path: string;
  /** Basename for display. */
  name: string;
  /** Match score; higher is better. */
  score: number;
  /** First-content match (or null when matched by name only). */
  snippet: string | null;
  /** Highlight range inside the snippet for the matched substring. */
  match?: { start: number; end: number };
}

/** Cheap fuzzy + substring search across filenames, paths, and content. */
export async function searchWorkspace(
  query: string,
  /** `filter`: only these paths — applied before `limit`. */
  opts: { limit?: number; filter?: (path: string) => boolean } = {},
): Promise<SearchHit[]> {
  await ensureIndex();
  const limit = opts.limit ?? 30;
  const q = query.trim().toLowerCase();
  if (!q) {
    return [...cache.byPath.values()]
      .sort((a, b) => b.modified - a.modified)
      .slice(0, limit)
      .map((f) => ({ path: f.path, name: f.name, score: 0, snippet: null }));
  }
  const out: SearchHit[] = [];
  for (const file of cache.byPath.values()) {
    if (opts.filter && !opts.filter(file.path)) continue;
    const nameLower = file.name.toLowerCase();
    const pathLower = file.path.toLowerCase();
    const contentLower = file.content.toLowerCase();
    let score = 0;
    let snippet: string | null = null;
    let match: SearchHit["match"];
    if (nameLower.includes(q)) score += 10;
    if (nameLower === q) score += 20;
    if (nameLower.startsWith(q)) score += 5;
    if (pathLower.includes(q) && pathLower !== nameLower) score += 6;
    // Niqqud-, final-letter- and prefix-insensitive for Hebrew (T26):
    // "והבית" finds "בית", "שָׁלוֹם" finds "שלום".
    const found = findIn(file.content, contentLower, q);
    if (!nameLower.includes(q) && hasHebrew(q) && hebrewFind(file.name, q)) score += 10;
    if (found) {
      score += 4;
      const ctx = snippetAround(file.content, found.start, 80);
      // Re-locate the hit inside the (whitespace-collapsed, "…"-prefixed) snippet.
      const local = findIn(ctx, ctx.toLowerCase(), file.content.slice(found.start, found.end).replace(/\s+/g, " ").toLowerCase());
      snippet = ctx;
      if (local) match = local;
    } else if (fuzzyMatch(nameLower, q) || fuzzyMatch(pathLower, q)) {
      score += 1;
    }
    if (score > 0)
      out.push({ path: file.path, name: file.name, score, snippet, match });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

function findIn(text: string, lower: string, q: string): { start: number; end: number } | null {
  const at = lower.indexOf(q);
  if (at >= 0) return { start: at, end: at + q.length };
  return hasHebrew(q) ? hebrewFind(text, q) : null;
}

function snippetAround(content: string, offset: number, radius = 60): string {
  const start = Math.max(0, offset - radius);
  const end = Math.min(content.length, offset + radius);
  let s = content.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) s = "…" + s;
  if (end < content.length) s = s + "…";
  return s;
}

function fuzzyMatch(haystack: string, needle: string): boolean {
  let i = 0;
  for (const ch of needle) {
    const found = haystack.indexOf(ch, i);
    if (found < 0) return false;
    i = found + 1;
  }
  return true;
}

