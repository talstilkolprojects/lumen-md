/**
 * Faithful paste (W1.4): HTML from the clipboard (Word, Google Docs,
 * Wikipedia, news sites, Gmail; Hebrew and mixed) to clean Markdown.
 *
 * Two steps, both on an inert DOM (nothing in the pasted HTML runs):
 *
 * 1. `cleanPastedDom` undoes what each source does to its HTML.
 *    - Word: `MsoListParagraph` paragraphs with `mso-list: l0 level2` become
 *      real nested lists (the bullet glyph or number picks `ul` or `ol`);
 *      `MsoTitle` / `MsoHeading` become headings; conditional comments,
 *      `<o:p>` and other Office tags go.
 *    - Google Docs: the `docs-internal-guid` wrapper goes; spans styled
 *      bold / italic / struck become `strong` / `em` / `del`; flat lists with
 *      `aria-level` are nested again.
 *    - Websites: scripts, styles, forms, Wikipedia's edit links and
 *      citation markers go; Gmail's quoted reply becomes a quote.
 *    - Every `style`, `class`, `dir`, `align` and `lang` goes: the Markdown
 *      carries no inline style and no direction (each block finds its own).
 * 2. `domToMarkdown` writes GFM: headings, paragraphs, emphasis, links,
 *   images, code, nested lists, tables and quotes.
 *
 * Invisible direction controls are removed (`cleanBidiControls`): the
 * embeddings and overrides always (LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI,
 * PDI), LRM and RLM unless they sit between a letter of the other direction
 * and the neutral or digit run they decide the order of.
 */
import { parseInertDocument } from "../lib/trustedTypes";

/* ─── Direction controls ───────────────────────────────────────────── */

const EMBEDDINGS = /[\u202A-\u202E\u2066-\u2069]/g;
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LTR = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;
const DIGIT_OR_NEUTRAL = /[0-9\s.,:;!?()[\]{}"'\-–—/%+=*#@&]/;

/**
 * Remove direction controls nothing needs. An LRM (or RLM) stays only when the
 * character after it is a digit or neutral and the strong text before it runs
 * the other way: there it keeps the run on the mark's side (`שלום\u200E (2)`).
 */
export function cleanBidiControls(s: string): string {
  const noEmbed = s.replace(EMBEDDINGS, "");
  let out = "";
  for (let i = 0; i < noEmbed.length; i++) {
    const c = noEmbed[i];
    if (c !== "\u200E" && c !== "\u200F") {
      out += c;
      continue;
    }
    if (out.endsWith(c)) continue; // a repeated mark adds nothing
    const next = noEmbed[i + 1];
    const prev = out[out.length - 1] ?? "";
    const before = RTL.test(prev) ? "rtl" : LTR.test(prev) ? "ltr" : null;
    const markDir = c === "\u200E" ? "ltr" : "rtl";
    if (next !== undefined && DIGIT_OR_NEUTRAL.test(next) && before !== null && before !== markDir) out += c;
  }
  return out;
}

/** Count of direction controls in a string (for the paste report and tests). */
export function countBidiControls(s: string): number {
  return (s.match(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g) ?? []).length;
}

/* ─── Cleaning ─────────────────────────────────────────────────────── */

const DROP = "script,style,noscript,template,iframe,object,embed,form,input,button,select,textarea,svg,canvas,meta,link,title,head";
const SITE_NOISE = ".mw-editsection,sup.reference,.reference,.noprint,.mw-jump-link,.gmail_signature,[aria-hidden=true]";
const STRIP_ATTRS = ["style", "class", "dir", "align", "lang", "id", "width", "height", "bgcolor", "color", "face", "valign", "role", "aria-level", "data-sheets-value"];

function unwrap(el: Element): void {
  el.replaceWith(...Array.from(el.childNodes));
}

function rename(el: Element, tag: string): Element {
  const doc = el.ownerDocument;
  const n = doc.createElement(tag);
  for (const a of Array.from(el.attributes)) n.setAttribute(a.name, a.value);
  n.append(...Array.from(el.childNodes));
  el.replaceWith(n);
  return n;
}

function styleOf(el: Element): string {
  return (el.getAttribute("style") ?? "").toLowerCase();
}

/** Word's list paragraphs (`mso-list: l1 level2 lfo3`) into nested lists. */
function wordLists(body: HTMLElement): void {
  const doc = body.ownerDocument;
  const isItem = (el: Element | null): el is HTMLElement =>
    !!el && el.tagName === "P" && /mso-list:\s*l\d+\s+level\d+/i.test(el.getAttribute("style") ?? "");
  const items = Array.from(body.querySelectorAll("p")).filter(isItem);
  const done = new Set<Element>();
  for (const first of items) {
    if (done.has(first)) continue;
    const run: HTMLElement[] = [];
    for (let el: Element | null = first; isItem(el); el = el.nextElementSibling) {
      run.push(el);
      done.add(el);
    }
    const stack: { list: HTMLElement; level: number }[] = [];
    let top: HTMLElement | null = null;
    for (const p of run) {
      const level = Number(/level(\d+)/i.exec(p.getAttribute("style") ?? "")?.[1] ?? "1");
      // The bullet or number Word wrote, in a supportLists span or as text.
      const marker = p.querySelector("span[style*='mso-list:Ignore' i], span[style*='mso-list: Ignore' i]");
      const markerText = (marker?.textContent ?? "").replace(/\s|\u00A0/g, "");
      marker?.remove();
      const ordered = /^(\(?[0-9]+|[a-zA-Z]|[א-ת]|[ivxlcdmIVXLCDM]+)[.)]$/.test(markerText);
      while (stack.length && stack[stack.length - 1].level > level) stack.pop();
      let cur = stack[stack.length - 1];
      if (!cur || cur.level < level) {
        const list = doc.createElement(ordered ? "ol" : "ul");
        if (cur) {
          const lastLi = cur.list.lastElementChild ?? cur.list.appendChild(doc.createElement("li"));
          lastLi.appendChild(list);
        } else top = list;
        cur = { list, level };
        stack.push(cur);
      }
      const li = doc.createElement("li");
      li.append(...Array.from(p.childNodes));
      cur.list.appendChild(li);
    }
    if (top) run[0].before(top);
    run.forEach((p) => p.remove());
  }
}

/** Google Docs writes nested lists flat, one list per level, with aria-level on each item. */
function docsLists(body: HTMLElement): void {
  const doc = body.ownerDocument;
  for (const list of Array.from(body.querySelectorAll("ul,ol"))) {
    if (!list.isConnected || !list.querySelector(":scope > li[aria-level]")) continue;
    // Collect this list and the flat lists right after it.
    const run: Element[] = [list];
    for (let n = list.nextElementSibling; n && /^(UL|OL)$/.test(n.tagName) && n.querySelector(":scope > li[aria-level]"); n = n.nextElementSibling)
      run.push(n);
    const root = doc.createElement(list.tagName.toLowerCase());
    const stack: { list: Element; level: number }[] = [{ list: root, level: 1 }];
    for (const l of run) {
      for (const li of Array.from(l.children)) {
        const level = Number(li.getAttribute("aria-level") ?? "1");
        while (stack.length > 1 && stack[stack.length - 1].level > level) stack.pop();
        let cur = stack[stack.length - 1];
        if (level > cur.level) {
          const sub = doc.createElement(l.tagName.toLowerCase());
          const host = cur.list.lastElementChild ?? cur.list.appendChild(doc.createElement("li"));
          host.appendChild(sub);
          cur = { list: sub, level };
          stack.push(cur);
        }
        cur.list.appendChild(li);
      }
    }
    run[0].before(root);
    run.forEach((l) => l.remove());
  }
}

/** Undo what Word, Google Docs and websites do to clipboard HTML. */
export function cleanPastedDom(body: HTMLElement): void {
  const doc = body.ownerDocument;
  // Comments (Word's conditional ones included) and Office namespaces.
  const walker = doc.createTreeWalker(body, 128 /* SHOW_COMMENT */);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.parentNode?.removeChild(c));
  for (const el of Array.from(body.querySelectorAll("*"))) {
    if (el.tagName.includes(":")) {
      if (/^o:p$/i.test(el.tagName)) el.replaceWith(...Array.from(el.childNodes));
      else el.remove();
    }
  }
  body.querySelectorAll(DROP).forEach((n) => n.remove());
  body.querySelectorAll(SITE_NOISE).forEach((n) => n.remove());

  wordLists(body);
  for (const p of Array.from(body.querySelectorAll("p.MsoTitle, p[class^='MsoHeading'], p.MsoSubtitle"))) {
    const cls = p.getAttribute("class") ?? "";
    const level = cls === "MsoTitle" ? 1 : cls === "MsoSubtitle" ? 2 : Number(/(\d)/.exec(cls)?.[1] ?? "2");
    rename(p, `h${Math.min(6, Math.max(1, level))}`);
  }

  // Google Docs: the guid wrapper is a <b> that means nothing.
  body.querySelectorAll("b[id^='docs-internal-guid']").forEach((b) => unwrap(b));
  docsLists(body);

  // Styled spans to semantic tags; <b>/<i> styled normal are not bold.
  for (const el of Array.from(body.querySelectorAll("span,b,i,font"))) {
    const st = styleOf(el);
    const tag = el.tagName;
    let node: Element = el;
    if ((tag === "B" && /font-weight:\s*(normal|[1-5]00)\b/.test(st)) || (tag === "I" && /font-style:\s*normal/.test(st))) {
      node = rename(el, "span");
    }
    if (node.tagName === "SPAN" || node.tagName === "FONT") {
      const bold = /font-weight:\s*(bold|[6-9]00)\b/.test(st);
      const italic = /font-style:\s*italic/.test(st);
      const strike = /text-decoration[^;]*line-through/.test(st);
      const mono = /font-family:[^;]*(courier|consolas|monospace|menlo)/.test(st);
      let inner: Element = node;
      const wrap = (t: string) => {
        const w = doc.createElement(t);
        w.append(...Array.from(inner.childNodes));
        inner.appendChild(w);
        inner = w;
      };
      if (mono) wrap("code");
      if (strike) wrap("del");
      if (italic) wrap("em");
      if (bold) wrap("strong");
      unwrap(node);
    }
  }

  // Gmail's quoted reply.
  body.querySelectorAll(".gmail_quote").forEach((q) => rename(q, "blockquote"));

  for (const el of Array.from(body.querySelectorAll("*"))) for (const a of STRIP_ATTRS) el.removeAttribute(a);
}

/* ─── DOM → Markdown ───────────────────────────────────────────────── */

const BLOCK_TAGS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "TABLE", "BLOCKQUOTE", "PRE", "HR", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV", "FIGURE", "FIGCAPTION", "DL", "DT", "DD", "ADDRESS", "CENTER"]);

function escapeText(s: string): string {
  return s.replace(/([\\`*_[\]<>]|~~)/g, "\\$1");
}

function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)([#>+-])(?=\s)/, "$1\\$2")
    .replace(/^(\s*)(\d+)([.)])(?=\s)/, "$1$2\\$3");
}

function inline(node: Node): string {
  if (node.nodeType === 3) return escapeText((node.nodeValue ?? "").replace(/[\s\u00A0]+/g, " "));
  if (node.nodeType !== 1) return "";
  const el = node as HTMLElement;
  const kids = () => Array.from(el.childNodes).map(inline).join("");
  const wrapMark = (mark: string) => {
    const inner = kids();
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
    return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
  };
  switch (el.tagName) {
    case "STRONG":
    case "B":
      return wrapMark("**");
    case "EM":
    case "I":
    case "CITE":
      return wrapMark("*");
    case "DEL":
    case "S":
    case "STRIKE":
      return wrapMark("~~");
    case "CODE":
    case "KBD":
    case "SAMP": {
      const t = el.textContent ?? "";
      const fence = t.includes("`") ? "``" : "`";
      return t ? `${fence}${t}${fence}` : "";
    }
    case "A": {
      const href = el.getAttribute("href") ?? "";
      const text = kids().trim();
      if (!href || /^javascript:/i.test(href)) return text;
      if (href.startsWith("#") && !text) return "";
      return `[${text || href}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
    }
    case "IMG": {
      const src = el.getAttribute("src") ?? "";
      if (!src || /^data:/i.test(src) && src.length > 2000) return "";
      return `![${escapeText(el.getAttribute("alt") ?? "")}](${src.replace(/[()\s]/g, encodeURIComponent)})`;
    }
    case "BR":
      return "\\\n";
    case "SUP":
    case "SUB":
    case "U":
    case "MARK":
    case "SMALL":
    case "SPAN":
    case "FONT":
    case "ABBR":
    case "TIME":
    case "LABEL":
    default:
      return kids();
  }
}

function cellText(td: Element): string {
  const parts: string[] = [];
  for (const c of Array.from(td.childNodes)) {
    if (c.nodeType === 1 && BLOCK_TAGS.has((c as Element).tagName)) {
      if ((c as Element).tagName === "UL" || (c as Element).tagName === "OL")
        parts.push(Array.from((c as Element).children).map((li) => "• " + inline(li).trim()).join("<br>"));
      else parts.push(inline(c).trim());
    } else parts.push(inline(c));
  }
  return parts
    .join(" ")
    .replace(/\\\n/g, "<br>")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function table(t: HTMLTableElement): string {
  const rows = Array.from(t.rows);
  if (!rows.length) return "";
  const grid = rows.map((r) => {
    const cells: string[] = [];
    for (const c of Array.from(r.cells)) {
      cells.push(cellText(c));
      for (let k = 1; k < (c.colSpan || 1); k++) cells.push("");
    }
    return cells;
  });
  const width = Math.max(...grid.map((r) => r.length));
  for (const r of grid) while (r.length < width) r.push("");
  const line = (r: string[]) => `| ${r.join(" | ")} |`;
  return [line(grid[0]), line(grid[0].map(() => "---")), ...grid.slice(1).map(line)].join("\n");
}

function blocks(parent: Node, ctx: { listDepth: number }): string[] {
  const out: string[] = [];
  let para = "";
  const flush = () => {
    // A line break at the edge of a block (Gmail's <div><br></div>) means nothing.
    const p = para
      .replace(/[ \t]+\n/g, "\n")
      .replace(/^(?:\s|\\\n)+|(?:\s|\\\n)+$/g, "")
      .replace(/(?<!\\)\\$/, "")
      .trim();
    if (p) out.push(p.split("\n").map(escapeLineStart).join("\n"));
    para = "";
  };
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType !== 1 || !BLOCK_TAGS.has((node as Element).tagName)) {
      para += inline(node);
      continue;
    }
    flush();
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const text = inline(el).replace(/\\\n/g, " ").trim();
      if (text) out.push(`${"#".repeat(Number(tag[1]))} ${text}`);
    } else if (tag === "UL" || tag === "OL") {
      const list = listMd(el, ctx.listDepth);
      if (list) out.push(list);
    } else if (tag === "TABLE") {
      const md = table(el as HTMLTableElement);
      if (md) out.push(md);
    } else if (tag === "BLOCKQUOTE") {
      const inner = blocks(el, ctx).join("\n\n");
      if (inner) out.push(inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
    } else if (tag === "PRE") {
      const code = el.querySelector("code");
      const lang = /language-([\w-]+)/.exec(code?.getAttribute("class") ?? "")?.[1] ?? "";
      const text = (el.textContent ?? "").replace(/\n$/, "");
      const fence = text.includes("```") ? "````" : "```";
      out.push(`${fence}${lang}\n${text}\n${fence}`);
    } else if (tag === "HR") {
      out.push("---");
    } else {
      out.push(...blocks(el, ctx));
    }
  }
  flush();
  return out;
}

function listMd(list: HTMLElement, depth: number): string {
  const ordered = list.tagName === "OL";
  const start = Number(list.getAttribute("start") ?? "1") || 1;
  const lines: string[] = [];
  let n = start;
  for (const li of Array.from(list.children)) {
    if (li.tagName !== "LI") continue;
    const marker = ordered ? `${n++}. ` : "- ";
    const pad = " ".repeat(marker.length);
    const parts = blocks(li, { listDepth: depth + 1 });
    const checkbox = li.querySelector(":scope > input[type=checkbox]");
    // A nested list follows its item's text directly (a blank line would make the list loose).
    const body = parts
      .map((p, i) => (i === 0 ? p : (/^(\d+\. |- )/.test(p) ? "\n" : "\n\n") + p))
      .join("")
      .split("\n");
    if (!body[0] && body.length === 1) continue;
    const task = checkbox ? ((checkbox as HTMLInputElement).checked ? "[x] " : "[ ] ") : "";
    lines.push(marker + task + body[0]);
    for (const l of body.slice(1)) lines.push(l ? pad + l : "");
  }
  return lines.join("\n");
}

export function domToMarkdown(body: HTMLElement): string {
  return blocks(body, { listDepth: 0 }).join("\n\n");
}

/* ─── Entry points ─────────────────────────────────────────────────── */

/** Clipboard HTML to Markdown, cleaned of styles and needless direction marks. */
export function pastedHtmlToMarkdown(html: string): string {
  const doc = parseInertDocument(html, "text/html");
  cleanPastedDom(doc.body);
  return cleanBidiControls(domToMarkdown(doc.body)).replace(/\n{3,}/g, "\n\n").trim();
}

/** The same cleaning, as HTML (the WYSIWYG editor parses it itself). */
export function cleanPastedHtml(html: string): string {
  const doc = parseInertDocument(html, "text/html");
  cleanPastedDom(doc.body);
  const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */);
  while (walker.nextNode()) {
    const n = walker.currentNode;
    n.nodeValue = cleanBidiControls(n.nodeValue ?? "");
  }
  return doc.body.innerHTML;
}

const STRUCTURE = /<(h[1-6]|ul|ol|table|a\s[^>]*href|img\s[^>]*src|strong|b|em|i|blockquote|del|s|pre|code)\b/i;

/**
 * Whether a paste should be converted. Only HTML with structure (or from
 * Word / Google Docs); code editors put styled spans on the clipboard,
 * which must stay the plain text they are.
 */
export function shouldConvertPaste(html: string | undefined, text: string | undefined): boolean {
  if (!html) return false;
  if (/data-vscode|vscode-|<meta[^>]+generator["']?\s*content=["']?(?:Code|Visual Studio)/i.test(html)) return false;
  const office = /urn:schemas-microsoft-com|class="?Mso|docs-internal-guid/i.test(html);
  if (!office && !STRUCTURE.test(html)) return false;
  // A single preformatted block (copied from a code view): the plain text is the content.
  if (/^\s*(?:<meta[^>]*>\s*)?<pre[\s>]/i.test(html) && text) return false;
  return true;
}
