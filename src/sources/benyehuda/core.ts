/**
 * Download and load the Ben-Yehuda library (plan W7.7), with the storage and
 * the fetch passed in.
 */
import { CATALOGUE_PATH, CATALOGUE_URL, LIBRARY_DIR, Library, parseCatalogue, parseWorkNote, publicDomainOnly, renderWorkNote, textUrl, workNotePath, type Work } from "./library";

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

async function text(url: string, f: typeof fetch): Promise<string> {
  const res = await f(url);
  if (!res.ok) throw new BenYehudaError(`answered ${res.status}`, res.status);
  return res.text();
}

/** The catalogue: the saved copy, or (on request) the dump's. */
export async function catalogue(deps: { store: LibraryStore; fetch?: typeof fetch }): Promise<Work[]> {
  const saved = await deps.store.read(CATALOGUE_PATH);
  if (saved) return parseCatalogue(saved);
  if (!deps.fetch) return [];
  const csv = await text(CATALOGUE_URL, deps.fetch);
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
  deps: { store: LibraryStore; fetch: typeof fetch; retrieved?: string; onProgress?: (done: number, total: number) => void; signal?: AbortSignal },
): Promise<{ works: number; skipped: number }> {
  const all = await catalogue(deps);
  const want = new Set(authors);
  const todo = all.filter((w) => want.has(w.authors));
  const retrieved = deps.retrieved ?? new Date().toISOString().slice(0, 10);
  let done = 0;
  let skipped = 0;
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      if (deps.signal?.aborted) return;
      const w = todo[next++];
      const path = workNotePath(w);
      if (await deps.store.read(path)) skipped++;
      else await deps.store.write(path, renderWorkNote(w, await text(textUrl(w), deps.fetch), retrieved));
      done++;
      deps.onProgress?.(done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
  return { works: done - skipped, skipped };
}

/** The library from the vault alone: the saved catalogue and the saved works. No request. */
export async function loadLibrary(store: LibraryStore): Promise<Library> {
  const works = await catalogue({ store });
  const texts: Array<{ id: number; text: string }> = [];
  for (const p of await store.list(LIBRARY_DIR)) {
    if (!p.endsWith(".md")) continue;
    const md = await store.read(p);
    const w = md ? parseWorkNote(md) : null;
    if (w) texts.push(w);
  }
  return new Library(works, publicDomainOnly(texts, works));
}
