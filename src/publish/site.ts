/**
 * Publish to your own static site (plan 4.18): the notes the user picked,
 * rendered with the editor's own pipeline, as a self-contained website —
 * a page per note, a navigation tree on every page, client-side search, and
 * right-to-left layout for Hebrew and Arabic. The files are then deployed
 * by ./deploy.ts (GitHub Pages, or a .zip for any static host).
 *
 * Nothing here touches the network or the vault: the caller passes the notes
 * and a reader for the files they reference, and gets the site's files back.
 * The renderer is passed in too (renderHtmlDocument in the app), so this
 * module stays testable without React.
 *
 * Links: `.md` links and `[[wiki links]]` point at the published pages
 * (./siteLinks.ts, shared with `lumen publish`). A link to a note that was
 * not picked keeps its text and loses its href, so the site neither 404s
 * nor reveals where an unpublished note lives.
 */

import type { HtmlDocumentOptions } from "../storage/exportHtml";
import { escapeHtml } from "../lib/escapeHtml";
import { MD_RE, PUBLISH_CSS, encodePath, pageTitle, rewriteMarkdownLinks, rewriteWikiLinks } from "./siteLinks";
import { linkTags, wellKnownFile } from "./standardSite";

export interface SiteNote {
  /** Vault-relative path, POSIX separators (`Projects/Plan.md`). */
  path: string;
  content: string;
}

export interface SiteFile {
  /** Path inside the site (`Projects/Plan.html`). */
  path: string;
  data: string | Uint8Array;
}

export interface SitePage {
  source: string;
  output: string;
  title: string;
}

export interface SiteOptions {
  title: string;
  /** Language of the site's own words (navigation, search); "he" / "ar" make the chrome right-to-left. */
  lang: string;
  /** The renderer: Markdown → a full HTML document (renderHtmlDocument in the app). */
  render: (markdown: string, opts: HtmlDocumentOptions) => Promise<string>;
  /** Reads a file a page references (an image), relative to the vault; null when missing. */
  readAsset?: (path: string) => Promise<Uint8Array | null>;
  /** Navigation and search words, in `lang`. */
  words?: Partial<SiteWords>;
  /**
   * Standard.site verification (plan W7.19): the publication's at:// URI is
   * served at /.well-known/site.standard.publication, and each page links its
   * publication and, when published, its document record (by note path).
   */
  standardSite?: { publication: string; documents?: Readonly<Record<string, string>> };
}

export interface SiteWords {
  home: string;
  search: string;
  noResults: string;
  pages: string;
  notFound: string;
}

const ENGLISH: SiteWords = { home: "Home", search: "Search", noResults: "No results", pages: "Pages", notFound: "This page does not exist." };
const HEBREW: SiteWords = { home: "דף הבית", search: "חיפוש", noResults: "אין תוצאות", pages: "דפים", notFound: "הדף הזה לא קיים." };

export function wordsFor(lang: string): SiteWords {
  return lang === "he" ? HEBREW : ENGLISH;
}

const RTL_LANGS = new Set(["he", "ar", "fa", "ur", "yi"]);
export const isRtlLang = (lang: string): boolean => RTL_LANGS.has(lang.split("-")[0]);

/** The site's search data: one entry per page, plain text (Markdown syntax removed). */
export interface SearchEntry {
  /** Page path inside the site. */
  p: string;
  /** Title. */
  t: string;
  /** Text. */
  x: string;
}

/** Markdown → the words a reader searches for (no syntax, no frontmatter, no URLs). */
export function plainText(md: string): string {
  return md
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, note: string, alias?: string) => alias ?? note)
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~`|]/g, "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Output path of a note: `.md` → `.html`, the root index always `index.html`. */
export function outputOf(path: string): string {
  const out = path.replace(MD_RE, ".html");
  return out.toLowerCase() === "index.html" ? "index.html" : out;
}

const up = (output: string) => "../".repeat(output.split("/").length - 1);

/** Relative href from one site page to another. */
export function hrefBetween(fromOutput: string, toOutput: string): string {
  const from = fromOutput.split("/").slice(0, -1);
  const to = toOutput.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return encodePath([...Array(from.length - common).fill(".."), ...to.slice(common)].join("/"));
}

/** Resolve a relative path against a folder (`a/b` + `../c.png` → `a/c.png`); null when it leaves the root. */
export function resolveRelative(dir: string, rel: string): string | null {
  const parts = dir ? dir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Links in a page to `.html` pages the site does not have (notes that were
 * not picked) keep their text and lose the link.
 */
export function unlinkMissingPages(html: string, fromOutput: string, outputs: ReadonlySet<string>): string {
  const dir = fromOutput.split("/").slice(0, -1).join("/");
  return html.replace(/<a\b([^>]*?)\shref="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g, (whole, pre: string, href: string, post: string, inner: string) => {
    if (/^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(href)) return whole;
    const m = /^([^?#]*\.html)(?:[?#].*)?$/i.exec(href);
    if (!m) return whole;
    let path: string;
    try {
      path = decodeURIComponent(m[1]);
    } catch {
      return whole;
    }
    const target = resolveRelative(dir, path);
    if (target !== null && outputs.has(target)) return whole;
    return `<span class="lumen-site-unpublished"${pre}${post}>${inner}</span>`;
  });
}

/** Local files (`src="…"`) a rendered page references, as vault paths. */
export function referencedFiles(html: string, noteDir: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/\s(?:src|href)="([^"#?]+)[^"]*"/g)) {
    const ref = m[1];
    if (/^([a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(ref) || /\.(html?|md|markdown)$/i.test(ref)) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(ref);
    } catch {
      continue;
    }
    const path = resolveRelative(noteDir, decoded);
    if (path) out.add(path);
  }
  return [...out];
}

/** The navigation tree: folders as collapsible groups, the current page marked. */
function navTree(pages: SitePage[], current: string, words: SiteWords): string {
  type Dir = { name: string; dirs: Map<string, Dir>; pages: SitePage[] };
  const root: Dir = { name: "", dirs: new Map(), pages: [] };
  for (const p of pages) {
    const parts = p.output.split("/");
    let d = root;
    for (const seg of parts.slice(0, -1)) {
      if (!d.dirs.has(seg)) d.dirs.set(seg, { name: seg, dirs: new Map(), pages: [] });
      d = d.dirs.get(seg)!;
    }
    d.pages.push(p);
  }
  const holds = (d: Dir): boolean => d.pages.some((p) => p.output === current) || [...d.dirs.values()].some(holds);
  const render = (d: Dir): string => {
    const dirs = [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    const items = [
      ...dirs.map((sub) => `<li><details${holds(sub) ? " open" : ""}><summary>${escapeHtml(sub.name)}</summary>${render(sub)}</details></li>`),
      ...d.pages
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((p) => `<li><a href="${escapeHtml(hrefBetween(current, p.output))}"${p.output === current ? ' aria-current="page"' : ""}>${escapeHtml(p.title)}</a></li>`),
    ];
    return `<ul>${items.join("")}</ul>`;
  };
  return `<nav class="lumen-site-tree" aria-label="${escapeHtml(words.pages)}">${render(root)}</nav>`;
}

/** The bar on top of every page: home link and search. */
function siteBar(title: string, current: string, words: SiteWords, dir: "ltr" | "rtl", lang: string): string {
  const prefix = up(current);
  return (
    `<header class="lumen-site-bar" dir="${dir}" lang="${escapeHtml(lang)}">` +
    `<a class="lumen-site-home" href="${prefix}index.html">${escapeHtml(title)}</a>` +
    `<div class="lumen-site-search" role="search"><input type="search" id="lumen-site-q" placeholder="${escapeHtml(words.search)}" aria-label="${escapeHtml(words.search)}" autocomplete="off" />` +
    `<ul id="lumen-site-results" hidden data-empty="${escapeHtml(words.noResults)}"></ul></div>` +
    `</header>`
  );
}

export const SITE_CSS = [
  PUBLISH_CSS,
  ".lumen-site-bar{display:flex;gap:16px;align-items:center;max-width:1100px;margin:0 auto 1.5rem;padding:0 0 12px;border-bottom:1px solid hsl(var(--border))}",
  ".lumen-site-home{font-weight:600;text-decoration:none;color:hsl(var(--fg))}",
  ".lumen-site-search{position:relative;margin-inline-start:auto}",
  "#lumen-site-q{font:inherit;font-size:14px;padding:6px 10px;border-radius:6px;border:1px solid hsl(var(--border));background:hsl(var(--bg));color:hsl(var(--fg));width:min(260px,50vw)}",
  "#lumen-site-results{position:absolute;inset-inline-end:0;top:110%;z-index:10;list-style:none;margin:0;padding:6px;min-width:280px;max-height:60vh;overflow:auto;background:hsl(var(--bg));border:1px solid hsl(var(--border));border-radius:8px;box-shadow:0 6px 24px rgb(0 0 0/.12)}",
  "#lumen-site-results li{padding:6px 8px}#lumen-site-results small{display:block;color:hsl(var(--fg-muted))}",
  ".lumen-site-layout{display:flex;gap:2rem;max-width:1100px;margin:0 auto;align-items:flex-start}",
  ".lumen-site-tree{flex:0 0 220px;font-size:14px;position:sticky;top:1rem;max-height:90vh;overflow:auto}",
  ".lumen-site-tree ul{list-style:none;margin:0;padding-inline-start:12px}.lumen-site-tree>ul{padding-inline-start:0}",
  ".lumen-site-tree li{padding:3px 0}.lumen-site-tree a{text-decoration:none}.lumen-site-tree a[aria-current]{font-weight:600;color:hsl(var(--fg))}",
  ".lumen-site-layout .lumen-export{flex:1;min-width:0;margin:0}",
  ".lumen-site-unpublished{color:hsl(var(--fg-muted))}",
  "@media (max-width:760px){.lumen-site-layout{display:block}.lumen-site-tree{position:static;max-height:none;margin-bottom:1rem}}",
].join("\n");

/**
 * Client-side search: reads search-index.json once, matches every word of
 * the query (case- and niqqud-insensitive) against title and text. No
 * dependencies, no requests beyond the site's own index.
 */
export const SEARCH_JS = `(() => {
  const q = document.getElementById("lumen-site-q"), list = document.getElementById("lumen-site-results");
  if (!q || !list) return;
  const root = document.querySelector('meta[name="lumen-site-root"]')?.getAttribute("content") || "";
  const norm = (s) => s.normalize("NFKD").replace(/[\\u0300-\\u036f\\u0591-\\u05c7]/g, "").toLowerCase();
  let data = null;
  const load = () => data || (data = fetch(root + "search-index.json").then((r) => r.json()).then((d) => d.map((e) => ({ ...e, n: norm(e.t + " " + e.x) }))));
  const show = async () => {
    const words = norm(q.value).split(/\\s+/).filter(Boolean);
    list.textContent = "";
    if (!words.length) { list.hidden = true; return; }
    const hits = (await load()).filter((e) => words.every((w) => e.n.includes(w))).slice(0, 20);
    if (!hits.length) { const li = document.createElement("li"); li.textContent = list.dataset.empty || ""; list.append(li); }
    for (const h of hits) {
      const li = document.createElement("li"), a = document.createElement("a"), small = document.createElement("small");
      a.href = root + h.p.split("/").map(encodeURIComponent).join("/");
      a.textContent = h.t;
      const at = norm(h.x).indexOf(words[0]);
      small.textContent = h.x.slice(Math.max(0, at - 40), at + 80);
      li.append(a, small);
      list.append(li);
    }
    list.hidden = false;
  };
  q.addEventListener("input", () => void show());
  q.addEventListener("keydown", (e) => { if (e.key === "Escape") { q.value = ""; void show(); } });
})();
`;

export interface SiteResult {
  files: SiteFile[];
  pages: SitePage[];
  /** Files a page references that could not be read (they are left as links). */
  missing: string[];
}

/** Build the site from the picked notes. */
export async function buildSite(notes: readonly SiteNote[], opts: SiteOptions): Promise<SiteResult> {
  const words = { ...wordsFor(opts.lang), ...opts.words };
  const chromeDir: "ltr" | "rtl" = isRtlLang(opts.lang) ? "rtl" : "ltr";
  const seen = new Set<string>();
  const pages: (SitePage & { md: string })[] = [];
  for (const n of [...notes].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!MD_RE.test(n.path)) continue;
    const output = outputOf(n.path);
    if (seen.has(output.toLowerCase())) continue;
    seen.add(output.toLowerCase());
    pages.push({ source: n.path, output, title: pageTitle(n.content, n.path), md: n.content });
  }
  const outputs = new Set(pages.map((p) => p.output));
  const hasIndex = outputs.has("index.html");
  const navPages: SitePage[] = pages.map(({ source, output, title }) => ({ source, output, title }));

  const files: SiteFile[] = [];
  const assets = new Map<string, Uint8Array>();
  const missing = new Set<string>();

  const pageShell = async (md: string, output: string, title: string, extra = "", source?: string): Promise<string> => {
    const prefix = up(output);
    const std = opts.standardSite ? linkTags(opts.standardSite.publication, source ? opts.standardSite.documents?.[source] : undefined) : "";
    let html = await opts.render(md, {
      title,
      head: `\n<link rel="stylesheet" href="${prefix}style.css" />\n<meta name="lumen-site-root" content="${prefix}" />\n<script src="${prefix}search.js" defer></script>${std}`,
      before: `${siteBar(opts.title, output, words, chromeDir, opts.lang)}\n<div class="lumen-site-layout" dir="${chromeDir}">${navTree(navPages, output, words)}`,
    });
    // The layout takes the site's direction (sidebar side); the page keeps its own, as the renderer set it on <html>.
    const pageDir = /<html\b[^>]*\sdir="(ltr|rtl)"/.exec(html)?.[1] ?? "ltr";
    html = html.replace(/<main\b(?![^>]*\sdir=)/, `<main dir="${pageDir}"`);
    // Close the layout after the page body.
    const at = html.lastIndexOf("</body>");
    html = at < 0 ? `${html}${extra}</div>` : `${html.slice(0, at)}${extra}</div>\n${html.slice(at)}`;
    return html;
  };

  for (const p of pages) {
    let html = await pageShell(p.md, p.output, p.output === "index.html" ? opts.title : `${p.title} — ${opts.title}`, "", p.source);
    html = rewriteMarkdownLinks(html, p.output);
    html = rewriteWikiLinks(html, p.output, pages);
    html = unlinkMissingPages(html, p.output, outputs);
    if (opts.readAsset) {
      const dir = p.source.split("/").slice(0, -1).join("/");
      // Only the note's own body: the site's stylesheet and script are not vault files.
      const body = /<main\b[\s\S]*<\/main>/.exec(html)?.[0] ?? "";
      for (const ref of referencedFiles(body, dir)) {
        if (assets.has(ref) || missing.has(ref) || outputs.has(ref)) continue;
        const data = await opts.readAsset(ref);
        if (data) assets.set(ref, data);
        else missing.add(ref);
      }
    }
    files.push({ path: p.output, data: html });
  }

  if (!hasIndex) {
    const list = navPages
      .slice()
      .sort((a, b) => a.output.localeCompare(b.output))
      .map((p) => `- [${p.title.replace(/[[\]\\]/g, "\\$&")}](${encodePath(p.output)})`)
      .join("\n");
    const html = await pageShell(`# ${opts.title}\n\n${list}\n`, "index.html", opts.title);
    files.push({ path: "index.html", data: html.replace(/<html\b[^>]*>/, `<html lang="${escapeHtml(opts.lang)}" dir="${chromeDir}">`) });
  }
  files.push({ path: "404.html", data: await pageShell(`# ${words.notFound}\n\n[${words.home}](index.html)\n`, "404.html", `${words.notFound} — ${opts.title}`) });
  files.push({ path: "style.css", data: SITE_CSS });
  files.push({ path: "search.js", data: SEARCH_JS });
  const index: SearchEntry[] = pages.map((p) => ({ p: p.output, t: p.title, x: plainText(p.md) }));
  files.push({ path: "search-index.json", data: JSON.stringify(index) });
  // GitHub Pages: serve files as they are (no Jekyll, which hides _folders).
  files.push({ path: ".nojekyll", data: "" });
  if (opts.standardSite) {
    const w = wellKnownFile(opts.standardSite.publication);
    files.push({ path: w.path, data: w.data });
  }
  for (const [path, data] of assets) if (!files.some((f) => f.path === path)) files.push({ path, data });

  return { files, pages: navPages, missing: [...missing].sort() };
}
