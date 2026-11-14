/**
 * The parts of `lumen publish` that run anywhere, the browser included
 * (plan 4.18): the site stylesheet, link rewriting (`.md` → `.html`,
 * `[[wiki]]` → the published page) and page titles. Used by the CLI
 * (../cli/publish.ts, Node) and by "Publish site" in the app
 * (./site.ts). Moved out of the CLI unchanged.
 */
import { escapeHtml } from "../lib/escapeHtml";
import { slug as headingSlug } from "github-slugger";
import { wikiFragmentId } from "../lib/slug";
import { resolveWikiTarget, splitWikiTarget } from "../renderer/wikiLinks";

export const MD_RE = /\.(md|markdown)$/i;

/** Minimal stylesheet: the app's CSS variables are absent outside Lumen. */
export const PUBLISH_CSS = [
  ":root{--bg:0 0% 100%;--fg:240 10% 12%;--fg-muted:240 5% 45%;--border:240 6% 88%;--accent:252 92% 66%;color-scheme:light dark}",
  "@media (prefers-color-scheme:dark){:root{--bg:240 10% 8%;--fg:240 5% 92%;--fg-muted:240 5% 62%;--border:240 6% 22%}}",
  "*{box-sizing:border-box}",
  "body{font:16px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
  "a{color:hsl(var(--accent))}",
  ".lumen-site-nav{max-width:760px;margin:0 auto 1.5rem;font-size:14px;display:flex;gap:12px;color:hsl(var(--fg-muted))}",
  "h1,h2,h3{line-height:1.25}",
  "img{max-width:100%}",
  "code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}",
  "pre{padding:14px 16px;border-radius:8px;overflow:auto;border:1px solid hsl(var(--border))}",
  ".code-block-header button{display:none}",
  "table{border-collapse:collapse}th,td{border:1px solid hsl(var(--border));padding:6px 10px}",
  "blockquote{margin:0;padding-left:1em;border-left:3px solid hsl(var(--border));color:hsl(var(--fg-muted))}",
  ".lumen-site-pages{list-style:none;padding:0}.lumen-site-pages li{padding:6px 0;border-bottom:1px solid hsl(var(--border))}",
  ".lumen-site-pages small{color:hsl(var(--fg-muted));margin-left:8px}",
].join("\n");

/**
 * Rewrite relative `href="….md(#frag)"` links in rendered HTML to `.html`.
 * `fromOutput` is the linking page's output path (e.g. `docs/a.html`): a
 * link that resolves to the site's root index — any casing, `INDEX.md`,
 * `Index.markdown` — becomes `index.html`, the name publication writes.
 */
export function rewriteMarkdownLinks(html: string, fromOutput = "index.html"): string {
  const fromDir = fromOutput.split("/").slice(0, -1);
  return html.replace(/(\shref=")([^"]*)"/g, (whole, pre: string, href: string) => {
    // Leave absolute URLs (scheme:, //host, /root) and pure fragments alone.
    if (/^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(href)) return whole;
    const m = /^([^?#]*?)\.(md|markdown)((?:[?#].*)?)$/i.exec(href);
    if (!m) return whole;
    let target = `${m[1]}.html`;
    // Resolve against the page's folder to spot the root index.
    const parts = [...fromDir];
    for (const seg of m[1].split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== "." && seg !== "") parts.push(seg);
    }
    if (parts.length === 1 && parts[0].toLowerCase() === "index") {
      target = m[1].replace(/[^/]+$/, "index") + ".html";
    }
    return `${pre}${target}${m[3]}"`;
  });
}

export const unescapeHtml = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/**
 * Point `[[Note]]` / `[[Note#Heading]]` links at the published page of that
 * note. The renderer emits wiki links as in-page anchors (`#note`) for the
 * app, whose click handler opens the note; a static site has no handler.
 * A link whose target is a heading of this page (by its href fragment or
 * the Unicode-aware heading slug) stays an in-page jump, as in the app;
 * an unresolved note is left as is.
 */
export function rewriteWikiLinks(
  html: string,
  fromOutput: string,
  pages: ReadonlyArray<{ source: string; output: string }>,
): string {
  if (!html.includes("data-wiki-target")) return html;
  const ids = new Set<string>();
  for (const m of html.matchAll(/\sid="([^"]*)"/g)) ids.add(unescapeHtml(m[1]));
  const sources = pages.map((p) => p.source);
  const fromDir = fromOutput.split("/").slice(0, -1);
  return html.replace(/<a\b[^>]*\sdata-wiki-target="([^"]*)"[^>]*>/g, (tag, rawTarget: string) => {
    const target = unescapeHtml(rawTarget);
    const href = /\shref="([^"]*)"/.exec(tag)?.[1] ?? "";
    let frag = "";
    try {
      frag = href.startsWith("#") ? decodeURIComponent(href.slice(1)) : "";
    } catch {
      /* why: malformed escape: not one of our ids */
    }
    if ((frag && ids.has(frag)) || ids.has(headingSlug(target))) return tag;
    const { note, heading } = splitWikiTarget(target);
    const source = note ? resolveWikiTarget(note, sources) : null;
    const page = source ? pages.find((p) => p.source === source) : undefined;
    if (!page) return tag;
    const to = page.output.split("/");
    let common = 0;
    while (common < fromDir.length && common < to.length - 1 && fromDir[common] === to[common]) common++;
    const rel = [...Array(fromDir.length - common).fill(".."), ...to.slice(common)].join("/");
    const url = encodePath(rel) + (heading ? `#${encodeURIComponent(wikiFragmentId(heading))}` : "");
    return tag.replace(/\shref="[^"]*"/, ` href="${escapeHtml(url)}"`);
  });
}

/** Page title: frontmatter `title:`, else first H1, else the file name. */
export function pageTitle(md: string, fileName: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const fmTitle = fm && /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm[1]);
  if (fmTitle) return fmTitle[1].trim();
  const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(md.replace(/^---\r?\n[\s\S]*?\r?\n---/, ""));
  if (h1) return h1[1].replace(/[*_`]/g, "").trim();
  return (fileName.split("/").pop() ?? fileName).replace(MD_RE, "");
}

/** Percent-encode each segment of a relative output path for use in an href (`FAQ #1.html` → `FAQ%20%231.html`). */
export function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}
