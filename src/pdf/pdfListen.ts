/**
 * Listening to a PDF (plan W2.6, step 3): the reader's pages as one text for
 * read-aloud, and which page each part came from, so the reader can follow
 * the voice page by page. Pure; the PDF reader feeds it each page's text
 * layer (or its OCR text).
 *
 * What a page's text needs before a voice reads it:
 * - Hebrew that a PDF stores in visual order is put back in reading order
 *   (src/paste/pdfHebrew.ts, the same fix as for pasted PDF text);
 * - a word broken across lines with a hyphen is joined (Latin letters only:
 *   in Hebrew the maqaf is its own character and stays);
 * - lines inside a paragraph are joined, so a sentence isn't cut at every
 *   line end; a blank line still ends a paragraph.
 * Read-aloud's own sentence splitter (src/ai/tts.ts) drops the marks that
 * would be markup (#, >, *), so a PDF line starting with one reads its words.
 */
import { suggestPdfHebrewFix } from "../paste/pdfHebrew";

export interface ListeningText {
  text: string;
  /** For each page in order: its number and where its text starts in `text`. */
  pages: { page: number; from: number }[];
}

/** One page's text, cleaned for reading. */
export function pageForListening(raw: string): string {
  const fixed = suggestPdfHebrewFix(raw)?.fixed ?? raw;
  return fixed
    .replace(/\r\n?/g, "\n")
    .replace(/([A-Za-z])-\n([a-z])/g, "$1$2")
    .split(/\n\s*\n/)
    .map((para) => para.split("\n").map((l) => l.trim()).filter(Boolean).join(" "))
    .filter(Boolean)
    .join("\n\n");
}

/** The pages (in order, each with its text) as one text for read-aloud. Pages without text are left out. */
export function listeningText(pages: readonly { page: number; text: string }[]): ListeningText {
  let text = "";
  const out: ListeningText["pages"] = [];
  for (const p of pages) {
    const clean = pageForListening(p.text);
    if (!clean) continue;
    if (text) text += "\n\n";
    out.push({ page: p.page, from: text.length });
    text += clean;
  }
  return { text, pages: out };
}

/** The page that the text at `offset` came from (the first page for an offset before any). */
export function pageAt(t: ListeningText, offset: number): number | null {
  let page: number | null = t.pages[0]?.page ?? null;
  for (const p of t.pages) {
    if (p.from > offset) break;
    page = p.page;
  }
  return page;
}
