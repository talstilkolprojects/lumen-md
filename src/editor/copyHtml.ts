/**
 * Copy from the source editor as formatted text too (plan W7.3, Obsidian
 * 1.12): the clipboard gets the Markdown as text/plain and an HTML rendering
 * as text/html, so a paste into Word or Google Docs keeps headings, bold,
 * italics, lists, links and the direction of each paragraph (`dir="rtl"` on
 * Hebrew ones).
 *
 * Synchronous on purpose: a copy event's clipboardData is only writable
 * while the event runs. It covers what a paste target can show; anything
 * else stays as its text.
 */

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c]);

/** The first strong character decides, as the Unicode bidi algorithm's paragraph level does. */
export function directionOf(text: string): "rtl" | "ltr" {
  const m = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]|[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.exec(text);
  return m && /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(m[0]) ? "rtl" : "ltr";
}

function safeHref(href: string): string | null {
  const h = href.trim();
  return /^(https?:|mailto:|#|\.{0,2}\/|[^:]*$)/i.test(h) ? h : null;
}

/** Inline Markdown → HTML: code, bold, italics, strike, highlight, links, wiki-links. */
export function inlineHtml(text: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`\n]+)`/g, (_m, c: string) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (_m, target: string) => `[${target}]`);
  s = s.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, target: string, label?: string) => label ?? target);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt: string) => alt.replace(/\|\d+(?:x\d+)?$/, ""));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, label: string, href: string) => {
    const h = safeHref(href.replace(/&amp;/g, "&"));
    return h ? `<a href="${esc(h)}">${label}</a>` : label;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_m, a?: string, b?: string) => `<strong>${a ?? b}</strong>`);
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)|(^|[^_\w])_([^_\n]+)_(?![_\w])/g, (_m, p1?: string, a?: string, p2?: string, b?: string) => `${p1 ?? p2 ?? ""}<em>${a ?? b}</em>`);
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  s = s.replace(/==([^=\n]+)==/g, "<mark>$1</mark>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

const dirAttr = (text: string) => (directionOf(text) === "rtl" ? ' dir="rtl"' : ' dir="ltr"');

interface ListFrame {
  tag: "ul" | "ol";
  indent: number;
}

/** A Markdown selection → an HTML fragment for the clipboard. */
export function markdownToClipboardHtml(md: string): string {
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  const lists: ListFrame[] = [];
  let para: string[] = [];
  const closeLists = (toIndent = -1) => {
    while (lists.length && lists[lists.length - 1].indent > toIndent) out.push(`</li></${lists.pop()!.tag}>`);
  };
  const flush = () => {
    if (!para.length) return;
    const text = para.join(" ");
    out.push(`<p${dirAttr(text)}>${inlineHtml(text)}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      flush();
      closeLists();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) code.push(lines[i]);
      out.push(`<pre dir="ltr"><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      closeLists();
      const n = h[1].length;
      out.push(`<h${n}${dirAttr(h[2])}>${inlineHtml(h[2])}</h${n}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      closeLists();
      out.push("<hr>");
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flush();
      closeLists();
      const quoted = [q[1]];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1])) quoted.push(lines[++i].replace(/^\s*>\s?/, ""));
      const text = quoted.join(" ").replace(/^\[![^\]]+\][+-]?\s*/, "");
      out.push(`<blockquote${dirAttr(text)}>${inlineHtml(text)}</blockquote>`);
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    if (li) {
      flush();
      const indent = li[1].replace(/\t/g, "    ").length;
      const tag = /\d/.test(li[2]) ? "ol" : "ul";
      const top = lists[lists.length - 1];
      if (top && top.indent > indent) closeLists(indent);
      const cur = lists[lists.length - 1];
      if (cur && cur.indent === indent && cur.tag !== tag) closeLists(indent - 1);
      const same = lists[lists.length - 1];
      const box = li[3] ? (li[3] === " " ? "☐ " : "☑ ") : "";
      if (same && same.indent === indent) out.push("</li>");
      else {
        lists.push({ tag, indent });
        out.push(`<${tag}${dirAttr(li[4])}>`);
      }
      out.push(`<li${dirAttr(li[4])}>${box}${inlineHtml(li[4])}`);
      continue;
    }
    if (lists.length) closeLists();
    para.push(line.trim());
  }
  flush();
  closeLists();
  const html = out.join("");
  return `<div${dirAttr(body)}>${html}</div>`;
}
