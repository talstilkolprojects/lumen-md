/**
 * A book as a print document (plan W5.8): title page, table of contents,
 * each chapter on a new page, page numbers in the bottom margin, the book's
 * Hebrew font, and `dir` / `lang` on the document so the browser's
 * "Save as PDF" lays out Hebrew right to left. Pure: the caller renders the
 * chapters and opens the print window.
 */
import { escapeXml } from "./epub";

export interface PrintChapter {
  title: string;
  html: string;
  lang: string;
  dir: "rtl" | "ltr";
}

export interface PrintBook {
  title: string;
  author?: string;
  lang: string;
  dir: "rtl" | "ltr";
  chapters: PrintChapter[];
  /** `@font-face` sources (URLs the print window can load). */
  fonts?: Array<{ family: string; url: string; weight: number }>;
  labels: { contents: string };
  /** Page size; A5 is a common Hebrew trade paperback. */
  size?: "A5" | "A4" | "6in 9in";
}

export function bookPrintCss(book: Pick<PrintBook, "fonts" | "size" | "dir">): string {
  const faces = (book.fonts ?? []).map((f) => `@font-face { font-family: "${f.family}"; src: url("${f.url}"); font-weight: ${f.weight}; }`).join("\n");
  const family = [...new Set((book.fonts ?? []).map((f) => `"${f.family}"`)), '"Frank Ruhl Libre"', '"David Libre"', '"Noto Serif Hebrew"', "serif"].join(", ");
  return `${faces}
@page { size: ${book.size ?? "A5"}; margin: 18mm 16mm 20mm; @bottom-center { content: counter(page); font-family: ${family}; font-size: 9pt; } }
@page :first { @bottom-center { content: none; } }
@page blank { @bottom-center { content: none; } }
html { font-family: ${family}; font-size: 11pt; line-height: 1.55; color: #000; background: #fff; }
body { margin: 0; }
.title-page { page: blank; break-after: page; text-align: center; padding-top: 35%; }
.title-page h1 { font-size: 26pt; margin: 0 0 12pt; }
.title-page .author { font-size: 14pt; }
nav.toc { page: blank; break-after: page; }
nav.toc ol { list-style: none; padding: 0; margin: 0; }
nav.toc li { margin: 4pt 0; }
nav.toc a { color: inherit; text-decoration: none; }
section.chapter { break-before: page; }
h1.chapter-title { font-size: 20pt; margin: 30mm 0 14mm; text-align: center; break-after: avoid; }
h2, h3 { break-after: avoid; }
p { margin: 0; text-indent: 1.5em; text-align: justify; orphans: 2; widows: 2; }
h1 + p, h2 + p, h3 + p, blockquote p, li p { text-indent: 0; }
img, table, pre, blockquote, figure { break-inside: avoid; max-width: 100%; }
pre, code { direction: ltr; unicode-bidi: isolate; font-size: 9pt; }
pre { white-space: pre-wrap; }
a { color: inherit; }
`;
}

/** The `<body>` of the print document. */
export function bookPrintBody(book: PrintBook): string {
  const id = (i: number) => `chapter-${i + 1}`;
  const title = `<section class="title-page"><h1>${escapeXml(book.title)}</h1>${book.author ? `<p class="author">${escapeXml(book.author)}</p>` : ""}</section>`;
  const toc = `<nav class="toc" aria-label="${escapeXml(book.labels.contents)}"><h1>${escapeXml(book.labels.contents)}</h1><ol>${book.chapters.map((c, i) => `<li><a href="#${id(i)}">${escapeXml(c.title)}</a></li>`).join("")}</ol></nav>`;
  const chapters = book.chapters
    .map((c, i) => `<section class="chapter" id="${id(i)}" lang="${c.lang}" dir="${c.dir}"><h1 class="chapter-title">${escapeXml(c.title)}</h1>${c.html}</section>`)
    .join("\n");
  return `${title}\n${toc}\n${chapters}`;
}

/** A complete HTML document (for a print window, or a headless browser that writes the PDF). */
export function bookPrintDocument(book: PrintBook): string {
  return `<!doctype html>\n<html lang="${book.lang}" dir="${book.dir}"><head><meta charset="utf-8"><title>${escapeXml(book.title)}</title><style>${bookPrintCss(book)}</style></head><body>\n${bookPrintBody(book)}\n</body></html>\n`;
}
