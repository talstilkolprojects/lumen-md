/**
 * HTML of an export → a note's Markdown, through the app's own converter
 * (fileFormats.htmlToMarkdown), with two things it cannot know: where an
 * image or a link of the export ends up in the vault. Each `<img>` and
 * `<a>` is swapped for a token before the conversion and for its final
 * Markdown after it, so attachments with spaces, parentheses or Hebrew in
 * their names come out as working links.
 */
import { htmlToMarkdown } from "../fileFormats";
import { parseInertDocument } from "../../lib/trustedTypes";

/** What an `<img src>` / `<a href>` of the export becomes: Markdown, or `null` to keep the converter's own output. */
export interface HtmlRefs {
  image?: (src: string, alt: string) => string | null;
  link?: (href: string, text: string) => string | null;
}

const MARK = "\u{2063}";
const TOKEN = new RegExp(`${MARK}(\\d+)${MARK}`, "g");

export function htmlToNote(html: string, refs: HtmlRefs = {}): string {
  const doc = parseInertDocument(html, "text/html");
  nestStrayLists(doc);
  // An image wrapped in a link to itself (Notion's figures) is the image: the link would swallow it.
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const img = a.querySelector("img");
    if (img && a.children.length === 1 && !(a.textContent ?? "").trim() && a.getAttribute("href") === img.getAttribute("src")) a.replaceWith(img);
  }
  const out: string[] = [];
  const swap = (el: Element, md: string | null) => {
    if (md === null) return;
    out.push(md);
    el.replaceWith(doc.createTextNode(`${MARK}${out.length - 1}${MARK}`));
  };
  if (refs.image) for (const img of Array.from(doc.querySelectorAll("img"))) swap(img, refs.image(img.getAttribute("src") ?? "", img.getAttribute("alt") ?? ""));
  if (refs.link) {
    for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
      const text = (a.textContent ?? "").replace(/\s+/g, " ").trim();
      swap(a, refs.link(a.getAttribute("href") ?? "", text));
    }
  }
  // Checkboxes (Notion to-do, Apple Notes checklists) → task markers.
  for (const box of Array.from(doc.querySelectorAll('input[type="checkbox"]'))) {
    box.replaceWith(doc.createTextNode(box.hasAttribute("checked") ? "[x] " : "[ ] "));
  }
  const md = htmlToMarkdown(doc.documentElement.outerHTML);
  // A checkbox outside a list (Evernote's to-dos are lines) is a task item.
  // A token may hold another (an image inside a link's text): resolve until none is left.
  let text = md;
  for (let i = 0; i < 3 && text.includes(MARK); i++) text = text.replace(TOKEN, (_, n: string) => out[Number(n)] ?? "");
  return text.replace(/^(\s*)\[([ x])\] /gm, "$1- [$2] ");
}

/**
 * A list written straight inside a list (`<ul><li>a</li><ul><li>b</li></ul></ul>`,
 * as Evernote and Google Docs write sub-lists), or alone in an item of its own,
 * moves into the item before it, so it nests one level down instead of
 * becoming an item of its own.
 */
export function nestStrayLists(root: ParentNode): void {
  // An item holding nothing but a sub-list (Evernote's valid form of the same) is that sub-list.
  for (const li of Array.from(root.querySelectorAll("li"))) {
    const kids = Array.from(li.childNodes).filter((n) => n.nodeType !== 3 || (n.textContent ?? "").trim());
    if (kids.length === 1 && kids[0] instanceof Element && /^(UL|OL)$/.test(kids[0].tagName) && li.previousElementSibling?.tagName === "LI") li.replaceWith(kids[0]);
  }
  for (const list of Array.from(root.querySelectorAll("ul > ul, ul > ol, ol > ul, ol > ol"))) {
    let prev = list.previousElementSibling;
    if (!prev || prev.tagName !== "LI") {
      prev = list.ownerDocument.createElement("li");
      list.before(prev);
    }
    prev.appendChild(list);
  }
}

/** Decode the five XML entities and numeric references (ENEX titles, CSV-less fields). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** `data:<mime>;base64,<…>` → its bytes and an extension, or null. */
export function dataUri(src: string): { data: Uint8Array; ext: string } | null {
  const m = /^data:([\w.+-]+\/[\w.+-]+)?(;[^,]*)?,(.*)$/s.exec(src.trim());
  if (!m || !/;base64/i.test(m[2] ?? "")) return null;
  try {
    return { data: base64Bytes(m[3]), ext: extFromMime(m[1] ?? "") };
  } catch {
    return null;
  }
}

export function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/heic": ".heic",
  "image/bmp": ".bmp",
  "application/pdf": ".pdf",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/3gpp": ".3gp",
  "audio/wav": ".wav",
  "video/mp4": ".mp4",
  "text/plain": ".txt",
  "application/zip": ".zip",
};

export function extFromMime(mime: string): string {
  return MIME_EXT[mime.toLowerCase()] ?? ".bin";
}
