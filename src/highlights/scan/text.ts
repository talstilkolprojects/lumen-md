/**
 * From OCR'd marks to highlights (plan W7.2): join the lines of one marked
 * passage, undo end-of-line hyphenation, find the page number, and build the
 * book the highlights hub (W1.15) already knows how to write.
 */
import { highlightId, type ImportedBook, type ImportedHighlight } from "../import/model";

const LATIN_LETTER = /\p{Script=Latin}/u;

/**
 * Join OCR lines into one passage. A Latin word broken with a hyphen at the
 * line end before a lower-case continuation (`hyphen-` / `ated`) is taken as
 * print hyphenation and joined without it; before a capital (`Jean-` /
 * `Paul`) the hyphen stays. Hebrew lines join with a space, and a maqaf at
 * the line end stays and joins without one (it binds the word pair).
 */
export function joinLines(lines: readonly string[]): string {
  let out = "";
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    if (!out) {
      out = line;
      continue;
    }
    const m = /(\p{L}+)[-\u00AD\u2010]$/u.exec(out);
    if (m && LATIN_LETTER.test(m[1]) && /^\p{Ll}/u.test(line)) {
      // Soft or hard hyphen at the end of a Latin line, the word goes on in lower case: one word.
      out = out.slice(0, -1) + line;
    } else if (/[-\u2010]$/.test(out) && /^\p{Lu}/u.test(line)) {
      out += line;
    } else if (/\u05BE$/.test(out)) {
      out += line;
    } else out += " " + line;
  }
  return out.replace(/\s+([,.;:!?)\]])/g, "$1").trim();
}

/**
 * The printed page number: a header or footer line that is only a number,
 * perhaps with dashes or "p." / "עמ׳" around it. The bottom line wins over
 * the top (footers are where most books put it).
 */
export function pageNumberOf(lines: ReadonlyArray<{ text: string; y: number }>, pageHeight: number): number | null {
  const near = lines.filter((l) => l.y < pageHeight * 0.12 || l.y > pageHeight * 0.85);
  const re = /^(?:[-–—\s]*)(?:p\.?|page|עמ['׳]?|עמוד)?\s*(\d{1,4})(?:\s*[-–—]*)$/iu;
  const hits = near.map((l) => ({ y: l.y, m: re.exec(l.text.trim()) })).filter((x) => x.m);
  if (!hits.length) return null;
  hits.sort((a, b) => b.y - a.y);
  return Number(hits[0].m![1]);
}

export interface ScannedMark {
  text: string;
  color: string;
}

export interface ScanBook {
  title: string;
  author: string;
  isbn?: string;
}

/** A plausible ISBN-10 or ISBN-13 (check digit verified), digits only; null otherwise. */
export function cleanIsbn(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{9}[\dX]$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (s[i] === "X" ? 10 : Number(s[i])) * (10 - i);
    return sum % 11 === 0 ? s : null;
  }
  if (/^\d{13}$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 ? 3 : 1);
    return sum % 10 === 0 ? s : null;
  }
  return null;
}

/** The highlights of one scanned page, as a book the hub merges into its note (same ids as any importer). */
export function scannedBook(book: ScanBook, marks: readonly ScannedMark[], page: number | null, now = new Date()): ImportedBook {
  const highlights: ImportedHighlight[] = marks
    .filter((m) => m.text.trim())
    .map((m, i) => ({
      id: highlightId(book.title, book.author, m.text),
      text: m.text.trim(),
      note: "",
      location: page === null ? null : `p. ${page}`,
      sort: (page ?? 0) * 1000 + i,
      created: now.toISOString(),
      color: m.color,
      tags: [],
      link: null,
    }));
  return { source: "scan", title: book.title, author: book.author, link: book.isbn ? `urn:isbn:${book.isbn}` : null, highlights };
}

export interface ReadMark {
  text: string;
  color: string;
  box: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Marks that continue one another become one passage: the same colour, on
 * the next line (its top within about a line's height of the previous
 * bottom). A highlight that runs over three lines is one highlight.
 */
export function groupPassages(marks: readonly ReadMark[]): ScannedMark[] {
  const out: Array<{ lines: string[]; color: string; last: ReadMark["box"] }> = [];
  for (const m of marks) {
    if (!m.text.trim()) continue;
    const prev = out[out.length - 1];
    const lineH = Math.max(1, m.box.y1 - m.box.y0);
    const next = prev && prev.color === m.color && m.box.y0 > prev.last.y0 + lineH * 0.5 && m.box.y0 - prev.last.y1 <= lineH * 1.6;
    if (next) {
      prev.lines.push(m.text);
      prev.last = m.box;
    } else out.push({ lines: [m.text], color: m.color, last: m.box });
  }
  return out.map((p) => ({ text: joinLines(p.lines.flatMap((l) => l.split("\n"))), color: p.color }));
}
