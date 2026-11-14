/**
 * A book as an EPUB 3 (plan W5.8): one XHTML file per chapter, a navigation
 * document that is the table of contents, a title page, the book's font
 * embedded, and for a Hebrew book `page-progression-direction="rtl"` plus
 * `dir="rtl"` / `lang="he"` on every document, so Apple Books, Kindle and
 * Thorium open it from the right. Checked with epubcheck 5.3 (0 errors).
 *
 * Chapters arrive as rendered HTML (the app's own Markdown renderer); this
 * file makes them valid XHTML for an EPUB: scripts, frames and form
 * controls go, links that point inside the vault become plain text, and
 * images come from `assets` or are replaced by their alt text.
 */
import { zip, type ZipInput } from "../storage/zip";

export interface EpubChapter {
  title: string;
  /** Rendered HTML of the chapter's body. */
  html: string;
  lang: string;
  dir: "rtl" | "ltr";
}

export interface EpubFont {
  family: string;
  /** woff2 bytes, one file per weight/style. */
  files: Array<{ bytes: Uint8Array; weight: number; style?: "normal" | "italic" }>;
}

export interface EpubBook {
  title: string;
  author?: string;
  lang: string;
  dir: "rtl" | "ltr";
  /** urn:uuid:… — the same id across exports keeps a reader's place and highlights. */
  identifier: string;
  modified: Date;
  chapters: EpubChapter[];
  font?: EpubFont;
  /** Image bytes by the src written in the chapter HTML (vault path or URL). */
  assets?: (src: string) => Promise<{ bytes: Uint8Array; mediaType: string } | null>;
  /** Localised labels. */
  labels: { contents: string; titlePage: string };
}

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

export const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** EPUB's dcterms:modified: UTC, to the second, with a Z. */
export const epubDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** The media type of an image by its file name (null: not a core EPUB image type). */
export function imageMediaType(name: string): string | null {
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  return IMAGE_TYPES[ext] ?? null;
}

const DROP = "script,style,iframe,object,embed,form,button,select,textarea,noscript,template,canvas,video,audio";

/**
 * Chapter HTML → the children of an XHTML `<body>`: valid XML, nothing an
 * EPUB may not contain. Images are collected for the manifest.
 */
export async function chapterXhtml(
  html: string,
  images: Map<string, { href: string; bytes: Uint8Array; mediaType: string }>,
  assets: EpubBook["assets"],
): Promise<string> {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html");
  const body = doc.body;
  body.querySelectorAll(DROP).forEach((el) => el.remove());
  // Task-list checkboxes read as marks.
  body.querySelectorAll("input").forEach((el) => el.replaceWith(doc.createTextNode((el as HTMLInputElement).checked || el.hasAttribute("checked") ? "☑ " : "☐ ")));
  for (const el of Array.from(body.querySelectorAll("*"))) {
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name) || a.name === "contenteditable" || a.name === "draggable" || a.name === "style" || a.name.includes(":")) el.removeAttribute(a.name);
    }
    // XML ids: no duplicates, no leading digit.
    if (el.id && !/^[\p{L}_]/u.test(el.id)) el.id = `x-${el.id}`;
  }
  // Code reads left to right: an attribute, since EPUB style sheets may not set `direction`.
  body.querySelectorAll("pre, code").forEach((el) => el.hasAttribute("dir") || el.setAttribute("dir", "ltr"));
  const ids = new Set(Array.from(body.querySelectorAll("[id]")).map((el) => el.id));
  // Links: the web, mail and in-chapter anchors stay; links into the vault become text.
  for (const a of Array.from(body.querySelectorAll("a"))) {
    const href = a.getAttribute("href") ?? "";
    if (/^(https?:|mailto:)/i.test(href)) continue;
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      const fixed = /^[\p{L}_]/u.test(id) ? id : `x-${id}`;
      if (ids.has(fixed)) {
        a.setAttribute("href", `#${fixed}`);
        continue;
      }
    }
    const span = doc.createElement("span");
    span.append(...Array.from(a.childNodes));
    a.replaceWith(span);
  }
  // Images: embedded when the vault has them, otherwise their alt text.
  for (const img of Array.from(body.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    let entry = images.get(src);
    if (!entry && assets && !/^data:/i.test(src)) {
      const found = await assets(src).catch(() => null);
      const mediaType = found?.mediaType ?? imageMediaType(src);
      if (found && mediaType && Object.values(IMAGE_TYPES).includes(mediaType)) {
        const ext = Object.entries(IMAGE_TYPES).find(([, t]) => t === mediaType)?.[0] ?? "img";
        entry = { href: `images/img${images.size + 1}.${ext}`, bytes: found.bytes, mediaType };
        images.set(src, entry);
      }
    }
    if (entry) {
      for (const a of Array.from(img.attributes)) if (!["alt", "width", "height", "title"].includes(a.name)) img.removeAttribute(a.name);
      img.setAttribute("src", entry.href);
      if (!img.hasAttribute("alt")) img.setAttribute("alt", "");
    } else {
      img.replaceWith(doc.createTextNode(img.getAttribute("alt") ?? ""));
    }
  }
  const out = document.implementation.createDocument(XHTML_NS, "div", null);
  const root = out.documentElement;
  for (const n of Array.from(body.childNodes)) root.appendChild(out.importNode(n, true));
  const xml = new XMLSerializer().serializeToString(root);
  // Strip the wrapper: `<div xmlns="…">…</div>` → its children (they inherit the namespace from <body>).
  return xml.replace(/^<div xmlns="http:\/\/www\.w3\.org\/1999\/xhtml">/, "").replace(/<\/div>$/, "").replace(/^<div xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"\/>$/, "");
}

function page(lang: string, dir: string, title: string, body: string, bodyClass = ""): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n` +
    `<html xmlns="${XHTML_NS}" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}" dir="${dir}">\n` +
    `<head><meta charset="utf-8"/><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="book.css"/></head>\n` +
    `<body${bodyClass ? ` class="${bodyClass}"` : ""}>\n${body}\n</body>\n</html>\n`
  );
}

/** The stylesheet: the book font, chapters on a new page, readable defaults. */
export function bookCss(book: Pick<EpubBook, "font" | "dir">, fontHref: (i: number) => string): string {
  const faces = (book.font?.files ?? [])
    .map((f, i) => `@font-face { font-family: "${book.font!.family}"; src: url("${fontHref(i)}") format("woff2"); font-weight: ${f.weight}; font-style: ${f.style ?? "normal"}; }`)
    .join("\n");
  const family = book.font ? `"${book.font.family}", ` : "";
  return `${faces}
body { font-family: ${family}"Frank Ruhl Libre", "David Libre", "Noto Serif Hebrew", serif; line-height: 1.6; text-align: justify; hyphens: none; }
h1, h2, h3 { text-align: start; line-height: 1.25; page-break-after: avoid; break-after: avoid; }
h1.chapter-title { margin-top: 2em; margin-bottom: 1.5em; }
p { margin: 0; text-indent: 1.5em; }
h1 + p, h2 + p, h3 + p, blockquote p, li p, .first { text-indent: 0; }
blockquote { margin: 1em 1.5em; }
img { max-width: 100%; }
pre, code { font-family: monospace; }
pre { white-space: pre-wrap; text-align: left; }
.title-page { text-align: center; }
.title-page h1 { margin-top: 30%; font-size: 2em; }
.title-page .author { font-size: 1.3em; margin-top: 1em; }
nav ol { list-style: none; padding: 0; }
`;
}

/** The EPUB file's bytes. */
export async function buildEpub(book: EpubBook): Promise<Uint8Array> {
  const images = new Map<string, { href: string; bytes: Uint8Array; mediaType: string }>();
  const chapters: Array<{ id: string; href: string; title: string; xhtml: string }> = [];
  for (const [i, ch] of book.chapters.entries()) {
    const body = await chapterXhtml(ch.html, images, book.assets);
    const id = `ch${String(i + 1).padStart(3, "0")}`;
    const section = `<section epub:type="chapter" role="doc-chapter" aria-labelledby="${id}-title">\n<h1 class="chapter-title" id="${id}-title">${escapeXml(ch.title)}</h1>\n${body}\n</section>`;
    chapters.push({ id, href: `${id}.xhtml`, title: ch.title, xhtml: page(ch.lang, ch.dir, ch.title, section) });
  }
  const fontFiles = (book.font?.files ?? []).map((f, i) => ({ id: `font${i + 1}`, href: `fonts/font${i + 1}.woff2`, bytes: f.bytes }));
  const css = bookCss(book, (i) => fontFiles[i].href);
  const title = escapeXml(book.title);
  const titlePage = page(
    book.lang,
    book.dir,
    book.title,
    `<section epub:type="titlepage" class="title-page"><h1>${title}</h1>${book.author ? `<p class="author">${escapeXml(book.author)}</p>` : ""}</section>`,
  );
  const nav = page(
    book.lang,
    book.dir,
    book.labels.contents,
    `<nav epub:type="toc" id="toc" role="doc-toc"><h1>${escapeXml(book.labels.contents)}</h1>\n<ol>\n${chapters.map((c) => `<li><a href="${c.href}">${escapeXml(c.title)}</a></li>`).join("\n")}\n</ol></nav>\n` +
      `<nav epub:type="landmarks" id="landmarks" hidden="hidden"><ol><li><a epub:type="titlepage" href="title.xhtml">${escapeXml(book.labels.titlePage)}</a></li><li><a epub:type="toc" href="nav.xhtml">${escapeXml(book.labels.contents)}</a></li>${chapters.length ? `<li><a epub:type="bodymatter" href="${chapters[0].href}">${escapeXml(chapters[0].title)}</a></li>` : ""}</ol></nav>`,
  );
  const imageItems = [...images.values()];
  const opf =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${book.lang}" dir="${book.dir}">\n` +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n` +
    `<dc:identifier id="bookid">${escapeXml(book.identifier)}</dc:identifier>\n<dc:title>${title}</dc:title>\n<dc:language>${book.lang}</dc:language>\n` +
    (book.author ? `<dc:creator>${escapeXml(book.author)}</dc:creator>\n` : "") +
    `<meta property="dcterms:modified">${epubDate(book.modified)}</meta>\n</metadata>\n<manifest>\n` +
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n` +
    `<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>\n` +
    `<item id="css" href="book.css" media-type="text/css"/>\n` +
    fontFiles.map((f) => `<item id="${f.id}" href="${f.href}" media-type="font/woff2"/>\n`).join("") +
    imageItems.map((im, i) => `<item id="img${i + 1}" href="${im.href}" media-type="${im.mediaType}"/>\n`).join("") +
    chapters.map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>\n`).join("") +
    `</manifest>\n<spine${book.dir === "rtl" ? ' page-progression-direction="rtl"' : ""}>\n<itemref idref="title"/>\n<itemref idref="nav"/>\n` +
    chapters.map((c) => `<itemref idref="${c.id}"/>\n`).join("") +
    `</spine>\n</package>\n`;
  const container =
    `<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
    `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n`;
  const entries: ZipInput[] = [
    // First and stored: how a reader recognises an EPUB.
    { name: "mimetype", data: "application/epub+zip", store: true },
    { name: "META-INF/container.xml", data: container },
    { name: "OEBPS/content.opf", data: opf },
    { name: "OEBPS/nav.xhtml", data: nav },
    { name: "OEBPS/title.xhtml", data: titlePage },
    { name: "OEBPS/book.css", data: css },
    ...fontFiles.map((f) => ({ name: `OEBPS/${f.href}`, data: f.bytes, store: true })),
    ...imageItems.map((im) => ({ name: `OEBPS/${im.href}`, data: im.bytes, store: true })),
    ...chapters.map((c) => ({ name: `OEBPS/${c.href}`, data: c.xhtml })),
  ];
  return zip(entries);
}
