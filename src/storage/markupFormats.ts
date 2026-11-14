/**
 * Text and markup formats → Markdown (split out of fileFormats.ts, plan W4.11):
 * HTML, RTF, CSV/TSV, JSON, XML, MHTML/EML, OPML, LaTeX, RST, AsciiDoc, Org,
 * Jupyter notebooks, WordPress WXR and Confluence. Zero external dependencies;
 * fileFormats.ts re-exports every one of them, so importers are unchanged.
 */
import { parseInertDocument } from "../lib/trustedTypes";

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
