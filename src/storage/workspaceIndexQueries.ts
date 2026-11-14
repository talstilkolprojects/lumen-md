/**
 * The workspace index's queries (plan W6.25: moved out of workspaceIndex.ts
 * unchanged; ./workspaceIndex.ts re-exports every one).
 */
import { listWorkspaceTree, type WorkspaceNode } from "./workspace";
import type { BacklinkHit, IndexStats, SearchHit } from "./vaultIndexCore";
import type { IndexEngine } from "./vaultIndexProtocol";
import { checkedIndex, getEngine, verified, withEngine } from "./workspaceIndex";
import { cache, type IndexedFile } from "./workspaceIndexState";

// ── Queries ─────────────────────────────────────────────────────────────

/**
 * Every indexed note (after ensureIndex) — for the tags panel and other views.
 * Review 14.11 T7: while a trusted snapshot is still being checked against
 * the vault, none — a note deleted while the app was closed must not show its
 * name, tags or links. Views wait for `indexChecked()` (or re-derive on
 * `indexVersion()`).
 */
export function indexedFiles(): IndexedFile[] {
  if (cache.verify) return [];
  return [...cache.byPath.values()];
}

/**
 * The file tree (directories first, then files, by name) — the same
 * listing the index re-validates against, so after a structural change the
 * vault is listed once for both.
 */
export async function workspaceTree(): Promise<WorkspaceNode[]> {
  const generation = cache.generation;
  const tree = await listWorkspaceTree();
  if (generation === cache.generation) cache.listing = { generation, tree };
  return tree;
}

/** Find files whose wiki-links point at the given target (path or basename). */
export async function findBacklinks(targetPath: string): Promise<BacklinkHit[]> {
  await checkedIndex();
  if (!cache.byPath.size) return [];
  return withEngine((e) => e.backlinks(targetPath));
}

/** Cheap fuzzy + substring search across filenames, paths, and content. */
export async function searchWorkspace(
  query: string,
  /** `filter`: only these paths — applied before `limit`. */
  opts: { limit?: number; filter?: (path: string) => boolean } = {},
): Promise<SearchHit[]> {
  await checkedIndex();
  if (!cache.byPath.size) return [];
  const filter = opts.filter;
  // A function cannot cross into the worker: send the paths it allows.
  const paths = filter ? [...cache.byPath.keys()].filter((p) => filter(p)) : undefined;
  return withEngine((e) => e.search(query, { limit: opts.limit ?? 30, paths }));
}

/**
 * W2.22 — the text of indexed notes, read from the index (the main thread
 * keeps summaries only). For a view that reads the text once and lets it go:
 * each note's summary with its `content`. All notes when `paths` is omitted.
 */
export async function indexedNotes(paths?: readonly string[]): Promise<Array<IndexedFile & { content: string }>> {
  await checkedIndex();
  if (!cache.byPath.size) return [];
  const want = paths ? paths.filter((p) => cache.byPath.has(p)) : undefined;
  if (want && !want.length) return [];
  const texts = await withEngine((e) => e.texts(want ? [...want] : undefined));
  const out: Array<IndexedFile & { content: string }> = [];
  for (const t of texts) {
    const f = cache.byPath.get(t.path);
    if (f) out.push({ ...f, content: t.content });
  }
  return out;
}

/** One note's text from the index, or null when it is not indexed. */
export async function indexedNoteText(path: string): Promise<string | null> {
  return (await indexedNotes([path]))[0]?.content ?? null;
}

/** Notes related to a paragraph (plan W2.2), ranked by the index's BM25 in the index worker. */
export async function relatedInIndex(query: import("./vaultIndexProtocol").RelatedQuery): Promise<import("../related/related").RelatedHit[]> {
  await checkedIndex();
  return withEngine((e) => e.related(query));
}

/**
 * Run a ```tasks``` query over every note in the vault (plan 4.13), in the
 * index worker. Dates in the query are relative to the user's local today.
 */
export async function queryVaultTasks(query: string, today = new Date()): Promise<import("../tasks/taskQuery").QueryResult> {
  await checkedIndex();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return withEngine((e) => e.tasks(query, iso));
}

/**
 * W6.36: resolves once the snapshot the index opened from has been checked
 * against the vault (at once when it opened otherwise). Queries wait for it
 * themselves; a view showing `indexedFiles()` can wait for it to re-derive.
 */
export function indexChecked(): Promise<void> {
  return verified();
}

/** Changes whenever the indexed files do: a cache of something derived from them is good while it is the same. */
export function indexVersion(): number {
  return cache.version;
}

/** Work counters of the index (files, notes indexed so far…) — for tests and the perf spec. */
export async function indexStats(): Promise<IndexStats & { engine: IndexEngine["kind"] }> {
  const stats = await withEngine((e) => e.stats());
  return { ...stats, engine: (await getEngine()).kind };
}
