/**
 * The citation library (plan W2.16): every source the cite dialog finds and
 * every `[@key]` resolves against — the vault's BibTeX files (`*.bib`), its
 * CSL-JSON files (`*.csl.json`, `references.json`, `bibliography.json`) and
 * the local Zotero library, copied into the vault as CSL-JSON
 * (`.lumen/zotero-library.csl.json`) when you sync it from the desktop app.
 * Read on this device; nothing is fetched.
 */
import { parseBibtex } from "../data/bibtex";
import { recordFromBibtex, plainTitle, type CitationRecord } from "../data/citationStyles";
import { cslToRecord, keyFromNote, type CslItem } from "./csl";
import { baseKey, isKey, uniqueKey } from "./keys";

export type Origin = "bibtex" | "csl" | "zotero";

export interface LibraryItem {
  key: string;
  record: CitationRecord;
  origin: Origin;
  /** The vault file it came from. */
  path: string;
}

export const ZOTERO_FILE = ".lumen/zotero-library.csl.json";
export const isLibraryFile = (path: string) => /\.bib$/i.test(path) || /\.csl\.json$/i.test(path) || /(^|\/)(references|bibliography)\.json$/i.test(path);

export function fromBibtex(text: string, path: string): LibraryItem[] {
  return parseBibtex(text).map((e) => ({ key: e.key, record: recordFromBibtex(e), origin: "bibtex" as const, path }));
}

export function fromCslJson(text: string, path: string, origin: Origin = "csl"): LibraryItem[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const items = (Array.isArray(data) ? data : (data as { items?: unknown[] })?.items ?? []) as CslItem[];
  const used = new Set<string>();
  const out: LibraryItem[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object" || !it.title) continue;
    const record = cslToRecord(it);
    const own = it["citation-key"] ?? keyFromNote(it.note) ?? (typeof it.id === "string" && isKey(it.id) && !it.id.includes("/") ? it.id : undefined);
    const key = own && !used.has(own) ? (used.add(own), own) : uniqueKey(baseKey(record), used);
    out.push({ key, record, origin, path });
  }
  return out;
}

/** One library from many files: the first source of a key wins (BibTeX and CSL before the Zotero copy). */
export function mergeLibrary(lists: LibraryItem[][]): LibraryItem[] {
  const seen = new Set<string>();
  const out: LibraryItem[] = [];
  for (const it of lists.flat().sort((a, b) => Number(a.origin === "zotero") - Number(b.origin === "zotero"))) {
    if (seen.has(it.key)) continue;
    seen.add(it.key);
    out.push(it);
  }
  return out;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-֑ͯ-ׇ]/g, "").toLocaleLowerCase("en");

/** Search by key, author, title, year and container; every word must match. Best first. */
export function searchLibrary(items: readonly LibraryItem[], query: string, recent: readonly string[] = []): LibraryItem[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const scored: Array<{ it: LibraryItem; score: number }> = [];
  for (const it of items) {
    const r = it.record;
    const names = r.authors.map((a) => `${a.family} ${a.given ?? ""}`).join(" ");
    const hay = fold(`${it.key} ${names} ${plainTitle(r.title)} ${r.year ?? ""} ${r.container ?? ""}`);
    if (!words.every((w) => hay.includes(w))) continue;
    let score = 0;
    for (const w of words) {
      if (fold(it.key).startsWith(w)) score += 4;
      if (fold(r.authors[0]?.family ?? "").startsWith(w)) score += 3;
      if (r.year === w) score += 2;
    }
    const ri = recent.indexOf(it.key);
    if (ri >= 0) score += 10 - Math.min(ri, 9);
    scored.push({ it, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.it.key.localeCompare(b.it.key)).map((x) => x.it);
}

/* ─── The vault's library, cached until the vault changes ─────────── */

let cache: Promise<LibraryItem[]> | null = null;
let listening = false;

export function invalidateLibrary(): void {
  cache = null;
}

export async function loadLibrary(): Promise<LibraryItem[]> {
  if (!listening && typeof window !== "undefined") {
    listening = true;
    // A library file written (or any file added / removed): read the library again next time.
    window.addEventListener("lumen-workspace-changed", (e) => {
      const d = (e as CustomEvent<{ kind?: string; paths?: string[] }>).detail;
      if (!d?.paths || d.kind !== "content" || d.paths.some((p) => isLibraryFile(p) || p === ZOTERO_FILE)) invalidateLibrary();
    });
  }
  if (!cache) {
    cache = (async () => {
      const ws = await import("../storage/workspace");
      const files = (await ws.listWorkspace({ includeHidden: true }).catch(() => [])).map((f) => f.path).filter((p) => isLibraryFile(p) || p === ZOTERO_FILE);
      const lists = await Promise.all(
        files.map(async (path) => {
          const text = await ws.readWorkspaceFile(path).catch(() => "");
          return /\.bib$/i.test(path) ? fromBibtex(text, path) : fromCslJson(text, path, path === ZOTERO_FILE ? "zotero" : "csl");
        }),
      );
      return mergeLibrary(lists);
    })();
    cache.catch(() => (cache = null));
  }
  return cache;
}
