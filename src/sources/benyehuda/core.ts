/**
 * Download and load the Ben-Yehuda library (plan W7.7), with the storage and
 * the fetch passed in.
 */
import { CATALOGUE_PATH, CATALOGUE_SHA256, CATALOGUE_URL, LIBRARY_DIR, Library, MAX_CATALOGUE_BYTES, MAX_WORK_BYTES, parseCatalogue, parseWorkNote, publicDomainOnly, renderWorkNote, textUrl, workNotePath, type Work } from "./library";
import { sha256Hex } from "../datagov/snapshot";

export interface LibraryStore {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  list(dir: string): Promise<string[]>;
}

export class BenYehudaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BenYehudaError";
  }
}

/** A response's text, at most `limit` bytes (review 20, RR20-5): a larger answer is refused, not read whole. */
export async function boundedText(url: string, f: typeof fetch, limit: number, signal?: AbortSignal): Promise<string> {
  const res = await f(url, signal ? { signal } : undefined);
  if (!res.ok) throw new BenYehudaError(`answered ${res.status}`, res.status);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new BenYehudaError(`too large: ${declared} bytes`);
  if (!res.body) {
    const t = await res.text();
    if (new TextEncoder().encode(t).length > limit) throw new BenYehudaError("too large");
    return t;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new BenYehudaError(`too large: over ${limit} bytes`);
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return new TextDecoder().decode(all);
}

/** The catalogue: the saved copy, or (on request) the dump's. */
export async function catalogue(deps: { store: LibraryStore; fetch?: typeof fetch; signal?: AbortSignal; expectSha256?: string }): Promise<Work[]> {
  const want = deps.expectSha256 ?? CATALOGUE_SHA256;
  const saved = await deps.store.read(CATALOGUE_PATH);
  // A saved catalogue counts only when it is the pinned one: a synced or shared vault can't widen the list.
  if (saved && (await sha256Hex(saved)) === want) return parseCatalogue(saved);
  if (!deps.fetch) return [];
  const csv = await boundedText(CATALOGUE_URL, deps.fetch, MAX_CATALOGUE_BYTES, deps.signal);
  if ((await sha256Hex(csv)) !== want) throw new BenYehudaError("the catalogue is not the pinned one");
  const works = parseCatalogue(csv);
  if (!works.length) throw new BenYehudaError("the catalogue is empty");
  await deps.store.write(CATALOGUE_PATH, csv);
  return works;
}

/** Authors in the catalogue, by number of works. */
export function authorsOf(works: readonly Work[]): Array<{ name: string; count: number }> {
  const n = new Map<string, number>();
  for (const w of works) if (w.authors) n.set(w.authors, (n.get(w.authors) ?? 0) + 1);
  return [...n].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "he"));
}

/**
 * Download every work of the chosen authors (four at a time). Works already
 * saved are skipped. `onProgress` reports done/total.
 */
export async function downloadAuthors(
  authors: readonly string[],
  deps: { store: LibraryStore; fetch: typeof fetch; retrieved?: string; onProgress?: (done: number, total: number) => void; signal?: AbortSignal; expectSha256?: string },
): Promise<{ works: number; skipped: number }> {
  const all = await catalogue(deps);
  // One failure (or the user's cancel) stops every worker (review 20, RR20-5).
  const stop = new AbortController();
  const outer = deps.signal;
  if (outer) {
    if (outer.aborted) stop.abort(outer.reason);
    else outer.addEventListener("abort", () => stop.abort(outer.reason), { once: true });
  }
  const want = new Set(authors);
  const todo = all.filter((w) => want.has(w.authors));
  const retrieved = deps.retrieved ?? new Date().toISOString().slice(0, 10);
  let done = 0;
  let skipped = 0;
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      if (stop.signal.aborted) return;
      const w = todo[next++];
      const path = workNotePath(w);
      if (await deps.store.read(path)) skipped++;
      else {
        const body = await boundedText(textUrl(w), deps.fetch, MAX_WORK_BYTES, stop.signal);
        if (stop.signal.aborted) return;
        await deps.store.write(path, renderWorkNote(w, body, retrieved));
      }
      done++;
      deps.onProgress?.(done, todo.length);
    }
  };
  const run = async () => {
    try {
      await worker();
    } catch (e) {
      stop.abort(e);
      throw e;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, run));
  if (outer?.aborted) throw new BenYehudaError("cancelled");
  return { works: done - skipped, skipped };
}

/** The library from the vault alone: the saved catalogue and the saved works. No request. */
export async function loadLibrary(store: LibraryStore, expectSha256?: string): Promise<Library> {
  const works = await catalogue({ store, expectSha256 });
  const texts: Array<{ id: number; text: string }> = [];
  for (const p of await store.list(LIBRARY_DIR)) {
    if (!p.endsWith(".md")) continue;
    const md = await store.read(p);
    const w = md ? parseWorkNote(md) : null;
    if (w) texts.push(w);
  }
  return new Library(works, publicDomainOnly(texts, works));
}
