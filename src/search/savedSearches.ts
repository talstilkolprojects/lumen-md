/**
 * Saved searches (plan W2.12): named queries in the 11.3 syntax, listed in
 * the sidebar; a click opens the search dialog on that query. Kept per
 * browser in localStorage (like the recent searches), never in the vault.
 */

export interface SavedSearch {
  name: string;
  query: string;
}

const KEY = "lumen-saved-searches";
export const SAVED_SEARCHES_CHANGED = "lumen-saved-searches-changed";
/** Opens the search dialog; `detail.query` fills its box. */
export const OPEN_SEARCH = "lumen-open-search";
const MAX = 100;

export function savedSearches(): SavedSearch[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is SavedSearch => !!x && typeof x === "object" && typeof (x as SavedSearch).name === "string" && typeof (x as SavedSearch).query === "string");
  } catch {
    return [];
  }
}

function write(list: SavedSearch[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // why: storage is blocked or full (private mode, quota): the setting holds for this session only
    /* private mode / quota: the list stays as it was */
  }
  window.dispatchEvent(new Event(SAVED_SEARCHES_CHANGED));
}

/** Save (or rename) a search; the same query is kept once, newest first. */
export function saveSearch(query: string, name?: string): SavedSearch | null {
  const q = query.trim();
  if (!q) return null;
  const entry = { name: (name ?? "").trim() || q, query: q };
  write([entry, ...savedSearches().filter((s) => s.query !== q)]);
  return entry;
}

export function removeSavedSearch(query: string): void {
  write(savedSearches().filter((s) => s.query !== query));
}

export function isSaved(query: string): boolean {
  const q = query.trim();
  return savedSearches().some((s) => s.query === q);
}

export function openSearch(query: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_SEARCH, { detail: { query } }));
}
