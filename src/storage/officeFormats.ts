/**
 * Office and ebook formats (ZIP of XML) → Markdown (split out of fileFormats.ts,
 * plan W4.11): DOCX, ODT, PPTX, XLSX, EPUB and web-archive ZIPs, unzipped by the
 * native DecompressionStream reader in ./zip. fileFormats.ts re-exports them.
 */
import { unzip, unzipText } from "./zip";
import { parseInertDocument } from "../lib/trustedTypes";
import { htmlToMarkdown, csvToMarkdown } from "./markupFormats";

/* ─── DOCX → Markdown (real: unzip word/document.xml) ─────────────── */

const els = (parent: Element | Document, tag: string) =>
  Array.from(parent.getElementsByTagName(tag));

/**
 * Real DOCX import: unzips `word/document.xml` and walks the WordprocessingML
 * tree. Handles headings (Heading1–6 / Title styles), bold/italic runs,
 * bulleted & numbered list items, and tables. Images are noted but not
 * embedded (no asset extraction yet).
 */
export async function docxToMarkdown(file: File): Promise<string> {
  let xml: string | null;
  try {
    xml = await unzipText(await file.arrayBuffer(), "word/document.xml");
  } catch (err) {
    return `> ⚠️ Could not read DOCX archive: ${(err as Error).message}`;
  }
  if (!xml) return "> ⚠️ DOCX has no word/document.xml part.";

  const doc = parseInertDocument(xml, "application/xml");
  const body = doc.getElementsByTagName("w:body")[0];
  if (!body) return "> ⚠️ DOCX document body not found.";

  const runText = (r: Element): string => {
    let t = els(r, "w:t").map((x) => x.textContent ?? "").join("");
    if (els(r, "w:tab").length) t = "\t" + t;
    if (!t) return "";
    const rPr = r.getElementsByTagName("w:rPr")[0];
    const bold = rPr && els(rPr, "w:b").length > 0;
    const italic = rPr && els(rPr, "w:i").length > 0;
    if (bold) t = `**${t}**`;
    if (italic) t = `*${t}*`;
    return t;
  };

  const paraText = (p: Element): string =>
    els(p, "w:r").map(runText).join("").trim();

  const paraToMd = (p: Element): string => {
    const text = paraText(p);
    if (!text) return "";
    const style = p
      .getElementsByTagName("w:pStyle")[0]
      ?.getAttribute("w:val")
      ?.toLowerCase();
    const headingMatch = style?.match(/heading(\d)/);
    if (headingMatch) return `${"#".repeat(Math.min(6, +headingMatch[1]))} ${text}`;
    if (style === "title") return `# ${text}`;
    if (els(p, "w:numPr").length) return `- ${text}`;
    return text;
  };

  // Walk only top-level body children so table cells aren't double-counted.
  const out: string[] = [];
  for (const node of Array.from(body.children)) {
    const tag = node.tagName;
    if (tag === "w:p") {
      const md = paraToMd(node);
      if (md) out.push(md);
    } else if (tag === "w:tbl") {
      out.push(docxTableToMd(node));
    }
  }
  const md = out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return md || "> ⚠️ DOCX contained no extractable text.";
}

function docxTableToMd(tbl: Element): string {
  const rows = els(tbl, "w:tr");
  if (!rows.length) return "";
  const cellText = (tc: Element) =>
    els(tc, "w:p")
      .map((p) => els(p, "w:t").map((t) => t.textContent ?? "").join(""))
      .join(" ")
      .trim();
  const matrix = rows.map((tr) => els(tr, "w:tc").map(cellText));
  const cols = Math.max(...matrix.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(cols - r.length).fill("")];
  const header = pad(matrix[0]);
  const sep = header.map(() => "---");
  const lines = [
    "| " + header.join(" | ") + " |",
    "| " + sep.join(" | ") + " |",
    ...matrix.slice(1).map((r) => "| " + pad(r).join(" | ") + " |"),
  ];
  return lines.join("\n");
}

/* ─── ODT → Markdown (real: unzip content.xml) ────────────────────── */

/**
 * Real ODT import: unzips `content.xml` and walks the OpenDocument text tree.
 * Handles headings (by outline level) and paragraphs, including list items.
 * Inline bold/italic in ODT lives in indirected automatic-styles, so it is
 * not resolved here — text is preserved, emphasis is not.
 */
export async function odtToMarkdown(file: File): Promise<string> {
  let xml: string | null;
  try {
    xml = await unzipText(await file.arrayBuffer(), "content.xml");
  } catch (err) {
    return `> ⚠️ Could not read ODT archive: ${(err as Error).message}`;
  }
  if (!xml) return "> ⚠️ ODT has no content.xml part.";

  const doc = parseInertDocument(xml, "application/xml");
  const out: string[] = [];
  const walk = (parent: Element, inList: boolean) => {
    for (const node of Array.from(parent.children)) {
      const tag = node.tagName;
      if (tag === "text:h") {
        const level = Math.min(6, +(node.getAttribute("text:outline-level") || "1"));
        const text = (node.textContent ?? "").trim();
        if (text) out.push(`${"#".repeat(level)} ${text}`);
      } else if (tag === "text:p") {
        const text = (node.textContent ?? "").trim();
        if (text) out.push(inList ? `- ${text}` : text);
      } else if (tag === "text:list") {
        walk(node, true);
      } else {
        walk(node, inList);
      }
    }
  };
  const bodyText = doc.getElementsByTagName("office:text")[0];
  if (bodyText) walk(bodyText, false);
  const md = out.join("\n\n").trim();
  return md || "> ⚠️ ODT contained no extractable text.";
}

/* ─── PPTX → Markdown (real: unzip ppt/slides/*.xml) ──────────────── */

const slideNum = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);

/**
 * Real PPTX import: unzips the deck and converts each slide (in slide-number
 * order) into a `## ` heading (first text line) plus bullets for the rest.
 * Speaker notes and images are not extracted.
 */
export async function pptxToMarkdown(file: File): Promise<string> {
  let files: Map<string, Uint8Array>;
  try {
    files = await unzip(await file.arrayBuffer());
  } catch (err) {
    return `> ⚠️ Could not read PPTX archive: ${(err as Error).message}`;
  }
  const dec = new TextDecoder();
  const slides = [...files.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNum(a) - slideNum(b));
  if (!slides.length) return "> ⚠️ PPTX: no slides found.";

  const out: string[] = [];
  slides.forEach((name, i) => {
    const doc = parseInertDocument(dec.decode(files.get(name)!), "application/xml");
    const paras = els(doc, "a:p")
      .map((p) => els(p, "a:t").map((t) => t.textContent ?? "").join("").trim())
      .filter(Boolean);
    out.push(`## ${paras[0] ?? `Slide ${i + 1}`}`);
    for (const line of paras.slice(1)) out.push(`- ${line}`);
  });
  return out.join("\n\n");
}

/* ─── XLSX → Markdown tables (real: unzip xl/worksheets/*.xml) ─────── */

/** Convert a cell reference like "B7" to a 0-based column index. */
function colToIndex(ref: string): number {
  const letters = ref.replace(/[0-9]/g, "").toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}

/**
 * Real XLSX import: unzips the workbook, resolves shared strings, and renders
 * each worksheet as a Markdown table under a `## SheetName` heading. Formulas
 * render as their cached value; styles/merged cells are not preserved.
 */
export async function xlsxToMarkdown(file: File): Promise<string> {
  let files: Map<string, Uint8Array>;
  try {
    files = await unzip(await file.arrayBuffer());
  } catch (err) {
    return `> ⚠️ Could not read XLSX archive: ${(err as Error).message}`;
  }
  const dec = new TextDecoder();
  const parse = (name: string) =>
    files.has(name)
      ? parseInertDocument(dec.decode(files.get(name)!), "application/xml")
      : null;

  const shared: string[] = [];
  const ss = parse("xl/sharedStrings.xml");
  if (ss) for (const si of els(ss, "si")) shared.push(els(si, "t").map((t) => t.textContent ?? "").join(""));

  const names: string[] = [];
  const wb = parse("xl/workbook.xml");
  if (wb) for (const s of els(wb, "sheet")) names.push(s.getAttribute("name") ?? "");

  const sheets = [...files.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => slideNum(a) - slideNum(b));
  if (!sheets.length) return "> ⚠️ XLSX: no worksheets found.";

  const out: string[] = [];
  sheets.forEach((name, si) => {
    const doc = parse(name)!;
    const matrix: string[][] = [];
    for (const row of els(doc, "row")) {
      const arr: string[] = [];
      for (const c of els(row, "c")) {
        const idx = colToIndex(c.getAttribute("r") ?? "A");
        const type = c.getAttribute("t");
        const raw = els(c, "v")[0]?.textContent ?? "";
        arr[idx] =
          type === "s"
            ? shared[Number(raw)] ?? ""
            : type === "inlineStr"
              ? els(c, "t").map((t) => t.textContent ?? "").join("")
              : raw;
      }
      for (let i = 0; i < arr.length; i++) if (arr[i] === undefined) arr[i] = "";
      matrix.push(arr);
    }
    if (!matrix.length) return;
    const cols = Math.max(...matrix.map((r) => r.length));
    const pad = (r: string[]) => {
      const c = [...r];
      while (c.length < cols) c.push("");
      return c;
    };
    const header = pad(matrix[0]);
    out.push(
      [
        `## ${names[si] || `Sheet ${si + 1}`}`,
        "",
        "| " + header.join(" | ") + " |",
        "| " + header.map(() => "---").join(" | ") + " |",
        ...matrix.slice(1).map((r) => "| " + pad(r).join(" | ") + " |"),
      ].join("\n"),
    );
  });
  return out.join("\n\n") || "> ⚠️ XLSX contained no data.";
}

/* ─── Notion / Obsidian archive → merged Markdown ─────────────────── */

/** Strip Notion's 32-hex-char id suffix and folder path from an entry name. */
function cleanArchiveTitle(name: string): string {
  return (
    name
      .replace(/\.md$/i, "")
      .split("/")
      .pop() ?? name
  )
    .replace(/\s+[0-9a-f]{32}$/i, "")
    .trim();
}

/**
 * Import a Notion export or Obsidian vault (both shipped as a .zip of Markdown
 * files, possibly with CSV databases). Each .md file becomes a section (a
 * leading H1 is added from the cleaned filename if the file lacks one); CSV
 * files render as tables. Obsidian `[[wikilinks]]` pass through unchanged —
 * Lumen renders them natively. Notion's "Title <hash>" names are cleaned up.
 */
export async function archiveToMarkdown(file: File): Promise<string> {
  let files: Map<string, Uint8Array>;
  try {
    files = await unzip(await file.arrayBuffer());
  } catch (err) {
    return `> ⚠️ Could not read archive: ${(err as Error).message}`;
  }
  const dec = new TextDecoder();
  const mdFiles = [...files.keys()].filter((n) => /\.md$/i.test(n) && !n.startsWith("__MACOSX")).sort();
  const csvFiles = [...files.keys()].filter((n) => /\.csv$/i.test(n) && !n.startsWith("__MACOSX")).sort();
  if (!mdFiles.length && !csvFiles.length) {
    return "> ⚠️ Archive contains no Markdown or CSV files.";
  }

  const parts: string[] = [];
  for (const name of mdFiles) {
    const body = dec.decode(files.get(name)!).trim();
    const hasLeadingH1 = /^#\s+/.test(body);
    parts.push(hasLeadingH1 ? body : `# ${cleanArchiveTitle(name)}\n\n${body}`);
  }
  for (const name of csvFiles) {
    parts.push(`## ${cleanArchiveTitle(name)}\n\n${csvToMarkdown(dec.decode(files.get(name)!))}`);
  }
  return parts.join("\n\n---\n\n");
}

/* ─── EPUB → Markdown (zero-dep regex over packaged XHTML) ────────── */

/**
 * Real EPUB import: unzips the archive, reads META-INF/container.xml to find
 * the OPF package, then converts each spine document (in reading order) from
 * XHTML to Markdown. Falls back to converting every (x)html entry if the OPF
 * structure can't be read.
 */
export async function epubToMarkdown(file: File): Promise<string> {
  let files: Map<string, Uint8Array>;
  try {
    files = await unzip(await file.arrayBuffer());
  } catch (err) {
    return `> ⚠️ Could not read EPUB archive: ${(err as Error).message}`;
  }
  const dec = new TextDecoder();
  const textOf = (name: string) => {
    const b = files.get(name);
    return b ? dec.decode(b) : null;
  };
  const htmlToChapter = (html: string) => {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    return htmlToMarkdown(`<div>${bodyMatch ? bodyMatch[1] : html}</div>`).trim();
  };

  // Resolve the spine order via container.xml → OPF.
  const container = textOf("META-INF/container.xml");
  const opfPath = container?.match(/full-path="([^"]+)"/i)?.[1];
  const opf = opfPath ? textOf(opfPath) : null;

  const chapters: string[] = [];
  if (opf && opfPath) {
    const opfDir = opfPath.includes("/") ? opfPath.replace(/\/[^/]+$/, "/") : "";
    const doc = parseInertDocument(opf, "application/xml");
    const manifest = new Map<string, string>();
    for (const item of els(doc, "item")) {
      const id = item.getAttribute("id");
      const href = item.getAttribute("href");
      if (id && href) manifest.set(id, href);
    }
    for (const ref of els(doc, "itemref")) {
      const href = manifest.get(ref.getAttribute("idref") ?? "");
      if (!href) continue;
      const html = textOf(decodeURIComponent(opfDir + href));
      if (html) {
        const md = htmlToChapter(html);
        if (md) chapters.push(md);
      }
    }
  }

  // Fallback: every (x)html entry, in archive order.
  if (chapters.length === 0) {
    for (const [name, bytes] of files) {
      if (/\.x?html?$/i.test(name)) {
        const md = htmlToChapter(dec.decode(bytes));
        if (md.length > 30) chapters.push(md);
      }
    }
  }

  return chapters.length
    ? chapters.join("\n\n---\n\n")
    : "> ⚠️ EPUB: no readable chapters found.";
}
