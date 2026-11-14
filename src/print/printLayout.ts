/**
 * Print and PDF layout at word-processor level, Hebrew first (W2.23).
 *
 * The browser's print engine does the typesetting: Chromium (131+) draws the
 * page-margin boxes of `@page`, so headers, footers and page numbers are
 * plain CSS. Hebrew page numbers (א, ב, ג … יא) use the CSS `hebrew`
 * counter style.
 *
 * - Direction and language come from the note's content, not the app's
 *   interface language: a Hebrew note prints right to left with `lang="he"`
 *   even from the English UI. With the right `lang`, the PDF text layer
 *   copies and searches in logical order.
 * - Header: the note's title (or the `header:` frontmatter), centred.
 *   Footer: the page number, "page / pages", in `decimal` or `hebrew`.
 * - Page breaks never split a table row, an image, a figure, a code block,
 *   a callout or display math; a heading stays with what follows it; table
 *   headers repeat on every page. `\newpage` or `\pagebreak` alone in a
 *   paragraph (Pandoc's spelling) forces a break.
 * - An optional table of contents (`toc: true`), with links that keep
 *   working in the PDF.
 * - Fonts: the app's embedded OFL faces (Heebo, Frank Ruhl Libre, Inter,
 *   Source Serif 4) come first, so the PDF embeds them instead of a system
 *   fallback.
 *
 * Footnotes print as endnotes at the end of the document. Chromium does not
 * support `float: footnote`, so per-page footnotes would need a paged-media
 * polyfill; see docs/workspace/print.
 */
import { firstStrongDirection } from "../lib/textDirection";

export type PageNumbering = "decimal" | "hebrew" | "none";

export interface PrintOptions {
  title: string;
  /** Header text; the title when unset, nothing when "". */
  header?: string;
  /** Footer text before the page number. */
  footer?: string;
  numbering?: PageNumbering;
  /** Insert a table of contents (h1–h3) after the title. */
  toc?: boolean;
  /** Heading of the table of contents, in the note's language. */
  tocTitle?: string;
  pageSize?: "A4" | "Letter";
  dir: "rtl" | "ltr";
}

/** A CSS string literal (for `content:`), safe for any title. */
export function cssString(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\r\n\f]+/g, " ").replace(/[<>]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;
}

const HEBREW = /[\u0590-\u05FF]/g;
const ARABIC = /[\u0600-\u06FF]/g;
const LATIN = /[A-Za-z]/g;

/** The note's main language for `lang`, from its letters: he, ar, or the UI language. */
export function contentLang(text: string, fallback: string): string {
  const he = text.match(HEBREW)?.length ?? 0;
  const ar = text.match(ARABIC)?.length ?? 0;
  const la = text.match(LATIN)?.length ?? 0;
  if (he > la && he >= ar) return "he";
  if (ar > la && ar > he) return "ar";
  return fallback === "he" || fallback === "ar" ? "en" : fallback;
}

/** The note's base direction: its first strong letter, outside code and markup. */
export function contentDirection(markdown: string): "rtl" | "ltr" {
  const body = markdown
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\]\([^)]*\)/g, "]");
  return firstStrongDirection(body) ?? "ltr";
}

/** Print settings from the note's frontmatter (`toc`, `page-numbers`, `header`, `footer`, `page-size`). */
export function printFrontmatter(fm: Record<string, unknown> | null | undefined): Partial<PrintOptions> {
  if (!fm) return {};
  const out: Partial<PrintOptions> = {};
  if (fm.toc === true || fm.toc === "true") out.toc = true;
  const pn = String(fm["page-numbers"] ?? fm.pageNumbers ?? "");
  if (pn === "hebrew" || pn === "decimal" || pn === "none") out.numbering = pn;
  if (typeof fm.header === "string") out.header = fm.header;
  if (typeof fm.footer === "string") out.footer = fm.footer;
  const size = String(fm["page-size"] ?? "");
  if (size === "Letter" || size === "letter") out.pageSize = "Letter";
  if (size === "A4" || size === "a4") out.pageSize = "A4";
  return out;
}

export function printCss(o: PrintOptions): string {
  const header = o.header ?? o.title;
  const numbering = o.numbering ?? "decimal";
  const pageNo =
    numbering === "none"
      ? '""'
      : `counter(page, ${numbering}) " / " counter(pages, ${numbering})`;
  const footer = o.footer ? `${cssString(o.footer)} "  ·  " ` : "";
  const margin = "font: 9pt var(--font-sans, Heebo, Inter, sans-serif); color: #666;";
  return `
@page {
  size: ${o.pageSize ?? "A4"};
  margin: 22mm 18mm 20mm 18mm;
  @top-center { content: ${header ? cssString(header) : '""'}; ${margin} }
  @bottom-center { content: ${footer}${pageNo}; ${margin} direction: ${o.dir}; }
}
@page :first { @top-center { content: ""; } }
html { direction: ${o.dir}; }
body {
  margin: 0;
  font-family: Inter, Heebo, "Source Serif 4", "Frank Ruhl Libre", system-ui, sans-serif;
  font-size: 11.5pt;
  line-height: 1.55;
  orphans: 3;
  widows: 3;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
:lang(he), :lang(ar) { font-family: Heebo, "Frank Ruhl Libre", Inter, system-ui, sans-serif; }
h1, h2, h3, h4, h5, h6 { break-after: avoid-page; break-inside: avoid; }
table, figure, img, svg, pre, .code-block, .callout, .admonition, .katex-display, .mermaid-block, .chart-block, blockquote { break-inside: avoid; }
tr, li { break-inside: avoid; }
thead { display: table-header-group; }
tfoot { display: table-footer-group; }
img { max-width: 100%; height: auto; }
.page-break { break-after: page; height: 0; }
a { color: inherit; text-decoration: underline; }
.print-title { font-size: 22pt; margin: 0 0 6mm; }
.print-toc { break-after: page; }
.print-toc ol { list-style: none; padding-inline-start: 0; }
.print-toc ol ol { padding-inline-start: 1.25em; }
.print-toc li { margin: 0.2em 0; }
.print-toc a { text-decoration: none; }
section.footnotes, section[data-footnotes] { break-before: auto; font-size: 9.5pt; border-top: 1px solid #ccc; margin-top: 8mm; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
@media screen { body { max-width: 190mm; margin: 12mm auto; padding: 0 8mm; } }
`;
}

/** Turn `\newpage` / `\pagebreak` paragraphs into page breaks. */
export function applyPageBreaks(root: ParentNode): number {
  let n = 0;
  root.querySelectorAll("p").forEach((p) => {
    if (/^\s*\\(newpage|pagebreak)\s*$/.test(p.textContent ?? "")) {
      const div = p.ownerDocument.createElement("div");
      div.className = "page-break";
      p.replaceWith(div);
      n++;
    }
  });
  return n;
}

/** A table of contents of the h1–h3 headings that have ids. Null if fewer than two. */
export function buildToc(root: ParentNode, title: string): HTMLElement | null {
  const doc = (root as Node).ownerDocument ?? (root as Document);
  const heads = Array.from(root.querySelectorAll("h1[id], h2[id], h3[id]"));
  if (heads.length < 2) return null;
  const nav = doc.createElement("nav");
  nav.className = "print-toc";
  nav.setAttribute("dir", "auto");
  const h = doc.createElement("h2");
  h.textContent = title;
  nav.appendChild(h);
  const top = doc.createElement("ol");
  nav.appendChild(top);
  const stack: { level: number; list: HTMLElement }[] = [{ level: Number(heads[0].tagName[1]), list: top }];
  for (const el of heads) {
    const level = Number(el.tagName[1]);
    while (stack.length > 1 && level < stack[stack.length - 1].level) stack.pop();
    let cur = stack[stack.length - 1];
    if (level > cur.level) {
      const sub = doc.createElement("ol");
      (cur.list.lastElementChild ?? cur.list).appendChild(sub);
      cur = { level, list: sub };
      stack.push(cur);
    }
    const li = doc.createElement("li");
    const a = doc.createElement("a");
    a.href = `#${el.id}`;
    a.textContent = el.textContent ?? "";
    li.appendChild(a);
    cur.list.appendChild(li);
  }
  return nav;
}
