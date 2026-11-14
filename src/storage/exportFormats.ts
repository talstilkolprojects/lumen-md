/**
 * Markdown → other formats. Each function returns the converted string;
 * the caller is responsible for triggering the download.
 *
 * The conversions are intentionally simple — they cover the same subset
 * the import side recognises (`fileFormats.ts`). Round-tripping a doc
 * through Markdown → X → Markdown should preserve headings, emphasis,
 * lists, links, and code; complex layout is on its own.
 *
 * For full-fidelity pipelines (e.g. journal-grade LaTeX, fully-styled
 * RTF), pipe through Pandoc. We document that in `docs/`.
 */

import { zip } from "./zip";
import { pageFileSlug } from "../lib/slug";
import { firstRtlLanguage, firstStrongDirection, hasRtl, markdownBaseDirection } from "../lib/textDirection";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * CommonMark-style fenced-code tracker. A fence opens with ``` or ~~~ (3+,
 * up to 3 spaces indent) and closes only on a line of the SAME character,
 * at least as long, with nothing else on it — so a ```` block that
 * demonstrates a ``` fence (or a ~~~ line inside ```) stays code.
 * Feed every line in order; returns whether it is a fence line and whether
 * we're inside code after it.
 */
export function createFenceTracker(): (line: string) => { fence: boolean; inCode: boolean } {
  let open: { ch: string; len: number } | null = null;
  return (line: string) => {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open) {
      if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
        open = { ch: m[1][0], len: m[1].length };
        return { fence: true, inCode: true };
      }
      return { fence: false, inCode: false };
    }
    if (m && m[1][0] === open.ch && m[1].length >= open.len && m[2].trim() === "") {
      open = null;
      return { fence: true, inCode: false };
    }
    return { fence: false, inCode: true };
  };
}

/**
 * Markdown → RTF. Uses the minimal RTF 1.5 dialect that every RTF
 * reader on macOS / Windows / Pages handles. Headings become
 * \pard\fs36\b, bold becomes \b…\b0, etc.
 */
export function markdownToRtf(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  out.push(
    "{\\rtf1\\ansi\\deff0",
    "{\\fonttbl{\\f0 Helvetica;}{\\f1 Courier New;}}",
    "{\\colortbl;\\red0\\green0\\blue0;\\red120\\green80\\blue255;}",
    "\\fs24",
  );
  const fenceAt = createFenceTracker();
  for (const line of lines) {
    const { fence, inCode } = fenceAt(line);
    if (fence) {
      out.push(inCode ? "\\pard\\f1\\fs20" : "\\pard\\f0\\fs24");
      continue;
    }
    if (inCode) {
      out.push(escapeRtf(line) + "\\par");
      continue;
    }
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      const size = 36 - (h[1].length - 1) * 4;
      out.push(`\\pard\\fs${size}\\b ${escapeRtf(h[2])}\\b0\\fs24\\par`);
      continue;
    }
    if (/^[-*+]\s/.test(line)) {
      const t = line.replace(/^[-*+]\s+/, "");
      out.push(`\\pard\\bullet  ${escapeRtfInline(t)}\\par`);
      continue;
    }
    if (!line.trim()) {
      out.push("\\par");
      continue;
    }
    out.push(escapeRtfInline(line) + "\\par");
  }
  out.push("}");
  return out.join("\n");
}

function escapeRtf(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/[{}]/g, "\\$&");
}
function escapeRtfInline(s: string): string {
  return escapeRtf(s)
    .replace(/\*\*([^*]+)\*\*/g, "\\b $1\\b0")
    .replace(/\*([^*]+)\*/g, "\\i $1\\i0")
    .replace(/`([^`]+)`/g, "{\\f1 $1}")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}

/**
 * Markdown → LaTeX (article class). Heads → sections, lists →
 * itemize/enumerate, code fences → verbatim, $$…$$ → unwrapped display
 * math.
 */
export function markdownToLatex(md: string): string {
  const lines = md.split(/\r?\n/);
  // Hebrew (or Arabic) anywhere → XeLaTeX + polyglossia, the only engine
  // that typesets RTL properly; the main language follows the document's
  // base direction and every paragraph in the other direction is wrapped
  // in that language's environment (T44).
  const rtl = hasRtl(md);
  const base = markdownBaseDirection(md);
  // The first RTL passage decides, not the first strong character (an
  // English-first document with Arabic later is Arabic).
  const rtlLang = firstRtlLanguage(md) === "ar" ? "arabic" : "hebrew";
  const out: string[] = rtl
    ? [
        "% Compile with xelatex (Hebrew/Arabic need fontspec + polyglossia).",
        "\\documentclass{article}",
        "\\usepackage{fontspec}",
        "\\usepackage{polyglossia}",
        base === "rtl" ? `\\setmainlanguage{${rtlLang}}` : "\\setmainlanguage{english}",
        base === "rtl" ? "\\setotherlanguage{english}" : `\\setotherlanguage{${rtlLang}}`,
        "\\setmainfont{Noto Serif}",
        rtlLang === "hebrew" ? "\\newfontfamily\\hebrewfont[Script=Hebrew]{Noto Serif Hebrew}" : "\\newfontfamily\\arabicfont[Script=Arabic]{Noto Naskh Arabic}",
        "\\usepackage{hyperref}",
        "\\usepackage{listings}",
        "\\usepackage{amsmath}",
        "\\begin{document}",
      ]
    : [
        "\\documentclass{article}",
        "\\usepackage[utf8]{inputenc}",
        "\\usepackage{hyperref}",
        "\\usepackage{listings}",
        "\\usepackage{amsmath}",
        "\\begin{document}",
      ];
  const otherLang = base === "rtl" ? "english" : rtlLang;
  /** Wrap a paragraph whose direction differs from the document's. */
  const inLang = (tex: string, source: string): string => {
    if (!rtl) return tex;
    const d = firstStrongDirection(source);
    return d && d !== base ? `\\begin{${otherLang}}${tex}\\end{${otherLang}}` : tex;
  };
  /** Same, inline (headings, list items): \\textenglish{…} / \\texthebrew{…}. */
  const inLangInline = (tex: string, source: string): string => {
    if (!rtl) return tex;
    const d = firstStrongDirection(source);
    return d && d !== base ? `\\text${otherLang}{${tex}}` : tex;
  };
  const fenceAt = createFenceTracker();
  let inList = false;
  for (const line of lines) {
    const { fence, inCode } = fenceAt(line);
    if (fence) {
      out.push(inCode ? "\\begin{verbatim}" : "\\end{verbatim}");
      continue;
    }
    if (inCode) {
      out.push(line);
      continue;
    }
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      const cmd =
        h[1].length === 1
          ? "section"
          : h[1].length === 2
            ? "subsection"
            : "subsubsection";
      out.push(`\\${cmd}{${inLangInline(escapeLatex(h[2]), h[2])}}`);
      continue;
    }
    if (/^[-*+]\s/.test(line)) {
      if (!inList) {
        out.push("\\begin{itemize}");
        inList = true;
      }
      const item = line.replace(/^[-*+]\s+/, "");
      out.push(`\\item ${inLangInline(escapeLatexInline(item), item)}`);
      continue;
    } else if (inList && line.trim() === "") {
      out.push("\\end{itemize}");
      inList = false;
    }
    if (!line.trim()) {
      out.push("");
      continue;
    }
    out.push(inLang(escapeLatexInline(line), line));
  }
  if (inList) out.push("\\end{itemize}");
  out.push("\\end{document}");
  return out.join("\n");
}

/** The visible text of rendered HTML: no tags, no entity names (`&amp;` is not Latin text). */
function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&(?:#\d+|#x[\da-f]+|[a-z][\da-z]*);/gi, " ");
}

/** lang for a rendered page body: he / ar by script, else en. */
function pageLang(html: string): string {
  const text = visibleText(html);
  return firstStrongDirection(text) === "rtl" ? firstRtlLanguage(text) ?? "en" : "en";
}

function escapeLatex(s: string): string {
  return s.replace(/[\\&%$#_{}~^]/g, "\\$&");
}
function escapeLatexInline(s: string): string {
  return escapeLatex(s)
    .replace(/\*\*([^*]+)\*\*/g, "\\textbf{$1}")
    .replace(/\*([^*]+)\*/g, "\\textit{$1}")
    .replace(/`([^`]+)`/g, "\\texttt{$1}")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "\\href{$2}{$1}");
}

/**
 * Markdown → reStructuredText. Headings get an underline of `=` / `-` / `~`
 * matching the heading text length. Inline code and emphasis convert.
 */
export function markdownToRst(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      const c = h[1].length === 1 ? "=" : h[1].length === 2 ? "-" : "~";
      out.push(h[2]);
      out.push(c.repeat(h[2].length));
      out.push("");
      continue;
    }
    out.push(
      line
        .replace(/`([^`]+)`/g, "``$1``")
        .replace(/\*\*([^*]+)\*\*/g, "**$1**")
        .replace(/\*([^*]+)\*/g, "*$1*"),
    );
  }
  return out.join("\n");
}

/**
 * Markdown → AsciiDoc. Heading depth maps 1:1 (# → =, ## → ==), inline
 * stays close enough that a paste into Asciidoctor will Just Work.
 */
export function markdownToAdoc(md: string): string {
  return md
    .replace(/^(#{1,6})\s+(.+)$/gm, (_m, hashes: string, t: string) => `${"=".repeat(hashes.length)} ${t}`)
    .replace(/^[-*+]\s/gm, "* ")
    .replace(/`([^`]+)`/g, "``$1``")
    .replace(/\*\*([^*]+)\*\*/g, "*$1*"); // adoc bold
}

/**
 * Markdown → Org-mode. Heading depth maps 1:1 (# → *, ## → **), bold &
 * italic syntax adjusted, code fences become `#+BEGIN_SRC`.
 */
export function markdownToOrg(md: string): string {
  return md
    .replace(/^(#{1,6})\s+(.+)$/gm, (_m, hashes: string, t: string) => `${"*".repeat(hashes.length)} ${t}`)
    .replace(/```(\w*)\n([\s\S]*?)```/g, "#+BEGIN_SRC $1\n$2#+END_SRC")
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "/$1/")
    .replace(/`([^`]+)`/g, "=$1=");
}

/** Markdown → OPML (treat top-level lists as the outline). */
export function markdownToOpml(md: string, title = "Outline"): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<opml version="2.0">');
  out.push(`<head><title>${escapeHtml(title)}</title></head>`);
  out.push("<body>");
  const stack: number[] = [];
  for (const line of lines) {
    const m = /^( *)[-*+]\s+(.+)$/.exec(line);
    if (!m) continue;
    const depth = Math.floor(m[1].length / 2);
    while (stack.length && stack[stack.length - 1] >= depth) {
      out.push("</outline>");
      stack.pop();
    }
    out.push(`<outline text="${escapeHtml(m[2])}">`);
    stack.push(depth);
  }
  while (stack.length) {
    out.push("</outline>");
    stack.pop();
  }
  out.push("</body>");
  out.push("</opml>");
  return out.join("\n");
}

/* ─── Markdown → Reveal.js slide deck ──────────────────────────────── */

/**
 * Build a self-contained Reveal.js presentation. Slides are split on `---`
 * thematic breaks (the standard Reveal markdown convention); each becomes a
 * `<section data-markdown>` rendered by Reveal's markdown plugin. Reveal's
 * runtime + theme load from a CDN, so the file is portable but online.
 */
/**
 * Shared slide splitter (Reveal + PPTX exports). When the deck uses `---`
 * thematic breaks, those are the slide boundaries (the Reveal convention).
 * Otherwise every H1/H2 heading starts a new slide. Fence-aware: `---` or
 * `#` lines inside ``` code blocks never split. Empty chunks are dropped.
 */
export function splitSlides(md: string): string[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let hasRule = false;
  {
    const fenceAt = createFenceTracker();
    for (const l of lines) {
      const { fence, inCode } = fenceAt(l);
      if (!fence && !inCode && /^\s*---\s*$/.test(l)) hasRule = true;
    }
  }
  const chunks: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    const s = cur.join("\n").trim();
    if (s) chunks.push(s);
    cur = [];
  };
  const fenceAt = createFenceTracker();
  for (const l of lines) {
    const { fence, inCode } = fenceAt(l);
    if (fence) {
      cur.push(l);
      continue;
    }
    if (!inCode) {
      if (hasRule && /^\s*---\s*$/.test(l)) {
        flush();
        continue;
      }
      if (!hasRule && /^#{1,2}\s/.test(l)) flush();
    }
    cur.push(l);
  }
  flush();
  return chunks;
}

export function markdownToRevealHtml(md: string, title = "Slides"): string {
  const slides = splitSlides(md);
  const sections = (slides.length ? slides : [md])
    .map(
      (s) =>
        `<section data-markdown><textarea data-template>\n${s}\n</textarea></section>`,
    )
    .join("\n");
  const cdn = "https://cdn.jsdelivr.net/npm/reveal.js@5";
  return [
    `<!doctype html>`,
    `<html><head><meta charset="utf-8" />`,
    `<meta name="viewport" content="width=device-width, initial-scale=1" />`,
    `<title>${escapeHtml(title)}</title>`,
    `<link rel="stylesheet" href="${cdn}/dist/reveal.css">`,
    `<link rel="stylesheet" href="${cdn}/dist/theme/black.css">`,
    `</head><body><div class="reveal"><div class="slides">`,
    sections,
    `</div></div>`,
    `<script src="${cdn}/dist/reveal.js"></script>`,
    `<script src="${cdn}/plugin/markdown/markdown.js"></script>`,
    `<script>Reveal.initialize({ hash: true, plugins: [ RevealMarkdown ] });</script>`,
    `</body></html>`,
  ].join("\n");
}

/* ─── Markdown → EPUB 3 (real package, zipped) ─────────────────────── */

function mdInlineToHtml(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

/** Minimal, well-formed XHTML body conversion for EPUB chapters. */
function mdToXhtml(md: string): string {
  const out: string[] = [];
  let inList = false;
  let inCode = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const line of md.split(/\r?\n/)) {
    if (/^```/.test(line.trim())) {
      closeList();
      out.push(inCode ? "</code></pre>" : "<pre><code>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(line));
      continue;
    }
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      closeList();
      out.push(`<h${h[1].length}>${mdInlineToHtml(h[2])}</h${h[1].length}>`);
      continue;
    }
    const li = /^[-*+]\s+(.+)$/.exec(line);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${mdInlineToHtml(li[1])}</li>`);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${mdInlineToHtml(line)}</p>`);
  }
  closeList();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

/** Build a valid EPUB 3 package as raw bytes (chapters split on H1). */
export async function markdownToEpubBytes(md: string, title = "Document"): Promise<Uint8Array> {
  const parts = md
    .split(/^(?=# )/m)
    .map((s) => s.trim())
    .filter(Boolean);
  // Language and reading direction (T44): a Hebrew book opens from the
  // right and reads right-to-left in every reader.
  const bookDir = markdownBaseDirection(md);
  // An RTL book's language is its first RTL passage's: frontmatter keys
  // and code are Latin and would otherwise decide.
  const bookLang = (bookDir === "rtl" ? firstRtlLanguage(md) : null) ?? "en";
  const chapters = (parts.length ? parts : [md]).map((c, i) => {
    const chTitle = c.match(/^#\s+(.+)$/m)?.[1] ?? `Chapter ${i + 1}`;
    const dir = markdownBaseDirection(c);
    const lang = (dir === "rtl" ? firstRtlLanguage(c) : null) ?? (dir === bookDir ? bookLang : "en");
    const xhtml =
      `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n` +
      `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}" lang="${lang}" dir="${dir}"><head><title>${escapeHtml(chTitle)}</title></head>` +
      `<body>\n${mdToXhtml(c)}\n</body></html>`;
    return { id: `ch${i + 1}`, href: `chapter${i + 1}.xhtml`, title: chTitle, xhtml };
  });

  const uid = "urn:uuid:" + (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(16));
  const container =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
    `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const opf =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">` +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    `<dc:identifier id="bookid">${uid}</dc:identifier>` +
    `<dc:title>${escapeHtml(title)}</dc:title><dc:language>${bookLang}</dc:language>` +
    `<meta property="dcterms:modified">1970-01-01T00:00:00Z</meta></metadata>` +
    `<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` +
    chapters.map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`).join("") +
    `</manifest><spine${bookDir === "rtl" ? ' page-progression-direction="rtl"' : ""}>` +
    chapters.map((c) => `<itemref idref="${c.id}"/>`).join("") +
    `</spine></package>`;
  const nav =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${bookLang}" lang="${bookLang}" dir="${bookDir}"><head><title>Contents</title></head>` +
    `<body><nav epub:type="toc"><ol>` +
    chapters.map((c) => `<li><a href="${c.href}">${escapeHtml(c.title)}</a></li>`).join("") +
    `</ol></nav></body></html>`;

  return zip([
    // The mimetype entry must come first and be stored (uncompressed).
    { name: "mimetype", data: "application/epub+zip", store: true },
    { name: "META-INF/container.xml", data: container },
    { name: "OEBPS/content.opf", data: opf },
    { name: "OEBPS/nav.xhtml", data: nav },
    ...chapters.map((c) => ({ name: `OEBPS/${c.href}`, data: c.xhtml })),
  ]);
}

/* ─── Markdown → static site (multi-page HTML + nav + RSS) ─────────── */

const SITE_CSS = [
  ":root{--accent:#7c5cff}",
  "*{box-sizing:border-box}body{margin:0;font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#222}",
  ".layout{display:flex;min-height:100vh}",
  "aside{width:240px;background:#f6f6fb;border-inline-end:1px solid #e5e5ef;padding:24px 16px}",
  "aside ul{list-style:none;margin:0;padding:0}aside li{margin:4px 0}",
  "aside a{color:#444;text-decoration:none;display:block;padding:6px 10px;border-radius:6px}",
  "aside a.active,aside a:hover{background:var(--accent);color:#fff}",
  "main{flex:1;padding:40px 56px;max-width:820px}",
  "h1,h2,h3{line-height:1.25}h1{border-bottom:2px solid var(--accent);padding-bottom:8px}",
  "code{background:#f0f0f4;padding:2px 5px;border-radius:4px;font-size:.9em}",
  "pre{background:#1e1e2e;color:#e8e8f0;padding:16px;border-radius:8px;overflow:auto}pre code{background:none}",
  "a{color:var(--accent)}",
].join("\n");

/**
 * Build a self-contained static documentation site as a zip: one HTML page per
 * top-level (H1) section, a shared sidebar nav, a stylesheet, and an RSS feed.
 * Open index.html to browse. Exported as bytes for download.
 */
export async function markdownToStaticSiteBytes(md: string, siteTitle = "Site"): Promise<Uint8Array> {
  const parts = md
    .split(/^(?=# )/m)
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const pages = (parts.length ? parts : [md]).map((c, i) => {
    const title = c.match(/^#\s+(.+)$/m)?.[1] ?? `Page ${i + 1}`;
    let slug = pageFileSlug(title, `page-${i + 1}`);
    while (seen.has(slug)) slug = `${slug}-${i}`;
    seen.add(slug);
    return { title, file: `${slug}.html`, body: mdToXhtml(c) };
  });

  const nav = (active: string) =>
    `<nav><ul>` +
    pages
      .map(
        (p) =>
          `<li><a href="${encodeURIComponent(p.file)}"${p.file === active ? ' class="active" aria-current="page"' : ""}>${escapeHtml(p.title)}</a></li>`,
      )
      .join("") +
    `</ul></nav>`;
  const pageHtml = (p: { title: string; file: string; body: string }) =>
    `<!doctype html><html lang="${pageLang(p.body)}" dir="${firstStrongDirection(visibleText(p.body)) ?? "ltr"}"><head><meta charset="utf-8" />` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
    `<title>${escapeHtml(p.title)} — ${escapeHtml(siteTitle)}</title>` +
    `<link rel="stylesheet" href="style.css" /></head><body>` +
    `<div class="layout"><aside><strong>${escapeHtml(siteTitle)}</strong>${nav(p.file)}</aside>` +
    `<main>${p.body}</main></div></body></html>`;

  const rss =
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>` +
    `<title>${escapeHtml(siteTitle)}</title><description>${escapeHtml(siteTitle)}</description>` +
    pages.map((p) => `<item><title>${escapeHtml(p.title)}</title><link>${encodeURIComponent(p.file)}</link></item>`).join("") +
    `</channel></rss>`;

  return zip([
    { name: "index.html", data: pageHtml(pages[0]) },
    ...pages.map((p) => ({ name: p.file, data: pageHtml(p) })),
    { name: "style.css", data: SITE_CSS },
    { name: "feed.xml", data: rss },
  ]);
}

/* ─── Markdown → Jupyter notebook (.ipynb) ─────────────────────────── */

/**
 * Convert Markdown to a valid Jupyter notebook (nbformat 4.5). Fenced code
 * blocks become code cells (in the fence's language); everything else becomes
 * markdown cells. Round-trips with `ipynbToMarkdown` in ./fileFormats.
 */
export function markdownToIpynb(md: string, lang = "python"): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const toSource = (text: string): string[] => {
    if (text === "") return [];
    const ls = text.split("\n");
    return ls.map((l, idx) => (idx < ls.length - 1 ? l + "\n" : l));
  };
  const cells: Array<Record<string, unknown>> = [];
  let prose: string[] = [];
  const flushProse = () => {
    const text = prose.join("\n").trim();
    if (text) cells.push({ cell_type: "markdown", metadata: {}, source: toSource(text) });
    prose = [];
  };

  let i = 0;
  while (i < lines.length) {
    const fence = lines[i].match(/^\s*```(\w+)?/);
    if (fence) {
      flushProse();
      i++;
      const code: string[] = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // closing fence
      cells.push({
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: toSource(code.join("\n")),
      });
    } else {
      prose.push(lines[i]);
      i++;
    }
  }
  flushProse();

  return JSON.stringify(
    {
      cells,
      metadata: { language_info: { name: lang } },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  );
}

/** Trigger a browser download for arbitrary text content. */
export function downloadText(filename: string, content: string, mime = "text/plain"): void {
  downloadBytes(filename, new TextEncoder().encode(content), `${mime};charset=utf-8`);
}

/** Trigger a browser download for binary content. */
export function downloadBytes(filename: string, bytes: Uint8Array, mime = "application/octet-stream"): void {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
