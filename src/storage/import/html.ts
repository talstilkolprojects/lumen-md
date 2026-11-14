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
  return md.replace(TOKEN, (_, n: string) => out[Number(n)] ?? "").replace(/^(\s*)\[([ x])\] /gm, "$1- [$2] ");
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
