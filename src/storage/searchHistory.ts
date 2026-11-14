/**
 * Tiny localStorage-backed search-history store. Records the last 8
 * non-empty workspace-search queries (BM25 / Smart / Ask) so the user
 * can re-run a recent search with one click. Persists across reloads
 * and survives private mode (silent fallback to in-memory).
 */

const STORAGE_KEY = "lumen.search.history";
const MAX_ENTRIES = 8;

let memoryFallback: string[] = [];

function load(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string") : [];
  } catch {
    return memoryFallback;
  }
}

function save(history: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    memoryFallback = history.slice();
  }
}

/** Push a query; dedupes (same query bumps to top), trims to MAX_ENTRIES. */
export function rememberSearch(query: string): void {
  const q = query.trim();
  if (q.length < 2) return; // ignore noise
  const current = load();
  const without = current.filter((s) => s.toLowerCase() !== q.toLowerCase());
  const next = [q, ...without].slice(0, MAX_ENTRIES);
  save(next);
}

/** Get the recent queries, most-recent first. */
export function getSearchHistory(): string[] {
  return load();
}

/** Clear all history. */
export function clearSearchHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* why: storage denied: the in-memory history is cleared below */
  }
  memoryFallback = [];
}

/** Remove a single entry. */
export function forgetSearch(query: string): void {
  const current = load();
  save(current.filter((s) => s !== query));
}
