/**
 * File format converters — zero external dependencies.
 *
 * Text/markup: Markdown, HTML, RTF, XML, CSV/TSV/JSON, LaTeX, RST, AsciiDoc,
 * Org, OPML, MHTML/EML. Office/ebook (ZIP-of-XML): DOCX, ODT, EPUB — unzipped
 * via the native DecompressionStream-based reader in ./zip (no JSZip/mammoth).
 * Apple iWork (.pages/.numbers/.key) via ./iwork. Legacy .doc and image-only
 * PDF remain best-effort. All convert to Markdown.
 *
 * Uses browser-native DOMParser for XML/HTML parsing.
 */
import { unzip, unzipText } from "./zip";
import { iworkToMarkdown } from "./iwork";
import { parseInertDocument } from "../lib/trustedTypes";
import { readText } from "./textCodec";

/* ─── HTML → Markdown (zero-dep, uses DOMParser) ─── */

function htmlNodeToMd(node: Node, depth = 0): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent?.replace(/\s+/g, " ") ?? "";
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const children = () =>
    Array.from(el.childNodes)
      .map((c) => htmlNodeToMd(c, depth))
      .join("");

  switch (tag) {
    case "h1": return `\n# ${children().trim()}\n`;
    case "h2": return `\n## ${children().trim()}\n`;
    case "h3": return `\n### ${children().trim()}\n`;
    case "h4": return `\n#### ${children().trim()}\n`;
    case "h5": return `\n##### ${children().trim()}\n`;
    case "h6": return `\n###### ${children().trim()}\n`;
    case "p": return `\n${children().trim()}\n`;
    case "br": return "\n";
    case "hr": return "\n---\n";
    case "strong":
    case "b": return emphasis("**", children());
    case "em":
    case "i": return emphasis("*", children());
    case "s":
    case "del":
    case "strike": return emphasis("~~", children());
    case "code": return `\`${children().trim()}\``;
    case "pre": {
      const code = el.querySelector("code");
      const lang = code?.className.match(/language-(\w+)/)?.[1] ?? "";
      const text = (code ?? el).textContent ?? "";
      return `\n\`\`\`${lang}\n${text.trim()}\n\`\`\`\n`;
    }
    case "a": {
      const href = el.getAttribute("href") ?? "";
      return `[${children().trim()}](${href})`;
    }
    case "img": {
      const src = el.getAttribute("src") ?? "";
      const alt = el.getAttribute("alt") ?? "";
      return `![${alt}](${src})`;
    }
    case "ul": {
      return "\n" + Array.from(el.children)
        .map((li) => `${"  ".repeat(depth)}- ${htmlNodeToMd(li, depth + 1).trim()}`)
        .join("\n") + "\n";
    }
    case "ol": {
      return "\n" + Array.from(el.children)
        .map((li, i) => `${"  ".repeat(depth)}${i + 1}. ${htmlNodeToMd(li, depth + 1).trim()}`)
        .join("\n") + "\n";
    }
    case "li": return children();
    case "blockquote": {
      const inner = children().trim().split("\n").map((l) => `> ${l}`).join("\n");
      return `\n${inner}\n`;
    }
    case "table": return "\n" + tableToMd(el as HTMLTableElement) + "\n";
    case "div":
    case "section":
    case "article":
    case "main":
    case "body":
    case "span":
    case "html":
      return children();
    case "script":
    case "style":
    case "head":
    case "meta":
    case "link":
      return "";
    default:
      return children();
  }
}

function tableToMd(table: HTMLTableElement): string {
  const rows = Array.from(table.rows);
  if (rows.length === 0) return "";

  const getRowCells = (row: HTMLTableRowElement) =>
    Array.from(row.cells).map((c) => c.textContent?.trim() ?? "");

  const headers = getRowCells(rows[0]);
  const sep = headers.map(() => "---");
  const body = rows.slice(1).map(getRowCells);

  return (
    "| " + headers.join(" | ") + " |\n" +
    "| " + sep.join(" | ") + " |\n" +
    body.map((r) => "| " + r.join(" | ") + " |").join("\n")
  );
}

/**
 * Emphasis around the text, the spaces at its edges left outside: `<b>bold </b>and`
 * is `**bold** and`, never `**bold**and` (W6.38, Evernote notes).
 */
function emphasis(mark: string, inner: string): string {
  const core = inner.trim();
  if (!core) return inner;
  return `${/^\s*/.exec(inner)![0]}${mark}${core}${mark}${/\s*$/.exec(inner)![0]}`;
}

export function htmlToMarkdown(html: string): string {
  const doc = parseInertDocument(html, "text/html");
  const md = htmlNodeToMd(doc.body);
  return md.replace(/\n{3,}/g, "\n\n").trim();
}

/* ─── RTF → Markdown ─── */

export function rtfToMarkdown(rtfText: string): string {
  let text = rtfText;
  // Strip the RTF header group: {\rtf1\ansi ... up to the first space before content
  text = text.replace(/^\{\\rtf\d[^}]*?\s/, "");
  // Remove nested groups like {\fonttbl...} {\colortbl...} etc
  // Repeatedly remove innermost groups until none left
  let prev = "";
  while (prev !== text) {
    prev = text;
    text = text.replace(/\{[^{}]*\}/g, "");
  }
  // Convert paragraph/line breaks before stripping control words
  text = text.replace(/\\par\b/g, "\n");
  text = text.replace(/\\line\b/g, "\n");
  text = text.replace(/\\tab\b/g, "\t");
  // Bold/italic markers
  text = text.replace(/\\b\b/g, "**");
  text = text.replace(/\\b0\b/g, "**");
  text = text.replace(/\\i\b/g, "*");
  text = text.replace(/\\i0\b/g, "*");
  // Strip remaining control words
  text = text.replace(/\\[a-z]+[\d-]*/g, "");
  // Remove leftover braces
  text = text.replace(/[{}]/g, "");
  // Collapse excessive newlines
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/* ─── CSV / TSV → Markdown table ─── */

export function csvToMarkdown(csvText: string, delimiter = ","): string {
  const trimmed = csvText.trim();
  if (!trimmed) return "";
  const lines = trimmed.split("\n");
  const parse = (line: string) => {
    const cells: string[] = [];
    let current = "";
    let inQuote = false;
    for (const ch of line) {
      if (ch === '"') {
        inQuote = !inQuote;
      } else if (ch === delimiter && !inQuote) {
        cells.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    return cells;
  };

  const headers = parse(lines[0]);
  const sep = headers.map(() => "---");
  const rows = lines.slice(1).map(parse);

  return (
    "| " + headers.join(" | ") + " |\n" +
    "| " + sep.join(" | ") + " |\n" +
    rows.map((r) => "| " + r.join(" | ") + " |").join("\n")
  );
}

export function tsvToMarkdown(tsvText: string): string {
  return csvToMarkdown(tsvText, "\t");
}

/* ─── JSON → Markdown table ─── */

export function jsonToMarkdown(jsonText: string): string {
  try {
    const data = JSON.parse(jsonText);
    // Array of objects → table
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
      const headers = Object.keys(data[0]);
      const sep = headers.map(() => "---");
      const rows = data.map((row: Record<string, unknown>) =>
        headers.map((h) => String(row[h] ?? "")),
      );
      return (
        "| " + headers.join(" | ") + " |\n" +
        "| " + sep.join(" | ") + " |\n" +
        rows.map((r: string[]) => "| " + r.join(" | ") + " |").join("\n")
      );
    }
    // Otherwise: pretty-print as code block
    return "```json\n" + JSON.stringify(data, null, 2) + "\n```";
  } catch {
    return "```\n" + jsonText + "\n```";
  }
}

/* ─── XML → Markdown table ─── */

export function xmlToMarkdown(xmlText: string): string {
  try {
    const doc = parseInertDocument(xmlText, "text/xml");
    const error = doc.querySelector("parsererror");
    if (error) return "```xml\n" + xmlText + "\n```";

    // Try to find repeating child elements (like rows)
    const root = doc.documentElement;
    const children = Array.from(root.children);
    if (children.length === 0) return "```xml\n" + xmlText + "\n```";

    // Check if all children have the same tag name (table-like)
    const tagName = children[0].tagName;
    const isTable = children.every((c) => c.tagName === tagName);

    if (isTable && children.length > 0) {
      const headers = Array.from(children[0].children).map((c) => c.tagName);
      if (headers.length > 0) {
        const sep = headers.map(() => "---");
        const rows = children.map((row) =>
          headers.map((h) => row.querySelector(h)?.textContent?.trim() ?? ""),
        );
        return (
          "| " + headers.join(" | ") + " |\n" +
          "| " + sep.join(" | ") + " |\n" +
          rows.map((r) => "| " + r.join(" | ") + " |").join("\n")
        );
      }
    }

    // Fallback: pretty XML code block
    return "```xml\n" + xmlText + "\n```";
  } catch {
    return "```xml\n" + xmlText + "\n```";
  }
}

/* ─── Unified file importer ─── */

export async function fileToMarkdown(file: File): Promise<{ name: string; content: string }> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const baseName = file.name.replace(/\.[^.]+$/, "");

  switch (ext) {
    case "rtf": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: rtfToMarkdown(text) };
    }
    case "html":
    case "htm": {
      const text = await file.text();
      // Confluence exports are XHTML wrapped in ac:/ri: macros — detect + route.
      const isConfluence = /xmlns:ac=|<ac:structured-macro|<ac:rich-text-body/i.test(text);
      return {
        name: `${baseName}.md`,
        content: isConfluence ? confluenceToMarkdown(text) : htmlToMarkdown(text),
      };
    }
    case "csv": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: csvToMarkdown(text) };
    }
    case "tsv": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: tsvToMarkdown(text) };
    }
    case "json": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: jsonToMarkdown(text) };
    }
    case "xml": {
      const text = await file.text();
      // WordPress eXtended RSS exports are .xml; route them to the WXR reader.
      const isWxr = /<wp:|xmlns:wp=/i.test(text);
      return {
        name: `${baseName}.md`,
        content: isWxr ? wxrToMarkdown(text) : xmlToMarkdown(text),
      };
    }
    case "doc": {
      return { name: `${baseName}.md`, content: await legacyDocToMarkdown(file) };
    }
    case "docx": {
      return { name: `${baseName}.md`, content: await docxToMarkdown(file) };
    }
    case "odt": {
      return { name: `${baseName}.md`, content: await odtToMarkdown(file) };
    }
    case "pptx": {
      return { name: `${baseName}.md`, content: await pptxToMarkdown(file) };
    }
    case "xlsx": {
      return { name: `${baseName}.md`, content: await xlsxToMarkdown(file) };
    }
    case "zip": {
      // Notion export / Obsidian vault — a zip of Markdown (+ CSV).
      return { name: `${baseName}.md`, content: await archiveToMarkdown(file) };
    }
    case "mhtml":
    case "mht":
    case "eml": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: mhtmlToMarkdown(text) };
    }
    case "pdf": {
      const content = await pdfToMarkdown(file);
      return { name: `${baseName}.md`, content };
    }
    case "epub": {
      const content = await epubToMarkdown(file);
      return { name: `${baseName}.md`, content };
    }
    case "opml": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: opmlToMarkdown(text) };
    }
    case "tex":
    case "ltx": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: latexToMarkdown(text) };
    }
    case "rst": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: rstToMarkdown(text) };
    }
    case "adoc":
    case "asciidoc": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: adocToMarkdown(text) };
    }
    case "org": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: orgToMarkdown(text) };
    }
    case "ipynb": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: ipynbToMarkdown(text) };
    }
    case "pages":
    case "numbers":
    case "key": {
      // Apple iWork — ZIP of XML ('09) or snappy-framed protobuf (IWA, '13+).
      const content = await iworkToMarkdown(await file.arrayBuffer(), ext, {
        pdfFallback: (pdf) =>
          pdfToMarkdown({
            name: "Preview.pdf",
            arrayBuffer: async () => pdf.slice().buffer,
          } as unknown as File),
      });
      return { name: `${baseName}.md`, content };
    }
    case "fountain":
    case "spmd": {
      const text = await file.text();
      return { name: `${baseName}.md`, content: fountainToMarkdown(text) };
    }
    case "yaml":
    case "yml":
    case "toml":
    case "text":
    case "markdown":
    case "mdown":
    case "mkd":
    case "md":
    case "txt":
      return { name: file.name, content: await readText(file) };
    default:
      return { name: file.name, content: await file.text() };
  }
}

/* ─── DOCX → Markdown (real: unzip word/document.xml) ─────────────── */

const els = (parent: Element | Document, tag: string) =>
  Array.from(parent.getElementsByTagName(tag));

/**
 * Real DOCX import: unzips the package and walks `word/document.xml`.
 * Headings (Heading1–6 / Title styles), bold / italic runs (the complex-
 * script `w:bCs` / `w:iCs` too: Word and LibreOffice mark Hebrew bold that
 * way), lists from `word/numbering.xml` (bullet or numbered, nested by
 * `w:ilvl`), hyperlinks from the relationships, tables, and images, which
 * come along inline as `data:` URIs (up to 512 KB each; a larger one keeps
 * its alt text and file name). Plan W6.38 measured this on a real corpus.
 */
export async function docxToMarkdown(file: File): Promise<string> {
  let parts: Map<string, Uint8Array>;
  try {
    parts = await unzip(await file.arrayBuffer());
  } catch (err) {
    return `> ⚠️ Could not read DOCX archive: ${(err as Error).message}`;
  }
  const dec = new TextDecoder();
  const part = (name: string) => {
    const b = parts.get(name);
    return b ? dec.decode(b) : null;
  };
  const xml = part("word/document.xml");
  if (!xml) return "> ⚠️ DOCX has no word/document.xml part.";

  const doc = parseInertDocument(xml, "application/xml");
  const body = doc.getElementsByTagName("w:body")[0];
  if (!body) return "> ⚠️ DOCX document body not found.";

  // Relationships: hyperlink targets and image parts.
  const rels = new Map<string, string>();
  const relsXml = part("word/_rels/document.xml.rels");
  if (relsXml) for (const r of els(parseInertDocument(relsXml, "application/xml"), "Relationship")) rels.set(r.getAttribute("Id") ?? "", r.getAttribute("Target") ?? "");

  // Numbering: numId → abstractNumId → per level, bullet or not.
  const bulletOf = new Map<string, boolean[]>();
  const numXml = part("word/numbering.xml");
  if (numXml) {
    const nd = parseInertDocument(numXml, "application/xml");
    const abstract = new Map<string, boolean[]>();
    for (const an of els(nd, "w:abstractNum")) {
      const levels: boolean[] = [];
      for (const lvl of els(an, "w:lvl")) levels[+(lvl.getAttribute("w:ilvl") ?? "0")] = lvl.getElementsByTagName("w:numFmt")[0]?.getAttribute("w:val") === "bullet";
      abstract.set(an.getAttribute("w:abstractNumId") ?? "", levels);
    }
    for (const n of els(nd, "w:num")) bulletOf.set(n.getAttribute("w:numId") ?? "", abstract.get(n.getElementsByTagName("w:abstractNumId")[0]?.getAttribute("w:val") ?? "") ?? []);
  }

  const on = (rPr: Element | undefined, ...tags: string[]) =>
    !!rPr && tags.some((t) => {
      const el = rPr.getElementsByTagName(t)[0];
      const v = el?.getAttribute("w:val");
      return !!el && v !== "0" && v !== "false";
    });

  const imageMd = (drawing: Element): string => {
    const props = drawing.getElementsByTagName("wp:docPr")[0];
    const alt = (props?.getAttribute("descr") || props?.getAttribute("title") || "").replace(/[[\]]/g, "");
    const id = drawing.getElementsByTagName("a:blip")[0]?.getAttribute("r:embed") ?? "";
    const target = rels.get(id) ?? "";
    const path = target.startsWith("/") ? target.slice(1) : `word/${target}`;
    const data = parts.get(path);
    const ext = (/\.(\w+)$/.exec(target)?.[1] ?? "png").toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "svg" ? "image/svg+xml" : `image/${ext}`;
    if (!data || data.length > 512 * 1024) return `![${alt || target.split("/").pop()}](${target.split("/").pop() ?? ""})`;
    let bin = "";
    for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return `![${alt}](data:${mime};base64,${btoa(bin)})`;
  };

  // Runs of a paragraph (hyperlinks included), with neighbouring runs of the same emphasis joined.
  const paraText = (p: Element): string => {
    const pieces: { text: string; b: boolean; i: boolean; href?: string; raw?: boolean }[] = [];
    const runOf = (r: Element, href?: string) => {
      for (const d of els(r, "w:drawing")) pieces.push({ text: imageMd(d), b: false, i: false, raw: true });
      let t = "";
      for (const c of Array.from(r.children)) {
        if (c.tagName === "w:t") t += c.textContent ?? "";
        else if (c.tagName === "w:tab") t += "\t";
        else if (c.tagName === "w:br") t += " ";
      }
      if (!t) return;
      const rPr = r.getElementsByTagName("w:rPr")[0];
      pieces.push({ text: t, b: on(rPr, "w:b", "w:bCs"), i: on(rPr, "w:i", "w:iCs"), href });
    };
    for (const c of Array.from(p.children)) {
      if (c.tagName === "w:r") runOf(c);
      else if (c.tagName === "w:hyperlink") {
        const href = rels.get(c.getAttribute("r:id") ?? ""); // an internal w:anchor link keeps its text only
        for (const r of els(c, "w:r")) runOf(r, href);
      } else if (c.tagName === "w:ins" || c.tagName === "w:smartTag" || c.tagName === "w:sdt") for (const r of els(c, "w:r")) runOf(r);
    }
    // Whitespace takes the emphasis of the text before it, so "**a** **b**" joins into one span.
    for (let k = 1; k < pieces.length; k++) if (!pieces[k].raw && !pieces[k].text.trim()) Object.assign(pieces[k], { b: pieces[k - 1].b, i: pieces[k - 1].i });
    const groups: typeof pieces = [];
    for (const x of pieces) {
      const last = groups[groups.length - 1];
      if (last && !last.raw && !x.raw && last.b === x.b && last.i === x.i && last.href === x.href) last.text += x.text;
      else groups.push({ ...x });
    }
    return groups
      .map((g) => {
        if (g.raw) return g.text;
        const lead = /^\s*/.exec(g.text)![0];
        const trail = /\s*$/.exec(g.text)![0];
        let core = g.text.trim();
        if (!core) return g.text;
        if (g.b) core = `**${core}**`;
        if (g.i) core = `*${core}*`;
        if (g.href) core = `[${core}](${g.href})`;
        return lead + core + trail;
      })
      .join("")
      .trim();
  };

  const listOf = (p: Element): { depth: number; bullet: boolean } | null => {
    const numPr = p.getElementsByTagName("w:numPr")[0];
    if (!numPr) return null;
    const numId = numPr.getElementsByTagName("w:numId")[0]?.getAttribute("w:val") ?? "";
    if (numId === "0") return null;
    const depth = +(numPr.getElementsByTagName("w:ilvl")[0]?.getAttribute("w:val") ?? "0");
    return { depth, bullet: bulletOf.get(numId)?.[depth] ?? true };
  };

  const out: string[] = [];
  let inList = false;
  for (const node of Array.from(body.children)) {
    if (node.tagName === "w:p") {
      const text = paraText(node);
      if (!text) continue;
      const style = node.getElementsByTagName("w:pStyle")[0]?.getAttribute("w:val")?.toLowerCase();
      const heading = style?.match(/heading(\d)/);
      const list = heading ? null : listOf(node);
      let md: string;
      if (heading) md = `${"#".repeat(Math.min(6, +heading[1]))} ${text}`;
      else if (style === "title") md = `# ${text}`;
      else if (list) md = `${"   ".repeat(list.depth)}${list.bullet ? "-" : "1."} ${text}`;
      else md = text;
      // A list's items stay together; anything else is its own block.
      if (list && inList) out[out.length - 1] += `\n${md}`;
      else out.push(md);
      inList = !!list;
    } else if (node.tagName === "w:tbl") {
      out.push(docxTableToMd(node));
      inList = false;
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

/** Most scanned pages one PDF import reads with OCR. */
const PDF_OCR_MAX_PAGES = 30;

/**
 * Join a PDF's per-page text (one entry per page, "" for a page without a
 * text layer). Blank pages are read with `ocrPage` (1-based page number)
 * when given — each blank page, not only when the whole PDF is blank.
 * @internal exported for tests.
 */
export async function mergePdfPageTexts(texts: string[], ocrPage: ((n: number) => Promise<string>) | null): Promise<string> {
  const pages = [...texts];
  let ocred = 0;
  let tried = 0;
  let skipped = 0;
  if (ocrPage) {
    for (let i = 0; i < pages.length; i++) {
      if (pages[i]) continue;
      if (tried >= PDF_OCR_MAX_PAGES) {
        skipped++;
        continue;
      }
      tried++;
      const text = (await ocrPage(i + 1).catch(() => "")).trim();
      if (text) {
        pages[i] = text;
        ocred++;
      }
    }
  }
  const found = pages.filter(Boolean);
  if (!found.length) return "> ⚠️ This PDF has no extractable text (likely a scanned image), and on-device OCR found none either.";
  if (!ocred) return found.join("\n\n---\n\n");
  const head = texts.some(Boolean)
    ? "> ℹ️ Some pages are scanned — their text was recognised on this device (OCR); check it against the original."
    : "> ℹ️ Scanned PDF — text recognised on this device (OCR); check it against the original.";
  const note = skipped ? `\n\n> ℹ️ OCR read the first ${PDF_OCR_MAX_PAGES} of ${tried + skipped} scanned pages.` : "";
  return `${head}\n\n${found.join("\n\n---\n\n")}${note}`;
}

/* ─── PDF → Markdown (lazy-loads pdfjs-dist) ──────────────────────── */

/**
 * Extract a PDF's text into Markdown. Dynamic-imports `pdfjs-dist` (heavy) so
 * the cost is paid only when the user drops a PDF. Uses the locally bundled
 * worker — no CDN — and degrades honestly: scanned/image-only PDFs return a
 * clear "no extractable text" notice instead of silent garbage.
 */
export async function pdfToMarkdown(file: File): Promise<string> {
  type PdfjsModule = {
    GlobalWorkerOptions: { workerSrc: string };
    getDocument: (src: { data: Uint8Array; isEvalSupported?: boolean }) => {
      promise: Promise<{
        numPages: number;
        getPage: (n: number) => Promise<{
          getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
          getViewport: (o: { scale: number }) => { width: number; height: number };
          render: (o: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void> };
        }>;
      }>;
    };
  };
  try {
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule;
    // Bundle the worker locally (no CDN). In the browser Vite emits the asset;
    // under node/vitest there is no Web Worker, so pdf.js falls back to a
    // main-thread "fake worker" and text extraction still works.
    // Worker source — no CDN. In the browser, Vite's `?url` emits the local
    // worker asset. Under node/vitest we hand pdf.js the bare module specifier
    // so it imports the worker via node_modules on the main thread (the `?url`
    // value there is a web path pdf.js can't import).
    const isNode =
      typeof process !== "undefined" && !!(process as { versions?: { node?: string } })?.versions?.node;
    let workerSrc = "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
    if (!isNode) {
      try {
        const url = (await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")).default;
        if (typeof url === "string" && url) workerSrc = url;
      } catch {
        /* why: keep the bare specifier, which Node and the tests resolve */
      }
    }
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
    const texts: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      texts.push(
        content.items
          .map((it) => it.str ?? "")
          .join(" ")
          .replace(/[ \t]{2,}/g, " ")
          .trim(),
      );
    }
    // Scanned pages (no text layer): render each and read it with on-device
    // OCR (Hebrew + English, T31) — also in a mixed PDF whose cover or page
    // numbers do have text. Browser only — tests have no canvas.
    let ocrPage: ((n: number) => Promise<string>) | null = null;
    if (!isNode && typeof document !== "undefined" && texts.some((t) => !t)) {
      const { ocrImage } = await import("../ai/ocr");
      ocrPage = async (n) => {
        const page = await pdf.getPage(n);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return "";
        await page.render({ canvasContext: ctx, viewport }).promise;
        return (await ocrImage(canvas).catch(() => ({ text: "" }))).text;
      };
    }
    return await mergePdfPageTexts(texts, ocrPage);
  } catch (err) {
    return "> ⚠️ Couldn't read this PDF: " + (err as Error).message;
  }
}

/* ─── MHTML / .mht / .eml → Markdown ──────────────────────────────── */

/**
 * Pull the `text/html` part out of a MIME multipart envelope (saved
 * web pages, .eml mail), decode quoted-printable, run through HTML →
 * Markdown. Falls through to plain HTML when no boundary header found.
 */
export function mhtmlToMarkdown(text: string): string {
  const boundaryMatch =
    text.match(/Content-Type:[^\n]*boundary="?([^";\s]+)"?/i) ??
    text.match(/boundary=([^\s;]+)/i);
  if (!boundaryMatch) return htmlToMarkdown(text);
  const parts = text.split(`--${boundaryMatch[1]}`);
  const html = parts.find((p) => /Content-Type:\s*text\/html/i.test(p));
  if (html) {
    const body = html.split(/\r?\n\r?\n/).slice(1).join("\n\n").trim();
    const decoded = body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return htmlToMarkdown(decoded);
  }
  const plain = parts.find((p) => /Content-Type:\s*text\/plain/i.test(p));
  if (plain) return plain.split(/\r?\n\r?\n/).slice(1).join("\n\n").trim();
  return "> ⚠️ MHTML envelope had no recognisable text part.";
}

/* ─── OPML → Markdown (outlines, RSS reader feeds, mind maps) ──── */

export function opmlToMarkdown(text: string): string {
  try {
    const doc = parseInertDocument(text, "application/xml");
    const title = doc.querySelector("head > title")?.textContent?.trim() ?? "Outline";
    const lines: string[] = [`# ${title}`, ""];
    function walk(el: Element, depth: number): void {
      for (const child of Array.from(el.children).filter((c) => c.tagName.toLowerCase() === "outline")) {
        const text = child.getAttribute("text") ?? child.getAttribute("title") ?? "";
        const url = child.getAttribute("xmlUrl") ?? child.getAttribute("url");
        const indent = "  ".repeat(depth);
        const body = url ? `[${text}](${url})` : text;
        lines.push(`${indent}- ${body}`);
        walk(child, depth + 1);
      }
    }
    const body = doc.querySelector("body");
    if (body) walk(body, 0);
    return lines.join("\n");
  } catch {
    return "> ⚠️ Could not parse OPML.";
  }
}

/* ─── LaTeX / .tex → Markdown ──────────────────────────────────────── */

export function latexToMarkdown(text: string): string {
  let out = text;
  out = out.replace(/^[\s\S]*?\\begin\{document\}\s*/, "");
  out = out.replace(/\s*\\end\{document\}[\s\S]*$/, "");
  out = out.replace(/\\chapter\*?\{([^}]+)\}/g, "# $1");
  out = out.replace(/\\section\*?\{([^}]+)\}/g, "## $1");
  out = out.replace(/\\subsection\*?\{([^}]+)\}/g, "### $1");
  out = out.replace(/\\subsubsection\*?\{([^}]+)\}/g, "#### $1");
  out = out.replace(/\\textbf\{([^}]+)\}/g, "**$1**");
  out = out.replace(/\\textit\{([^}]+)\}/g, "*$1*");
  out = out.replace(/\\emph\{([^}]+)\}/g, "*$1*");
  out = out.replace(/\\texttt\{([^}]+)\}/g, "`$1`");
  out = out.replace(/\\begin\{itemize\}|\\begin\{enumerate\}/g, "");
  out = out.replace(/\\end\{itemize\}|\\end\{enumerate\}/g, "");
  out = out.replace(/\\item\s+/g, "- ");
  out = out.replace(/\\\[([\s\S]*?)\\\]/g, "$$\n$1\n$$");
  out = out.replace(/\\\(([^)]+)\\\)/g, "$$$1$");
  out = out.replace(/\\&/g, "&").replace(/\\%/g, "%").replace(/\\\$/g, "$");
  out = out.replace(/\\\\/g, "  \n");
  return out.trim();
}

/* ─── reStructuredText → Markdown ──────────────────────────────────── */

export function rstToMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? "";
    if (
      /^[=\-~`'"^*+#<>]{3,}$/.test(next.trim()) &&
      line.trim() &&
      next.trim().length >= line.trim().length
    ) {
      const c = next.trim()[0];
      const level = c === "=" ? 1 : c === "-" ? 2 : c === "~" ? 3 : 4;
      out.push(`${"#".repeat(level)} ${line.trim()}`);
      i++;
      continue;
    }
    out.push(line.replace(/^\*\s/, "- "));
  }
  return out
    .join("\n")
    .replace(/``([^`]+)``/g, "`$1`");
}

/* ─── Legacy .doc (binary Word) → Markdown ─────────────────────────── */

const DOC_LETTER = /[A-Za-zÀ-ɏ֐-׿؀-ۿ]/g;

function countLetters(s: string): number {
  return (s.match(DOC_LETTER) || []).length;
}

/** Keep only lines that are mostly letters — rejects interleaved binary noise. */
function filterReadableLines(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.replace(/[ \t]{2,}/g, " ").trimEnd())
    .filter((l) => {
      const t = l.trim();
      if (t.length < 4) return false;
      return countLetters(t) / t.length >= 0.5;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Recover single-byte (ANSI/Latin-1) printable runs. */
function recoverAnsiText(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    s +=
      (b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d
        ? String.fromCharCode(b)
        : "\n";
  }
  return filterReadableLines(s);
}

/** Recover UTF-16LE printable runs (modern Word stores text as UTF-16). */
function recoverUtf16Text(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const lo = buf[i];
    const hi = buf[i + 1];
    s +=
      hi === 0 &&
      ((lo >= 0x20 && lo <= 0x7e) || lo === 0x09 || lo === 0x0a || lo === 0x0d)
        ? String.fromCharCode(lo)
        : "\n";
  }
  return filterReadableLines(s);
}

/**
 * Convert a legacy binary .doc to Markdown. The old OLE/CFB Word format cannot
 * be parsed losslessly in the browser, so this is deliberately honest rather
 * than fake: it (1) reroutes files that are really RTF/HTML mislabeled as .doc,
 * (2) attempts a conservative dual-encoding text recovery (ANSI + UTF-16LE,
 * keeping whichever yields more letters), and (3) falls back to a clear
 * "couldn't extract" notice instead of dumping binary noise.
 */
export async function legacyDocToMarkdown(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const head = new TextDecoder("latin1").decode(buf.subarray(0, 16));

  // A surprising share of ".doc" files in the wild are really RTF or HTML.
  if (head.startsWith("{\\rtf")) return rtfToMarkdown(new TextDecoder("latin1").decode(buf));
  if (/^\s*<(!doctype|html|\?xml)/i.test(head)) return htmlToMarkdown(new TextDecoder().decode(buf));

  const note =
    "> ⚠️ **Legacy .doc**: the old binary Word format can't be converted losslessly in the browser. " +
    "For full fidelity, open it in Word/LibreOffice and **Save As .docx** (or .rtf), then import that.\n\n---\n\n";

  const ansi = recoverAnsiText(buf);
  const utf16 = recoverUtf16Text(buf);
  const best = countLetters(utf16) > countLetters(ansi) ? utf16 : ansi;

  if (countLetters(best) < 40) {
    return note + "_No readable text could be recovered from this legacy .doc file._";
  }
  return note + best;
}

/* ─── AsciiDoc → Markdown ──────────────────────────────────────────── */

export function adocToMarkdown(text: string): string {
  return text
    .replace(/^(={1,6})\s+(.+)$/gm, (_m, eq: string, t: string) => `${"#".repeat(eq.length)} ${t}`)
    .replace(/^\.([^\n]+)$/gm, "**$1**")
    .replace(/^\*\s/gm, "- ")
    .replace(/`{2}([^`]+?)`{2}/g, "`$1`")
    .replace(/_([^_\n]+?)_/g, "*$1*");
}

/* ─── Org-mode → Markdown ──────────────────────────────────────────── */

export function orgToMarkdown(text: string): string {
  return text
    .replace(/^(\*+)\s+(.+)$/gm, (_m: string, stars: string, t: string) => `${"#".repeat(stars.length)} ${t}`)
    .replace(/\*([^*\n]+)\*/g, "**$1**")
    .replace(/\/([^/\n]+)\//g, "*$1*")
    .replace(/=([^=\n]+)=/g, "`$1`")
    .replace(/^#\+BEGIN_SRC.*$/gm, "```")
    .replace(/^#\+END_SRC$/gm, "```");
}

/* ─── Jupyter notebook (.ipynb) → Markdown ─────────────────────────── */

interface IpynbCell {
  cell_type?: string;
  source?: string | string[];
  outputs?: Array<{
    output_type?: string;
    text?: string | string[];
    data?: Record<string, string | string[]>;
    traceback?: string[];
  }>;
}

/**
 * Convert a Jupyter notebook to Markdown: markdown/raw cells pass through, code
 * cells become fenced blocks in the notebook's language, and code outputs
 * (stream text, text/plain results, ANSI-stripped error tracebacks) follow as
 * plain fenced blocks.
 */
export function ipynbToMarkdown(jsonText: string): string {
  let nb: { cells?: IpynbCell[]; metadata?: unknown };
  try {
    nb = JSON.parse(jsonText) as { cells?: IpynbCell[]; metadata?: unknown };
  } catch {
    return "> ⚠️ Invalid .ipynb file (not valid JSON).";
  }
  const cells = Array.isArray(nb.cells) ? nb.cells : [];
  const meta = (nb.metadata ?? {}) as {
    language_info?: { name?: string };
    kernelspec?: { language?: string };
  };
  const lang = meta.language_info?.name || meta.kernelspec?.language || "python";
  const join = (s: unknown): string =>
    Array.isArray(s) ? s.join("") : typeof s === "string" ? s : "";

  const blocks: string[] = [];
  for (const cell of cells) {
    const text = join(cell.source).replace(/\s+$/, "");
    if (cell.cell_type === "markdown" || cell.cell_type === "raw") {
      if (text.trim()) blocks.push(text);
    } else if (cell.cell_type === "code") {
      if (text.trim()) blocks.push("```" + lang + "\n" + text + "\n```");
      const rendered: string[] = [];
      for (const o of cell.outputs ?? []) {
        if (o.output_type === "stream") {
          rendered.push(join(o.text));
        } else if (o.output_type === "execute_result" || o.output_type === "display_data") {
          if (o.data?.["text/plain"]) rendered.push(join(o.data["text/plain"]));
        } else if (o.output_type === "error") {
          rendered.push(join(o.traceback).replace(/\[[0-9;]*m/g, ""));
        }
      }
      const out = rendered.join("\n").replace(/\s+$/, "").trim();
      if (out) blocks.push("```\n" + out + "\n```");
    }
  }
  return blocks.join("\n\n");
}

/* ─── WordPress export (WXR) → Markdown ────────────────────────────── */

/**
 * WordPress eXtended RSS export → Markdown. Each published post/page becomes a
 * section (H1 title + author/date meta + HTML body converted to Markdown).
 * Drafts, trash, attachments and revisions are skipped. Namespaced tags are
 * matched by localName so we don't depend on XML prefix handling.
 */
export function wxrToMarkdown(xml: string): string {
  const doc = parseInertDocument(xml, "text/xml");
  const childText = (item: Element, localName: string): string => {
    for (const child of Array.from(item.children)) {
      if (child.localName === localName) return child.textContent?.trim() ?? "";
    }
    return "";
  };
  const sections: string[] = [];
  for (const item of Array.from(doc.getElementsByTagName("item"))) {
    const postType = childText(item, "post_type");
    if (postType && postType !== "post" && postType !== "page") continue;
    const status = childText(item, "status");
    if (status && status !== "publish") continue;
    const title = childText(item, "title") || "Untitled";
    const author = childText(item, "creator");
    const date = childText(item, "pubDate");
    const html = childText(item, "encoded");
    const body = html ? htmlToMarkdown(html) : "";
    const meta = [author ? "by " + author : "", date].filter(Boolean).join(" · ");
    const parts = ["# " + title];
    if (meta) parts.push("_" + meta + "_");
    if (body) parts.push(body);
    sections.push(parts.join("\n\n"));
  }
  return sections.length
    ? sections.join("\n\n---\n\n")
    : "> ⚠️ No published WordPress posts found in this export.";
}

/* ─── Confluence storage/view XHTML → Markdown ─────────────────────── */

/**
 * Convert Confluence export XHTML to Markdown. Confluence wraps content in
 * `ac:`/`ri:` macro tags; we turn code macros into fenced blocks, unwrap
 * rich-text panels, resolve internal page links to their title, strip the
 * remaining macro tags, then run the standard HTML→Markdown reader.
 */
export function confluenceToMarkdown(xhtml: string): string {
  const html = xhtml
    .replace(
      /<ac:structured-macro[^>]*ac:name="code"[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/ac:structured-macro>/gi,
      (_m, code: string) =>
        `<pre><code>${code.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</code></pre>`,
    )
    .replace(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/gi, "$1")
    .replace(/<ac:link[^>]*>[\s\S]*?ri:content-title="([^"]*)"[\s\S]*?<\/ac:link>/gi, "$1")
    .replace(/<\/?(?:ac|ri):[^>]*>/gi, "");
  return htmlToMarkdown(html);
}

/**
 * Fountain (screenwriting plain-text, fountain.io) → Markdown.
 *
 * Pragmatic subset of the spec, mapped for readability rather than
 * re-exportable fidelity:
 *   title page key/values → `# Title` + a bold metadata block
 *   scene headings (INT./EXT./EST./I/E or forced `.`) → `## ` headings
 *   sections `#`/`##`/… → headings one level down (the title keeps `#`)
 *   synopses `= …` → italic line · page breaks `===` → `---`
 *   transitions (ALL-CAPS ending `TO:` or forced `>`) → italic line
 *   centered `>text<` → bold line
 *   CHARACTER cues → bold, parentheticals italic, dialogue as blockquote
 *   lyrics `~…` → italic · boneyard comments and `[[notes]]` stripped
 */
export function fountainToMarkdown(text: string): string {
  // Strip boneyard comments and notes first (both may span lines).
  let src = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\[\[[\s\S]*?\]\]/g, "");
  src = src.replace(/\r\n?/g, "\n");

  const out: string[] = [];
  const lines = src.split("\n");
  let i = 0;

  // ── Title page: leading `Key: value` pairs up to the first blank line ──
  if (/^[A-Za-z][A-Za-z ]*:/.test(lines[0] ?? "")) {
    const meta: Array<[string, string]> = [];
    while (i < lines.length && lines[i].trim() !== "") {
      const m = /^([A-Za-z][A-Za-z ]*):\s*(.*)$/.exec(lines[i]);
      if (m) {
        meta.push([m[1].trim(), m[2].trim()]);
      } else if (meta.length && /^\s+\S/.test(lines[i])) {
        // indented continuation line (multi-line values, e.g. Contact:)
        meta[meta.length - 1][1] = (meta[meta.length - 1][1] + " " + lines[i].trim()).trim();
      }
      i++;
    }
    const title = meta.find(([k]) => k.toLowerCase() === "title");
    if (title?.[1]) out.push(`# ${title[1]}`, "");
    const rest = meta.filter(([k, v]) => k.toLowerCase() !== "title" && v);
    if (rest.length) {
      for (const [k, v] of rest) out.push(`**${k}:** ${v}  `);
      out.push("");
    }
  }

  const isSceneHeading = (ln: string): boolean =>
    /^(INT|EXT|EST|INT\.?\/EXT|I\/E)[. ]/i.test(ln.trim());
  const isTransition = (ln: string): boolean => /^[A-Z0-9 .']+TO:$/.test(ln.trim());
  const isCharacterCue = (ln: string): boolean => {
    const t = ln.trim();
    if (!t || t.length > 60) return false;
    // ALL-CAPS (digits/space/./'/- allowed, optional trailing parenthetical
    // extension like (V.O.), optional dual-dialogue caret)
    const m = /^(@)?([A-Z0-9 .'\-]+)(\s*\([^)]*\))?\s*\^?$/.exec(t);
    if (!m) return false;
    if (m[1]) return true; // forced @CUE
    const name = m[2].trim();
    return (
      /[A-Z]/.test(name) &&
      name === name.toUpperCase() &&
      !isSceneHeading(t) &&
      !isTransition(t)
    );
  };

  while (i < lines.length) {
    const ln = lines[i].trim();

    if (ln === "") {
      if (out[out.length - 1] !== "") out.push("");
      i++;
      continue;
    }
    if (/^={3,}$/.test(ln)) {
      out.push("---", "");
      i++;
      continue;
    }
    if (/^#{1,6}\s/.test(ln)) {
      const m = /^(#{1,6})\s*(.*)$/.exec(ln)!;
      out.push(`${"#".repeat(Math.min(m[1].length + 1, 6))} ${m[2].trim()}`, "");
      i++;
      continue;
    }
    if (/^=\s/.test(ln)) {
      out.push(`*${ln.slice(1).trim()}*`, "");
      i++;
      continue;
    }
    if (/^>.*<$/.test(ln)) {
      out.push(`**${ln.slice(1, -1).trim()}**`, "");
      i++;
      continue;
    }
    if (ln.startsWith(">") || isTransition(ln)) {
      out.push(`*${ln.replace(/^>\s*/, "").trim()}*`, "");
      i++;
      continue;
    }
    // Forced scene heading `.HEADING` (but not "..." ellipsis action)
    if (ln.startsWith(".") && !ln.startsWith("..")) {
      out.push(`## ${ln.slice(1).trim()}`, "");
      i++;
      continue;
    }
    if (isSceneHeading(ln)) {
      out.push(`## ${ln}`, "");
      i++;
      continue;
    }
    if (ln.startsWith("~")) {
      out.push(`*${ln.slice(1).trim()}*`, "");
      i++;
      continue;
    }
    // Character cue: must be followed by a non-blank dialogue line.
    if (isCharacterCue(ln) && (lines[i + 1] ?? "").trim() !== "") {
      out.push(`**${ln.replace(/^@/, "").replace(/\s*\^$/, "")}**`);
      i++;
      while (i < lines.length && lines[i].trim() !== "") {
        const d = lines[i].trim();
        if (/^\(.*\)$/.test(d)) out.push(`*${d}*`);
        else out.push(`> ${d.replace(/^!/, "")}`);
        i++;
      }
      out.push("");
      continue;
    }
    // Action (default); `!` forces action — strip the marker.
    out.push(ln.replace(/^!/, ""));
    i++;
  }

  return (
    out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  );
}

// The list lives in a module of its own, so the file picker can name the
// formats without loading the converters (startup budget).
export { SUPPORTED_IMPORT_EXTENSIONS, isSupportedFormat } from "./importExtensions";
