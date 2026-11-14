/**
 * EPUB 2 / 3 books (plan W1.14): container → package document (OPF) →
 * metadata, spine and table of contents (EPUB 3 nav document, else the
 * EPUB 2 NCX), and each chapter as safe HTML for the reader.
 *
 * Nothing leaves the device and nothing is fetched: images, stylesheets and
 * embedded fonts come out of the book itself as data: URLs (the app's CSP
 * allows data: for images and fonts); any http(s) reference in a chapter or
 * its CSS is dropped. Scripts, forms, iframes and event handlers never reach
 * the page (DOMPurify, then our own URL pass).
 *
 * Needs a DOM (DOMParser); runs in the reader's lazy chunk.
 */
import DOMPurify from "dompurify";
import { normalizeZipPath, readZip, type ZipArchive } from "./zip";

export interface TocEntry {
  label: string;
  /** Book-relative path of the chapter, with its #fragment if any. */
  href: string;
  /** Spine index of the chapter (-1 when the TOC names a file outside the spine). */
  chapter: number;
  children: TocEntry[];
}

export interface SpineItem {
  id: string;
  href: string;
  mediaType: string;
}

export interface EpubBook {
  title: string;
  author: string;
  language: string;
  /** Right-to-left: the spine says so, or the book's language is written RTL. */
  rtl: boolean;
  spine: SpineItem[];
  toc: TocEntry[];
  /** Book-relative path → media type, for every manifest item. */
  media: Map<string, string>;
  zip: ZipArchive;
}

const RTL_LANGS = /^(he|iw|ar|fa|ur|yi|ps|sd|ug|dv|ckb)\b/i;

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i + 1);
}

/** Resolve `href` (percent-encoded, maybe with #fragment) against the file `base`. */
export function resolveHref(base: string, href: string): { path: string; fragment: string } {
  const hash = href.indexOf("#");
  const raw = hash < 0 ? href : href.slice(0, hash);
  const fragment = hash < 0 ? "" : href.slice(hash + 1);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // why: not percent-encoded: the path is used as written
    /* keep as written */
  }
  return { path: raw ? normalizeZipPath(dirOf(base) + decoded) : normalizeZipPath(base), fragment };
}

function xml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    // Many books ship XHTML that isn't well-formed XML: fall back to HTML.
    return new DOMParser().parseFromString(text, "text/html");
  }
  return doc;
}

const byLocal = (root: Document | Element, name: string): Element[] => Array.from(root.getElementsByTagName("*")).filter((e) => e.localName === name);
const firstText = (root: Document | Element, name: string) => byLocal(root, name)[0]?.textContent?.trim() ?? "";

export async function openEpub(bytes: Uint8Array): Promise<EpubBook> {
  const zip = readZip(bytes);
  const container = xml(await zip.text("META-INF/container.xml"));
  const opfPath = normalizeZipPath(byLocal(container, "rootfile")[0]?.getAttribute("full-path") ?? "");
  if (!opfPath) throw new Error("the book has no package document");
  const opf = xml(await zip.text(opfPath));
  const manifest = new Map<string, { href: string; mediaType: string; properties: string }>();
  const media = new Map<string, string>();
  for (const item of byLocal(opf, "item")) {
    const id = item.getAttribute("id") ?? "";
    const href = resolveHref(opfPath, item.getAttribute("href") ?? "").path;
    const mediaType = item.getAttribute("media-type") ?? "";
    manifest.set(id, { href, mediaType, properties: item.getAttribute("properties") ?? "" });
    media.set(href, mediaType);
  }
  const spineEl = byLocal(opf, "spine")[0];
  const spine: SpineItem[] = [];
  for (const ref of byLocal(opf, "itemref")) {
    if (ref.getAttribute("linear") === "no") continue;
    const id = ref.getAttribute("idref") ?? "";
    const m = manifest.get(id);
    if (m) spine.push({ id, href: m.href, mediaType: m.mediaType });
  }
  if (!spine.length) throw new Error("the book has no chapters");
  const language = firstText(opf, "language");
  const ppd = spineEl?.getAttribute("page-progression-direction");
  const book: EpubBook = {
    title: firstText(opf, "title") || "Untitled",
    author: firstText(opf, "creator"),
    language,
    rtl: ppd ? ppd === "rtl" : RTL_LANGS.test(language),
    spine,
    toc: [],
    media,
    zip,
  };
  const chapterOf = (path: string) => spine.findIndex((s) => s.href === path);
  const nav = [...manifest.values()].find((m) => m.properties.split(/\s+/).includes("nav"));
  const ncxId = spineEl?.getAttribute("toc");
  const ncx = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find((m) => m.mediaType === "application/x-dtbncx+xml");
  try {
    if (nav) book.toc = parseNav(xml(await zip.text(nav.href)), nav.href, chapterOf);
    if (!book.toc.length && ncx) book.toc = parseNcx(xml(await zip.text(ncx.href)), ncx.href, chapterOf);
  } catch {
    book.toc = [];
  }
  if (!book.toc.length) book.toc = spine.map((s, i) => ({ label: `${i + 1}`, href: s.href, chapter: i, children: [] }));
  return book;
}

function parseNav(doc: Document, base: string, chapterOf: (p: string) => number): TocEntry[] {
  const navs = byLocal(doc, "nav");
  const toc = navs.find((n) => (n.getAttribute("epub:type") ?? n.getAttributeNS("http://www.idpf.org/2007/ops", "type") ?? "").split(/\s+/).includes("toc")) ?? navs[0];
  const ol = toc ? byLocal(toc, "ol")[0] : undefined;
  const walk = (list: Element): TocEntry[] =>
    Array.from(list.children)
      .filter((li) => li.localName === "li")
      .map((li) => {
        const a = Array.from(li.children).find((c) => c.localName === "a" || c.localName === "span");
        const href = a?.getAttribute("href") ?? "";
        const r = resolveHref(base, href);
        const sub = Array.from(li.children).find((c) => c.localName === "ol");
        return { label: (a?.textContent ?? "").replace(/\s+/g, " ").trim(), href: href ? r.path + (r.fragment ? `#${r.fragment}` : "") : "", chapter: href ? chapterOf(r.path) : -1, children: sub ? walk(sub) : [] };
      })
      .filter((e) => e.label);
  return ol ? walk(ol) : [];
}

function parseNcx(doc: Document, base: string, chapterOf: (p: string) => number): TocEntry[] {
  const navMap = byLocal(doc, "navMap")[0];
  const walk = (parent: Element): TocEntry[] =>
    Array.from(parent.children)
      .filter((c) => c.localName === "navPoint")
      .map((np) => {
        const label = (byLocal(np, "text")[0]?.textContent ?? "").replace(/\s+/g, " ").trim();
        const src = Array.from(np.children).find((c) => c.localName === "content")?.getAttribute("src") ?? "";
        const r = resolveHref(base, src);
        return { label, href: r.path + (r.fragment ? `#${r.fragment}` : ""), chapter: chapterOf(r.path), children: walk(np) };
      })
      .filter((e) => e.label);
  return navMap ? walk(navMap) : [];
}

/* ─── Chapters ────────────────────────────────────────────────────── */

const REMOTE = /^\s*(https?:|\/\/|ftp:|file:|javascript:|vbscript:)/i;
const DATA_TYPES = /^(image\/|font\/|application\/(font|x-font|vnd\.ms-opentype|x-font-ttf|x-font-otf))/;

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A book resource as a data: URL, or null (missing, or not an image / font). */
async function dataUrl(book: EpubBook, path: string, cache: Map<string, string | null>): Promise<string | null> {
  if (cache.has(path)) return cache.get(path) ?? null;
  const type = book.media.get(path) ?? (/\.(woff2?|ttf|otf)$/i.test(path) ? "font/" + path.split(".").pop()!.toLowerCase() : "");
  let url: string | null = null;
  if (DATA_TYPES.test(type) && book.zip.entries.has(path)) url = `data:${type};base64,${base64(await book.zip.read(path))}`;
  cache.set(path, url);
  return url;
}

/** CSS with every url(...) replaced by the book's own data, and remote / @import references removed. */
export async function rewriteCss(css: string, cssPath: string, book: EpubBook, cache = new Map<string, string | null>()): Promise<string> {
  let out = css.replace(/@import[^;]*;/gi, "").replace(/expression\s*\(/gi, "(");
  const urls = [...out.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)];
  for (const m of urls) {
    const ref = m[2].trim();
    let replacement = "none";
    if (!REMOTE.test(ref) && !ref.startsWith("data:")) {
      const u = await dataUrl(book, resolveHref(cssPath, ref).path, cache);
      if (u) replacement = `url("${u}")`;
    } else if (ref.startsWith("data:")) replacement = m[0];
    out = out.replace(m[0], replacement);
  }
  return out;
}

export interface Chapter {
  index: number;
  /** Sanitized body HTML; links to other chapters carry data-epub-href. */
  html: string;
  /** The chapter's stylesheets, rewritten (to be scoped by the caller). */
  css: string[];
  /** The chapter's own text direction / language, if it declares one. */
  dir: string | null;
  lang: string | null;
}

export async function loadChapter(book: EpubBook, index: number): Promise<Chapter> {
  const item = book.spine[index];
  if (!item) throw new Error(`no chapter ${index + 1}`);
  const doc = xml(await book.zip.text(item.href));
  const cache = new Map<string, string | null>();
  const css: string[] = [];
  for (const link of Array.from(doc.querySelectorAll("link[rel~='stylesheet'][href]"))) {
    const href = link.getAttribute("href") ?? "";
    if (REMOTE.test(href)) continue;
    const path = resolveHref(item.href, href).path;
    if (book.zip.entries.has(path)) css.push(await rewriteCss(await book.zip.text(path), path, book, cache));
  }
  for (const style of Array.from(doc.querySelectorAll("style"))) css.push(await rewriteCss(style.textContent ?? "", item.href, book, cache));
  const body = doc.querySelector("body") ?? doc.documentElement;
  const clean = DOMPurify.sanitize(body.innerHTML, { FORBID_TAGS: ["script", "style", "link", "iframe", "object", "embed", "form", "input", "button", "base", "meta"], FORBID_ATTR: ["srcset"], RETURN_DOM: true }) as HTMLElement;
  // Our URL pass: book resources inline, chapter links internal, everything remote gone.
  for (const el of Array.from(clean.querySelectorAll("[src], [href], image, [poster]"))) {
    for (const attr of ["src", "href", "xlink:href", "poster"]) {
      const v = el.getAttribute(attr);
      if (v === null) continue;
      if (attr === "href" && el.localName === "a") {
        if (REMOTE.test(v)) {
          el.setAttribute("data-external", v.replace(/^\s+/, ""));
          el.removeAttribute("href");
        } else if (!v.startsWith("#")) {
          const r = resolveHref(item.href, v);
          el.setAttribute("data-epub-href", r.path + (r.fragment ? `#${r.fragment}` : ""));
          el.removeAttribute("href");
        }
        continue;
      }
      if (!v.startsWith("data:")) {
        const u = REMOTE.test(v) ? null : await dataUrl(book, resolveHref(item.href, v).path, cache);
        if (u) el.setAttribute(attr, u);
        else if (el.localName === "img") {
          el.remove(); // a remote (or missing) picture: nothing to show, nothing to fetch
          break;
        } else el.removeAttribute(attr);
      }
    }
  }
  for (const el of Array.from(clean.querySelectorAll("[style]"))) {
    const st = el.getAttribute("style") ?? "";
    if (/url\(/i.test(st)) el.setAttribute("style", await rewriteCss(st, item.href, book, cache));
  }
  const dir = (body.getAttribute("dir") ?? doc.documentElement.getAttribute("dir")) || null;
  const lang = (body.getAttribute("lang") ?? doc.documentElement.getAttribute("xml:lang") ?? doc.documentElement.getAttribute("lang")) || null;
  return { index, html: clean.innerHTML, css, dir, lang };
}

/**
 * Scope a book stylesheet to `scope` (the chapter element): every selector
 * is prefixed, html / body / :root become the scope itself, @media and
 * @supports blocks are scoped inside, @font-face and @keyframes are kept,
 * @page / @namespace dropped. Comments are removed first.
 */
export function scopeCss(css: string, scope: string): string {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "";
  let i = 0;
  const block = (from: number): number => {
    // index just after the } that closes the { at `from`
    let depth = 0;
    for (let j = from; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) return j + 1;
    }
    return src.length;
  };
  const prefix = (selectors: string) =>
    selectors
      .split(",")
      .map((sel) => sel.trim())
      .filter(Boolean)
      .map((sel) => {
        const rest = sel.replace(/^(:root|html|body)(\s+(html|body))?(?=$|[\s.:#[>+~])/i, "");
        return rest === sel ? `${scope} ${sel}` : `${scope}${rest}`;
      })
      .join(", ");
  while (i < src.length) {
    const open = src.indexOf("{", i);
    const semi = src.indexOf(";", i);
    if (open < 0) break;
    const head = src.slice(i, open).trim();
    if (head.startsWith("@") && semi >= 0 && semi < open) {
      i = semi + 1; // @charset / @namespace / @import: dropped
      continue;
    }
    const end = block(open);
    const body = src.slice(open + 1, end - 1);
    if (/^@(media|supports)/i.test(head)) out += `${head}{${scopeCss(body, scope)}}\n`;
    else if (/^@(font-face|-webkit-keyframes|keyframes)/i.test(head)) out += `${head}{${body}}\n`;
    else if (!head.startsWith("@") && head) out += `${prefix(head)}{${body}}\n`;
    i = end;
  }
  return out;
}
