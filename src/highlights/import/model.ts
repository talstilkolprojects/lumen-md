/**
 * Imported highlights (plan W2.15): the shape every importer produces
 * (Kindle, Kobo, Readwise, Zotero) before it is written into the vault.
 */

/** `scan`: highlights photographed on a printed page (plan W7.2). */
export type ImportSource = "kindle" | "kobo" | "readwise" | "zotero" | "scan";
export const IMPORT_SOURCES: readonly ImportSource[] = ["kindle", "kobo", "readwise", "zotero"];

export interface ImportedHighlight {
  /** Stable across imports and sources: the book and the text (see highlightId). */
  id: string;
  /** The highlighted passage ("" for a note on its own). */
  text: string;
  note: string;
  /** "p. 12", "loc. 180–182", "Chapter 3 · 45%" … or null. */
  location: string | null;
  /** For the order inside the book. */
  sort: number;
  /** ISO time, when the source gives one that parses. */
  created: string | null;
  color: string | null;
  tags: string[];
  /** Back to the source item (Zotero: the annotation in its PDF). */
  link: string | null;
}

export interface ImportedBook {
  source: ImportSource;
  title: string;
  author: string;
  /** Back to the item in its app (Zotero: zotero://select/…), or null. */
  link: string | null;
  highlights: ImportedHighlight[];
}

export interface ImportReport {
  books: ImportedBook[];
  /** What was read but not imported (bookmarks, image annotations, rows without text), by reason. */
  skipped: Record<string, number>;
}

/** Text for comparing: Unicode NFC, niqqud and cantillation removed, case and spacing folded. */
export function normText(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[“”\u05F4]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** 64-bit FNV-1a as 12 hex digits: short, stable, no crypto needed (it only has to tell entries apart). */
export function fnv(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x0100019d) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 12);
}

/** The book a highlight belongs to, for ids and for the note it goes into. */
export const bookKey = (title: string, author: string) => `${normText(title)}\u0000${normText(author)}`;

/** A highlight's id: the same passage of the same book is the same highlight, whichever app it came from. */
export function highlightId(title: string, author: string, text: string, note = ""): string {
  return fnv(`${bookKey(title, author)}\u0000${normText(text || note)}`);
}

export function bump(skipped: Record<string, number>, reason: string): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
}

/** Group highlights into books (same title + author), each sorted by position. */
export function groupBooks(source: ImportSource, rows: Array<{ title: string; author: string; link?: string | null; h: ImportedHighlight }>): ImportedBook[] {
  const books = new Map<string, ImportedBook>();
  for (const r of rows) {
    const k = bookKey(r.title, r.author);
    let b = books.get(k);
    if (!b) {
      b = { source, title: r.title.trim(), author: r.author.trim(), link: r.link ?? null, highlights: [] };
      books.set(k, b);
    }
    if (!b.highlights.some((x) => x.id === r.h.id)) b.highlights.push(r.h);
  }
  for (const b of books.values()) b.highlights.sort((a, c) => a.sort - c.sort);
  return [...books.values()];
}
