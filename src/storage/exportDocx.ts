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
 * Not handled: embedded images (noted, not embedded) and footnotes.
 */
import { firstStrongDirection, markdownBaseDirection, type BaseDirection } from "../lib/textDirection";
import { zip } from "./zip";
import { exportReadyText } from "./exportReady";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

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
}

function newCtx(baseDir: BaseDirection = "ltr"): DocxCtx {
  return {
    baseDir,
    hyperlinks: [],
    orderedNumIds: [],
    // rId1 = styles, rId2 = numbering (fixed below); hyperlinks start at rId3.
    nextRelId: 3,
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
  const runs: Run[] = [];
  const re =
    /\[([^\]]+)\]\(([^)]+)\)|\*\*\*([^*]+?)\*\*\*|\*\*([^*]+?)\*\*|\*([^*]+?)\*|~~([^~]+?)~~|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) runs.push({ text: m[1], href: m[2] });
    else if (m[3] !== undefined) runs.push({ text: m[3], bold: true, italic: true });
    else if (m[4] !== undefined) runs.push({ text: m[4], bold: true });
    else if (m[5] !== undefined) runs.push({ text: m[5], italic: true });
    else if (m[6] !== undefined) runs.push({ text: m[6], strike: true });
    else if (m[7] !== undefined) runs.push({ text: m[7], code: true });
    last = re.lastIndex;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length ? runs : [{ text }];
}

/** Hebrew / Arabic in the run: Word needs <w:rtl/> to order and shape it. */
const RTL_RUN = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

/** A paragraph whose first strong character is RTL gets <w:bidi/> (T44). */
function bidiOf(runs: Run[]): string {
  return firstStrongDirection(runs.map((r) => r.text).join("")) === "rtl" ? "<w:bidi/>" : "";
}

function rPrXml(r: Run, hyperlink = false): string {
  const parts: string[] = [];
  if (hyperlink) parts.push('<w:rStyle w:val="Hyperlink"/>');
  if (r.code) parts.push('<w:rStyle w:val="Code"/>');
  if (r.bold) parts.push("<w:b/>");
  if (r.italic) parts.push("<w:i/>");
  if (r.strike) parts.push("<w:strike/>");
  // CT_RPr order: <w:rtl/> after the formatting toggles.
  if (RTL_RUN.test(r.text)) parts.push("<w:rtl/>");
  return parts.length ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
}

function bareRunXml(r: Run): string {
  return `<w:r>${rPrXml(r)}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`;
}

/** A run becomes a <w:hyperlink> wrapper when it carries an href. */
function runXml(r: Run, ctx: DocxCtx): string {
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
  return paraXml(runs, ctx, `<w:pStyle w:val="Heading${level}"/>`);
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
      return listItemXml(parseInline(it.text), numId, it.level, ctx);
    })
    .join("");
}

function markdownToBody(md: string, ctx: DocxCtx): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
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

    out.push(paraXml(parseInline(line), ctx));
    i++;
  }

  return out.join("");
}

function buildStyles(): string {
  const headingSizes = [32, 28, 26, 24, 23, 22]; // half-points, H1..H6
  const headings = headingSizes
    .map(
      (sz, idx) =>
        `<w:style w:type="paragraph" w:styleId="Heading${idx + 1}">` +
        `<w:name w:val="heading ${idx + 1}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
        `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="60"/><w:outlineLvl w:val="${idx}"/></w:pPr>` +
        `<w:rPr><w:b/><w:sz w:val="${sz}"/></w:rPr></w:style>`,
    )
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="${W}">` +
    `<w:docDefaults><w:rPrDefault><w:rPr>` +
    `<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/>` +
    `</w:rPr></w:rPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>` +
    `<w:pPr><w:spacing w:after="120"/></w:pPr></w:style>` +
    headings +
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

function buildDocumentRels(hyperlinks: { id: string; target: string }[]): string {
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
    links +
    `</Relationships>`
  );
}

function buildDocxParts(content: string): { name: string; data: string }[] {
  const ctx = newCtx(markdownBaseDirection(content));
  const body = markdownToBody(content, ctx);

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>` +
    body +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>` +
    `</w:body></w:document>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="${DOCX_MIME}.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
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
    { name: "word/_rels/document.xml.rels", data: buildDocumentRels(ctx.hyperlinks) },
    { name: "word/styles.xml", data: buildStyles() },
    { name: "word/numbering.xml", data: buildNumbering(ctx.orderedNumIds) },
  ];
}

/** Build a real .docx as raw bytes. Exported for testing. */
export async function markdownToDocxBytes(content: string): Promise<Uint8Array> {
  return zip(buildDocxParts(content));
}

/** Build a real .docx as a Blob. */
export async function markdownToDocxBlob(content: string): Promise<Blob> {
  const bytes = await markdownToDocxBytes(content);
  return new Blob([bytes as BlobPart], { type: DOCX_MIME });
}

/** Export markdown content as a downloadable .docx file. */
export async function exportToDocx(content: string, fileName: string): Promise<void> {
  const baseName = fileName.replace(/\.[^.]+$/, "");
  // W5.11: marked passages and hidden comments never reach the document's XML.
  const blob = await markdownToDocxBlob(await exportReadyText(content));

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
