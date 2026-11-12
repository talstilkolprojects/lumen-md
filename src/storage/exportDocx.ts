/**
 * Export Markdown to a real .docx (Office Open XML) file.
 *
 * Builds a complete, schema-valid OOXML package — [Content_Types].xml,
 * _rels/.rels, word/document.xml, word/_rels/document.xml.rels, word/styles.xml
 * and word/numbering.xml — and zips it with the zero-dep writer in ./zip.
 *
 * Unlike a naive converter, lists are REAL Word lists (numbering.xml +
 * <w:numPr>, with ordered vs. bullet, nested levels and per-list restart),
 * links are REAL hyperlink relationships (<w:hyperlink r:id> + external rel),
 * horizontal rules are a real paragraph border, fenced code is a shaded
 * monospace block, and pipe-table column alignment (`:--`, `--:`, `:--:`) is
 * honoured — resolved against each cell's direction, since Word reads
 * `w:jc` as leading / trailing edge (plan 9.8); a Hebrew table is laid
 * out from the right (`w:bidiVisual`). Headings/Hyperlink/Code/Quote all carry defined styles so they
 * render identically in Word, LibreOffice, Pages and Google Docs.
 *
 * Footnotes (`[^id]` with a `[^id]: text` definition) are real Word
 * footnotes (word/footnotes.xml), each note's paragraph in its own direction.
 *
 * With an academic template (plan W5.16, ./academicTemplates) the package
 * also gets a title page, a table-of-contents field, page numbers in the
 * footer (the front matter optionally in Hebrew letters or Roman numerals,
 * the body from 1), the institution's margins, fonts and spacing, chapters
 * on a new page and a hanging-indent bibliography.
 *
 * Not handled: embedded images (noted, not embedded).
 */
import { firstStrongDirection, markdownBaseDirection, type BaseDirection } from "../lib/textDirection";
import { inlineMathSpans } from "../lib/mathIsolate";
import { zip } from "./zip";
import { BIBLIOGRAPHY_HEADING, COVER_LABELS, cmToTwips, lineTwips, splitCover, type AcademicTemplate, type CoverFields, type PageNumberFormat } from "./academicTemplates";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";

const BULLET_NUM_ID = 1; // numbering.xml <w:num> mapped to the bullet abstract
const FIRST_ORDERED_NUM_ID = 2; // ordered lists allocate 2, 3, 4 … (restart each)
const MAX_LIST_LEVEL = 8;

/** Escape text for use in XML text nodes and double-quoted attributes. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  href?: string;
  /** An inline formula's TeX (W5.14): written as an OMML math zone. */
  math?: string;
  /** A footnote reference `[^key]`: resolved against the note's definitions. */
  noteKey?: string;
}

/** Options for an academic submission (plan W5.16). */
export interface AcademicDocxOptions {
  template: AcademicTemplate;
  cover: CoverFields;
  /** Front-matter (table of contents) numbering; defaults to the template's. */
  frontNumbering?: PageNumberFormat;
  /** Add the table of contents (default true). */
  toc?: boolean;
}

export interface DocxOptions {
  academic?: AcademicDocxOptions;
}

/** Mutable state accumulated while rendering the body, consumed by the parts. */
interface DocxCtx {
  /** The note's base direction (frontmatter `dir:` or first strong character): what a table of numbers inherits. */
  baseDir: BaseDirection;
  /** External hyperlink relationships, in document order. */
  hyperlinks: { id: string; target: string }[];
  /** Ordered-list <w:num> instances allocated so each list restarts at 1. */
  orderedNumIds: number[];
  nextRelId: number;
  nextOrderedNumId: number;
  /** `[^key]: text` definitions, removed from the body. */
  footnoteDefs: Map<string, string>;
  /** Footnotes in reference order: key → Word id (1, 2, …) and the rendered note. */
  footnotes: { key: string; id: number; xml: string }[];
  /** Inside the bibliography: entries get the hanging-indent style (academic only). */
  inBibliography: number | null;
  academic?: AcademicDocxOptions;
}

function newCtx(baseDir: BaseDirection = "ltr", academic?: AcademicDocxOptions): DocxCtx {
  return {
    baseDir,
    footnoteDefs: new Map(),
    footnotes: [],
    inBibliography: null,
    academic,
    hyperlinks: [],
    orderedNumIds: [],
    // rId1 = styles, rId2 = numbering (fixed below), rId3 = the page-number
    // footer of an academic document; hyperlinks start after them.
    nextRelId: academic ? 4 : 3,
    nextOrderedNumId: FIRST_ORDERED_NUM_ID,
  };
}

/**
 * Split a markdown line of inline content into styled runs. Recognises
 * `***bold-italic***`, `**bold**`, `*italic*`, `~~strike~~`, `` `code` `` and
 * `[label](url)` links. Links are emitted first so a URL is never mistaken for
 * emphasis.
 */
function parseInline(text: string): Run[] {
  // Formulas first (W5.14): `$a*b$` is math, not emphasis.
  const spans = inlineMathSpans(text);
  if (spans.length) {
    const out: Run[] = [];
    let at = 0;
    for (const [a, b] of spans) {
      if (a > at) out.push(...parseProse(text.slice(at, a)));
      const fence = text.startsWith("$$", a) ? 2 : 1;
      out.push({ text: "", math: text.slice(a + fence, b - fence) });
      at = b;
    }
    if (at < text.length) out.push(...parseProse(text.slice(at)));
    return out;
  }
  return parseProse(text);
}

function parseProse(text: string): Run[] {
  const runs: Run[] = [];
  const re =
    /\[\^([^\]\s]+)\]|\[([^\]]+)\]\(([^)]+)\)|\*\*\*([^*]+?)\*\*\*|\*\*([^*]+?)\*\*|\*([^*]+?)\*|~~([^~]+?)~~|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) runs.push({ text: m[0], noteKey: m[1] });
    else if (m[2] !== undefined) runs.push({ text: m[2], href: m[3] });
    else if (m[4] !== undefined) runs.push({ text: m[4], bold: true, italic: true });
    else if (m[5] !== undefined) runs.push({ text: m[5], bold: true });
    else if (m[6] !== undefined) runs.push({ text: m[6], italic: true });
    else if (m[7] !== undefined) runs.push({ text: m[7], strike: true });
    else if (m[8] !== undefined) runs.push({ text: m[8], code: true });
    last = re.lastIndex;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length ? runs : [{ text }];
}

/** Hebrew / Arabic in the run: Word needs <w:rtl/> to order and shape it. */
const RTL_RUN = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

/** A paragraph whose first strong character is RTL gets <w:bidi/> (T44). */
function bidiOf(runs: Run[]): string {
  // Formulas have no text here: they do not decide the paragraph's direction (W5.14).
  return firstStrongDirection(visibleText(runs)) === "rtl" ? "<w:bidi/>" : "";
}

/** The text a reader sees: a footnote mark is not text. */
function visibleText(runs: Run[]): string {
  return runs.map((r) => (r.noteKey ? "" : r.text)).join("");
}

/**
 * An inline formula as an OMML math zone (W5.14). Word lays a math zone
 * out left to right as one unit inside a right-to-left paragraph, which is
 * what keeps "$x^2+1$" in order in Hebrew. The zone holds the TeX as
 * written; converting TeX to built-up OMML is not done here.
 */
function mathXml(tex: string): string {
  return `<m:oMath><m:r><m:t xml:space="preserve">${esc(tex)}</m:t></m:r></m:oMath>`;
}

function rPrXml(r: Run, hyperlink = false): string {
  const parts: string[] = [];
  if (hyperlink) parts.push('<w:rStyle w:val="Hyperlink"/>');
  if (r.code) parts.push('<w:rStyle w:val="Code"/>');
  // Word draws Hebrew and Arabic with the complex-script properties, so an
  // RTL run needs <w:bCs/> / <w:iCs/> as well (CT_RPr order: b, bCs, i, iCs).
  const rtl = RTL_RUN.test(r.text);
  if (r.bold) parts.push(rtl ? "<w:b/><w:bCs/>" : "<w:b/>");
  if (r.italic) parts.push(rtl ? "<w:i/><w:iCs/>" : "<w:i/>");
  if (r.strike) parts.push("<w:strike/>");
  // CT_RPr order: <w:rtl/> after the formatting toggles.
  if (rtl) parts.push("<w:rtl/>");
  return parts.length ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
}

function bareRunXml(r: Run): string {
  return `<w:r>${rPrXml(r)}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`;
}

/** The Word id of footnote `key`, rendering the note on its first reference. */
function footnoteId(key: string, ctx: DocxCtx): number | null {
  const found = ctx.footnotes.find((f) => f.key === key);
  if (found) return found.id;
  const text = ctx.footnoteDefs.get(key);
  if (text === undefined) return null;
  const id = ctx.footnotes.length + 1;
  const entry = { key, id, xml: "" };
  ctx.footnotes.push(entry); // before rendering: a note citing itself must not loop
  // A link inside a note is written out as its text and address: the
  // footnotes part has no relationships of its own.
  const runs = parseInline(text)
    .filter((r) => r.noteKey === undefined)
    .map((r) => (r.href ? { text: `${r.text} (${r.href})` } : r));
  const mark = '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>';
  entry.xml = `<w:footnote w:id="${id}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/>${bidiOf(runs)}</w:pPr>${mark}${runsXml(runs, ctx)}</w:p></w:footnote>`;
  return id;
}

/** A run becomes a <w:hyperlink> wrapper when it carries an href. */
function runXml(r: Run, ctx: DocxCtx): string {
  if (r.math !== undefined) return mathXml(r.math);
  if (r.noteKey !== undefined) {
    const id = footnoteId(r.noteKey, ctx);
    if (id === null) return bareRunXml({ text: r.text });
    return `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
  }
  if (r.href) {
    const id = `rId${ctx.nextRelId++}`;
    ctx.hyperlinks.push({ id, target: r.href });
    return (
      `<w:hyperlink r:id="${id}">` +
      `<w:r>${rPrXml(r, true)}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>` +
      `</w:hyperlink>`
    );
  }
  return bareRunXml(r);
}

function runsXml(runs: Run[], ctx: DocxCtx): string {
  return runs.map((r) => runXml(r, ctx)).join("");
}

function paraXml(runs: Run[], ctx: DocxCtx, pPrInner = ""): string {
  // <w:bidi/> goes after pStyle / numPr (CT_PPr element order).
  const inner = pPrInner + bidiOf(runs);
  const pPr = inner ? `<w:pPr>${inner}</w:pPr>` : "";
  return `<w:p>${pPr}${runsXml(runs, ctx)}</w:p>`;
}

function headingXml(level: number, runs: Run[], ctx: DocxCtx): string {
  if (ctx.academic) {
    // The bibliography opens at its heading and runs to the next heading of the same or a higher level.
    if (ctx.inBibliography !== null && level <= ctx.inBibliography) ctx.inBibliography = null;
    if (BIBLIOGRAPHY_HEADING.test(visibleText(runs).trim())) {
      ctx.inBibliography = level;
      return paraXml(runs, ctx, `<w:pStyle w:val="Heading${level}"/><w:pageBreakBefore/>`);
    }
  }
  return paraXml(runs, ctx, `<w:pStyle w:val="Heading${level}"/>`);
}

/** A body paragraph: a bibliography entry inside the bibliography. */
function bodyParaXml(runs: Run[], ctx: DocxCtx): string {
  return paraXml(runs, ctx, ctx.inBibliography !== null ? '<w:pStyle w:val="Bibliography"/>' : "");
}

/** A list item: a paragraph bound to a numbering instance + indent level. */
function listItemXml(runs: Run[], numId: number, ilvl: number, ctx: DocxCtx): string {
  const numPr = `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;
  return paraXml(runs, ctx, `<w:pStyle w:val="ListParagraph"/>${numPr}`);
}

/** Horizontal rule → an empty paragraph carrying a bottom border. */
function hrXml(): string {
  return (
    '<w:p><w:pPr><w:pBdr>' +
    '<w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/>' +
    "</w:pBdr></w:pPr></w:p>"
  );
}

/**
 * A pipe-table column's alignment as written: `:--` and `--:` are explicit
 * (physical, the side the reader sees — the same as the preview's
 * `align` attribute), `---` is unspecified and takes the column's natural
 * side, which depends on the text direction.
 */
type Align = "none" | "left" | "center" | "right";

function parseAlign(cell: string): Align {
  const c = cell.trim();
  const left = c.startsWith(":");
  const right = c.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "none";
}

/**
 * WordprocessingML paragraph justification (plan 9.8). Word reads `w:jc`
 * relative to the paragraph's direction: in a `<w:bidi/>` paragraph
 * `start` is the RIGHT edge and `end` the LEFT one (ISO/IEC 29500-1
 * §17.18.44; the transitional `left` / `right` are the same leading /
 * trailing edges, which is why writing `right` for a Hebrew cell put it
 * on the left). So a column's physical alignment is resolved against the
 * direction of each cell's paragraph. `start` is the default and is not
 * written.
 */
type Jc = "start" | "center" | "end";

export function resolveJc(align: Align, dir: BaseDirection): Jc {
  if (align === "center") return "center";
  if (align === "none") return "start";
  const trailing = dir === "rtl" ? "left" : "right";
  return align === trailing ? "end" : "start";
}

/**
 * The direction of a table: the first strong character of its *visible*
 * text (parsed runs, like the cells — a link's hidden URL must not decide),
 * else the note's.
 */
function tableDirection(rows: string[][], ctx: DocxCtx): BaseDirection {
  const visible = rows.map((r) => r.map((c) => parseInline(c).map((run) => run.text).join("")).join(" ")).join("\n");
  return firstStrongDirection(visible) ?? ctx.baseDir;
}

function isTableSep(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
}

/** Split a table row on unescaped pipes, then unescape `\|`. */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\||\|$/g, "");
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && trimmed[i + 1] === "|") {
      buf += "|";
      i++;
    } else if (ch === "|") {
      cells.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  cells.push(buf.trim());
  return cells;
}

function tableXml(rows: string[][], aligns: Align[], ctx: DocxCtx): string {
  const cols = Math.max(...rows.map((r) => r.length), aligns.length);
  const tableDir = tableDirection(rows, ctx);
  // A right-to-left table: Word lays its columns out from the right
  // (<w:bidiVisual/>), so the first column is the rightmost, as in the
  // preview. CT_TblPr order: bidiVisual before tblW.
  const bidiVisual = tableDir === "rtl" ? "<w:bidiVisual/>" : "";
  const border =
    "<w:tblBorders>" +
    ["top", "left", "bottom", "right", "insideH", "insideV"]
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:color="999999"/>`)
      .join("") +
    "</w:tblBorders>";
  const grid =
    "<w:tblGrid>" + Array(cols).fill('<w:gridCol w:w="2500"/>').join("") + "</w:tblGrid>";

  const cell = (text: string, col: number, header: boolean) => {
    const runs = parseInline(text).map((r) =>
      header ? { ...r, bold: true } : r,
    );
    // The cell's paragraph follows its own text; a cell with no strong
    // character (a number, a date) follows the table, so a column of
    // prices in a Hebrew table aligns like its Hebrew header.
    const cellDir = firstStrongDirection(runs.map((r) => r.text).join("")) ?? tableDir;
    const bidi = cellDir === "rtl" ? "<w:bidi/>" : "";
    const resolved = resolveJc(aligns[col] ?? "none", cellDir);
    const jc = resolved === "start" ? "" : `<w:jc w:val="${resolved}"/>`;
    const shd = header ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : "";
    // CT_PPr order: bidi before jc.
    const pPr = jc || bidi ? `<w:pPr>${bidi}${jc}</w:pPr>` : "";
    return (
      `<w:tc><w:tcPr><w:tcW w:w="2500" w:type="dxa"/>${shd}</w:tcPr>` +
      `<w:p>${pPr}${runsXml(runs, ctx)}</w:p></w:tc>`
    );
  };
  const rowXml = (cells: string[], header: boolean) => {
    const padded = [...cells, ...Array(Math.max(0, cols - cells.length)).fill("")];
    const tr = header ? "<w:trPr><w:tblHeader/></w:trPr>" : "";
    return `<w:tr>${tr}${padded.map((c, col) => cell(c, col, header)).join("")}</w:tr>`;
  };

  const body = rows.map((r, i) => rowXml(r, i === 0)).join("");
  return `<w:tbl><w:tblPr>${bidiVisual}<w:tblW w:w="0" w:type="auto"/>${border}</w:tblPr>${grid}${body}</w:tbl>`;
}

const listMarker = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function indentToLevel(indent: string): number {
  // Treat a tab or two spaces as one nesting level.
  const width = indent.replace(/\t/g, "  ").length;
  return Math.min(Math.floor(width / 2), MAX_LIST_LEVEL);
}

/** Render a contiguous run of list items, restarting ordered numbering. */
function listBlockXml(items: { ordered: boolean; level: number; text: string }[], ctx: DocxCtx): string {
  // One fresh ordered <w:num> per ordered list block so numbers restart at 1.
  let orderedNumId: number | null = null;
  return items
    .map((it) => {
      let numId: number;
      if (it.ordered) {
        if (orderedNumId === null) {
          orderedNumId = ctx.nextOrderedNumId++;
          ctx.orderedNumIds.push(orderedNumId);
        }
        numId = orderedNumId;
      } else {
        numId = BULLET_NUM_ID;
      }
      // A bibliography is an alphabetical list without bullets or numbers.
      if (ctx.inBibliography !== null) return bodyParaXml(parseInline(it.text), ctx);
      return listItemXml(parseInline(it.text), numId, it.level, ctx);
    })
    .join("");
}

/**
 * Take the `[^key]: text` footnote definitions out of the lines (outside
 * fenced code), with their indented continuation lines.
 */
function extractFootnotes(lines: string[], ctx: DocxCtx): string[] {
  const kept: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) inFence = !inFence;
    const def = inFence ? null : line.match(/^\[\^([^\]\s]+)\]:\s?(.*)$/);
    if (!def) {
      kept.push(line);
      continue;
    }
    let text = def[2];
    while (i + 1 < lines.length && /^( {2,}|\t)\S/.test(lines[i + 1])) text += " " + lines[++i].trim();
    if (!ctx.footnoteDefs.has(def[1])) ctx.footnoteDefs.set(def[1], text);
  }
  return kept;
}

function markdownToBody(md: string, ctx: DocxCtx): string {
  const lines = extractFootnotes(md.replace(/\r\n/g, "\n").split("\n"), ctx);
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block → one shaded monospace paragraph, lines joined by <w:br/>.
    if (/^\s*```/.test(line)) {
      i++;
      const code: string[] = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // closing fence
      const runs = code
        .map((c) => `<w:r><w:t xml:space="preserve">${esc(c)}</w:t></w:r>`)
        .join("<w:r><w:br/></w:r>");
      out.push(`<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr>${runs}</w:p>`);
      continue;
    }

    // Pipe table.
    if (/\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(parseAlign);
      const rows: string[][] = [header];
      i += 2;
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push(tableXml(rows, aligns, ctx));
      continue;
    }

    // Display math (W5.14): `$$` on its own line, the TeX, `$$`.
    if (/^\s*\$\$\s*$/.test(line)) {
      const tex: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*\$\$\s*$/.test(lines[j])) tex.push(lines[j++]);
      if (j < lines.length) {
        out.push(`<w:p><m:oMathPara>${mathXml(tex.join(" ").trim())}</m:oMathPara></w:p>`);
        i = j + 1;
        continue;
      }
    }

    // Horizontal rule.
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push(hrXml());
      i++;
      continue;
    }

    // Heading.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      out.push(headingXml(heading[1].length, parseInline(heading[2]), ctx));
      i++;
      continue;
    }

    // List block (bullet and/or ordered, possibly nested).
    if (listMarker.test(line)) {
      const items: { ordered: boolean; level: number; text: string }[] = [];
      while (i < lines.length) {
        const lm = lines[i].match(listMarker);
        if (!lm) break;
        items.push({
          ordered: /\d/.test(lm[2]),
          level: indentToLevel(lm[1]),
          text: lm[3],
        });
        i++;
      }
      out.push(listBlockXml(items, ctx));
      continue;
    }

    // Blockquote.
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      out.push(paraXml(parseInline(quote[1]), ctx, '<w:pStyle w:val="Quote"/>'));
      i++;
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    out.push(bodyParaXml(parseInline(line), ctx));
    i++;
  }

  return out.join("");
}

function buildStyles(academic?: AcademicTemplate): string {
  const headingSizes = [32, 28, 26, 24, 23, 22]; // half-points, H1..H6
  const headings = headingSizes
    .map((base, idx) => {
      // An academic document scales the headings from its body size (12 pt → 16, 14, 13 …).
      const sz = academic ? Math.round((base * academic.sizePt) / 11) : base;
      // A chapter (H1) starts on a new page where the guideline asks (CT_PPr: keepNext, pageBreakBefore).
      const pageBreak = academic?.chapterOnNewPage && idx === 0 ? "<w:pageBreakBefore/>" : "";
      // Complex-script bold and size so a Hebrew heading is bold and sized too.
      const rPr = academic ? `<w:b/><w:bCs/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` : `<w:b/><w:sz w:val="${sz}"/>`;
      // An academic heading keeps its spacing single and does not justify.
      const spacing = academic ? `<w:spacing w:before="240" w:after="120" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/><w:jc w:val="start"/>` : `<w:spacing w:before="240" w:after="60"/>`;
      return (
        `<w:style w:type="paragraph" w:styleId="Heading${idx + 1}">` +
        `<w:name w:val="heading ${idx + 1}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
        `<w:pPr><w:keepNext/>${pageBreak}${spacing}<w:outlineLvl w:val="${idx}"/></w:pPr>` +
        `<w:rPr>${rPr}</w:rPr></w:style>`
      );
    })
    .join("");

  const sz = academic ? academic.sizePt * 2 : 22;
  const defaults = academic
    ? `<w:rFonts w:ascii="${esc(academic.latinFont)}" w:hAnsi="${esc(academic.latinFont)}" w:cs="${esc(academic.hebrewFont)}"/>` +
      `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/><w:lang w:val="en-US" w:bidi="he-IL"/>`
    : `<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/>`;
  // CT_PPr order: spacing, ind, jc.
  const normalPPr = academic
    ? `<w:spacing w:after="0" w:line="${lineTwips(academic.lineSpacing)}" w:lineRule="auto"/>` +
      (academic.firstLineIndentCm ? `<w:ind w:firstLine="${cmToTwips(academic.firstLineIndentCm)}"/>` : "") +
      (academic.justify ? `<w:jc w:val="both"/>` : "")
    : `<w:spacing w:after="120"/>`;
  const fnSz = academic ? academic.footnoteSizePt * 2 : 20;
  const academicStyles = academic
    ? `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>` +
      `<w:pPr><w:spacing w:before="2400" w:after="480" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/><w:jc w:val="center"/></w:pPr>` +
      `<w:rPr><w:b/><w:bCs/><w:sz w:val="${sz + 16}"/><w:szCs w:val="${sz + 16}"/></w:rPr></w:style>` +
      `<w:style w:type="paragraph" w:styleId="CoverLine"><w:name w:val="Cover Line"/><w:basedOn w:val="Normal"/>` +
      `<w:pPr><w:spacing w:after="120" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/><w:jc w:val="center"/></w:pPr></w:style>` +
      `<w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Heading1"/><w:next w:val="Normal"/>` +
      `<w:pPr><w:pageBreakBefore w:val="0"/><w:outlineLvl w:val="9"/></w:pPr></w:style>` +
      [1, 2, 3]
        .map(
          (l) =>
            `<w:style w:type="paragraph" w:styleId="TOC${l}"><w:name w:val="toc ${l}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
            `<w:pPr><w:spacing w:after="60" w:line="240" w:lineRule="auto"/><w:ind w:start="${(l - 1) * 360}" w:firstLine="0"/><w:jc w:val="start"/></w:pPr></w:style>`,
        )
        .join("") +
      // A bibliography entry: single spacing inside, a blank line between, a hanging indent (BIU).
      `<w:style w:type="paragraph" w:styleId="Bibliography"><w:name w:val="Bibliography"/><w:basedOn w:val="Normal"/>` +
      `<w:pPr><w:spacing w:after="240" w:line="240" w:lineRule="auto"/><w:ind w:start="720" w:hanging="720"/><w:jc w:val="start"/></w:pPr></w:style>`
    : "";

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="${W}">` +
    `<w:docDefaults><w:rPrDefault><w:rPr>` +
    defaults +
    `</w:rPr></w:rPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>` +
    `<w:pPr>${normalPPr}</w:pPr></w:style>` +
    headings +
    academicStyles +
    // Footnotes: single spacing, smaller, the mark superscript.
    `<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/>` +
    `<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:sz w:val="${fnSz}"/><w:szCs w:val="${fnSz}"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/>` +
    `<w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>` +
    `<w:basedOn w:val="Normal"/><w:pPr><w:contextualSpacing/></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>` +
    `<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="CCCCCC"/></w:pBdr>` +
    `<w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/>` +
    `<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>` +
    `<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="Code"><w:name w:val="Code Char"/>` +
    `<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:rPr></w:style>` +
    `</w:styles>`
  );
}

function buildNumbering(orderedNumIds: number[]): string {
  const bulletGlyphs = ["•", "◦", "▪"]; // • ◦ ▪
  const levels = (kind: "bullet" | "decimal") =>
    Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, l) => {
      const left = 720 * (l + 1);
      if (kind === "bullet") {
        const glyph = bulletGlyphs[l % bulletGlyphs.length];
        return (
          `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
          `<w:lvlText w:val="${esc(glyph)}"/><w:lvlJc w:val="left"/>` +
          `<w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr></w:lvl>`
        );
      }
      return (
        `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="decimal"/>` +
        `<w:lvlText w:val="%${l + 1}."/><w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr></w:lvl>`
      );
    }).join("");

  const abstracts =
    `<w:abstractNum w:abstractNumId="0">${levels("bullet")}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1">${levels("decimal")}</w:abstractNum>`;

  const nums =
    `<w:num w:numId="${BULLET_NUM_ID}"><w:abstractNumId w:val="0"/></w:num>` +
    orderedNumIds
      .map((id) => `<w:num w:numId="${id}"><w:abstractNumId w:val="1"/></w:num>`)
      .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:numbering xmlns:w="${W}">${abstracts}${nums}</w:numbering>`
  );
}

interface ExtraRel {
  id: string;
  type: string;
  target: string;
}

function buildDocumentRels(hyperlinks: { id: string; target: string }[], extra: ExtraRel[]): string {
  const links = hyperlinks
    .map(
      (h) =>
        `<Relationship Id="${h.id}" Type="${R}/hyperlink" Target="${esc(h.target)}" TargetMode="External"/>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId2" Type="${R}/numbering" Target="numbering.xml"/>` +
    extra.map((e) => `<Relationship Id="${e.id}" Type="${R}/${e.type}" Target="${e.target}"/>`).join("") +
    links +
    `</Relationships>`
  );
}

/** word/footnotes.xml: the two separators Word expects, then the notes. */
function buildFootnotes(notes: { xml: string }[]): string {
  const sep = (type: string, id: number, el: string) =>
    `<w:footnote w:type="${type}" w:id="${id}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:${el}/></w:r></w:p></w:footnote>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:footnotes xmlns:w="${W}" xmlns:r="${R}" xmlns:m="${M}">` +
    sep("separator", -1, "separator") +
    sep("continuationSeparator", 0, "continuationSeparator") +
    notes.map((n) => n.xml).join("") +
    `</w:footnotes>`
  );
}

/** word/settings.xml: update fields on open (the table of contents), the footnote separators (CT_Settings order). */
function buildSettings(updateFields: boolean, footnotes: boolean): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:settings xmlns:w="${W}">` +
    (updateFields ? `<w:updateFields w:val="true"/>` : "") +
    (footnotes ? `<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>` : "") +
    `</w:settings>`
  );
}

/** A footer with the page number, centred (each section's pgNumType sets the format). */
function buildPageFooter(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:ftr xmlns:w="${W}" xmlns:r="${R}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>` +
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>` +
    `</w:p></w:ftr>`
  );
}

const FOOTER_REL = "rId3";

/** A section's properties (CT_SectPr order: footerReference, pgSz, pgMar, pgNumType, bidi). */
function sectPrXml(t: AcademicTemplate | null, rtl: boolean, numbering: PageNumberFormat, restart: boolean): string {
  const m = t?.marginsCm;
  const mar = m
    ? `<w:pgMar w:top="${cmToTwips(m.top)}" w:right="${cmToTwips(m.right)}" w:bottom="${cmToTwips(m.bottom)}" w:left="${cmToTwips(m.left)}" w:header="708" w:footer="708" w:gutter="0"/>`
    : `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>`;
  const footer = numbering !== "none" ? `<w:footerReference w:type="default" r:id="${FOOTER_REL}"/>` : "";
  const pgNum = numbering !== "none" ? `<w:pgNumType w:fmt="${numbering}"${restart ? ' w:start="1"' : ""}/>` : "";
  return `<w:sectPr>${footer}<w:pgSz w:w="11906" w:h="16838"/>${mar}${pgNum}${rtl ? "<w:bidi/>" : ""}</w:sectPr>`;
}

/** An empty paragraph that ends a section: the section's properties ride on it. */
function sectionBreak(sectPr: string): string {
  return `<w:p><w:pPr>${sectPr}</w:pPr></w:p>`;
}

/** A centred line of the title page; an empty value is left out. */
function coverLine(text: string | undefined, style = "CoverLine", bold = false): string {
  if (!text) return "";
  const runs = parseInline(text).map((r) => (bold ? { ...r, bold: true } : r));
  const bidi = bidiOf(runs);
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${bidi}</w:pPr>${runs.map(bareRunXml).join("")}</w:p>`;
}

/** The title page (institution, title, course, lecturer, student, date), from the cover fields. */
function coverXml(a: AcademicDocxOptions, lang: "he" | "en"): string {
  const c = a.cover;
  const L = COVER_LABELS[lang];
  const course = c.course ? `${L.course}: ${c.course}${c.courseNumber ? ` (${c.courseNumber})` : ""}` : undefined;
  return (
    coverLine(a.template.institution[lang], "CoverLine", true) +
    coverLine(c.faculty) +
    coverLine(c.department) +
    coverLine(c.title, "Title") +
    coverLine(c.subtitle) +
    coverLine(course) +
    coverLine(c.lecturer ? `${L.lecturer}: ${c.lecturer}` : undefined) +
    // A gap, then the student's details at the foot of the page.
    `<w:p><w:pPr><w:pStyle w:val="CoverLine"/><w:spacing w:before="2400"/></w:pPr></w:p>` +
    coverLine(c.author ? `${L.author}: ${c.author}` : undefined) +
    coverLine(c.studentId ? `${L.studentId}: ${c.studentId}` : undefined) +
    coverLine(c.date ? `${L.date}: ${c.date}` : undefined)
  );
}

/** Headings of the body, levels 1–3, for the table of contents' first view. */
function tocEntries(body: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  let fence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fence = !fence;
    const h = fence ? null : line.match(/^(#{1,3})\s+(.*)$/);
    if (h) out.push({ level: h[1].length, text: visibleText(parseInline(h[2])) });
  }
  return out;
}

/**
 * The table of contents: Word's TOC field (headings 1–3, links), its first
 * view already filled with the headings so it reads right before the field
 * is updated; settings.xml asks Word to update it (page numbers) on open.
 */
function tocXml(body: string, lang: "he" | "en"): string {
  const L = COVER_LABELS[lang];
  const bidi = lang === "he" ? "<w:bidi/>" : "";
  const rtl = lang === "he" ? "<w:rPr><w:rtl/></w:rPr>" : "";
  const entries = tocEntries(body);
  const lines = entries.map((e, i) => {
    const first = i === 0 ? `<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>` : "";
    const last = i === entries.length - 1 ? `<w:r><w:fldChar w:fldCharType="end"/></w:r>` : "";
    const entryBidi = firstStrongDirection(e.text) === "rtl" ? "<w:bidi/>" : "";
    return `<w:p><w:pPr><w:pStyle w:val="TOC${e.level}"/>${entryBidi}</w:pPr>${first}${bareRunXml({ text: e.text })}${last}</w:p>`;
  });
  const field = lines.length
    ? lines.join("")
    : `<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
  return (
    `<w:p><w:pPr><w:pStyle w:val="TOCHeading"/>${bidi}</w:pPr><w:r>${rtl}<w:t xml:space="preserve">${esc(L.toc)}</w:t></w:r></w:p>` +
    field +
    `<w:p><w:pPr><w:pStyle w:val="FootnoteText"/>${bidi}</w:pPr><w:r>${rtl}<w:t xml:space="preserve">${esc(L.tocHint)}</w:t></w:r></w:p>`
  );
}

function buildDocxParts(content: string, opts: DocxOptions = {}): { name: string; data: string }[] {
  const academic = opts.academic;
  const md = academic ? splitCover(content).body : content;
  const baseDir = markdownBaseDirection(content);
  const ctx = newCtx(baseDir, academic);
  const body = markdownToBody(md, ctx);
  const rtl = baseDir === "rtl";
  const lang: "he" | "en" = rtl ? "he" : "en";

  let bodyXml: string;
  if (academic) {
    const front = academic.frontNumbering ?? academic.template.frontNumbering;
    const withToc = academic.toc !== false;
    bodyXml =
      coverXml(academic, lang) +
      sectionBreak(sectPrXml(academic.template, rtl, "none", false)) +
      (withToc ? tocXml(md, lang) + sectionBreak(sectPrXml(academic.template, rtl, front, true)) : "") +
      body +
      sectPrXml(academic.template, rtl, "decimal", true);
  } else {
    bodyXml = body + sectPrXml(null, false, "none", false);
  }

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:m="${M}"><w:body>` +
    bodyXml +
    `</w:body></w:document>`;

  const hasNotes = ctx.footnotes.length > 0;
  const extra: ExtraRel[] = [];
  const parts: { name: string; data: string }[] = [];
  const overrides: string[] = [];
  const WML = "application/vnd.openxmlformats-officedocument.wordprocessingml";
  if (academic) {
    extra.push({ id: FOOTER_REL, type: "footer", target: "footer1.xml" });
    parts.push({ name: "word/footer1.xml", data: buildPageFooter() });
    overrides.push(`<Override PartName="/word/footer1.xml" ContentType="${WML}.footer+xml"/>`);
  }
  if (hasNotes) {
    extra.push({ id: "rIdFootnotes", type: "footnotes", target: "footnotes.xml" });
    parts.push({ name: "word/footnotes.xml", data: buildFootnotes(ctx.footnotes) });
    overrides.push(`<Override PartName="/word/footnotes.xml" ContentType="${WML}.footnotes+xml"/>`);
  }
  if (academic || hasNotes) {
    extra.push({ id: "rIdSettings", type: "settings", target: "settings.xml" });
    parts.push({ name: "word/settings.xml", data: buildSettings(!!academic && academic.toc !== false, hasNotes) });
    overrides.push(`<Override PartName="/word/settings.xml" ContentType="${WML}.settings+xml"/>`);
  }

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="${DOCX_MIME}.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
    overrides.join("") +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;

  return [
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rels },
    { name: "word/document.xml", data: documentXml },
    { name: "word/_rels/document.xml.rels", data: buildDocumentRels(ctx.hyperlinks, extra) },
    { name: "word/styles.xml", data: buildStyles(academic?.template) },
    { name: "word/numbering.xml", data: buildNumbering(ctx.orderedNumIds) },
    ...parts,
  ];
}

/** The parts of the package as text, for golden tests. */
export function docxPartsForTest(content: string, opts: DocxOptions = {}): Record<string, string> {
  return Object.fromEntries(buildDocxParts(content, opts).map((p) => [p.name, p.data]));
}

/** Build a real .docx as raw bytes. Exported for testing. */
export async function markdownToDocxBytes(content: string, opts: DocxOptions = {}): Promise<Uint8Array> {
  return zip(buildDocxParts(content, opts));
}

/** Build a real .docx as a Blob. */
export async function markdownToDocxBlob(content: string, opts: DocxOptions = {}): Promise<Blob> {
  const bytes = await markdownToDocxBytes(content, opts);
  return new Blob([bytes as BlobPart], { type: DOCX_MIME });
}

/** Export markdown content as a downloadable .docx file. */
export async function exportToDocx(content: string, fileName: string, opts: DocxOptions = {}): Promise<void> {
  const baseName = fileName.replace(/\.[^.]+$/, "");
  // Plan W2.16: [@key] citations formatted and the reference list added, as in the preview.
  const { mayHaveCitations, expandWithLibrary } = await import("../citations/expand");
  if (mayHaveCitations(content)) content = (await expandWithLibrary(content).catch(() => ({ markdown: content }))).markdown;
  const blob = await markdownToDocxBlob(content, opts);

  if ("showSaveFilePicker" in window) {
    try {
      const handle = await window.showSaveFilePicker?.({
        suggestedName: `${baseName}.docx`,
        types: [{ description: "Word Document", accept: { [DOCX_MIME]: [".docx"] } }],
      });
      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      }
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") return;
      // Fall through to download link.
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${baseName}.docx`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try {
      if (typeof document !== "undefined" && a.parentNode === document.body) {
        document.body.removeChild(a);
      }
      URL.revokeObjectURL(url);
    } catch {
      // why: already torn down
    }
  }, 100);
}
