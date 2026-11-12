/**
 * True redaction for exports (plan W5.11, journalist mode, part 2).
 *
 * Text the author marks with `<redact>…</redact>` stays in the note, where
 * the author can see it, and is *removed* from every export: the PDF, DOCX,
 * HTML and Markdown files get a fixed placeholder (█████) instead of the
 * text. Nothing is covered by a black box over text that is still there, so
 * copying, `pdftotext` or unzipping the DOCX finds nothing.
 *
 * Rules, all of which fail closed (when in doubt, more is removed):
 *   - The placeholder has the same length whatever was removed, so its size
 *     tells nothing about a name's length.
 *   - Marks nest; the outermost pair wins. A `<redact>` that is never closed
 *     removes everything to the end of the note.
 *   - Marks count inside code blocks and code spans too: a secret in a code
 *     block is still a secret.
 *   - Hidden text that a reader of the file could find is removed too: HTML
 *     comments (`<!-- … -->`, an unclosed one runs to the end) and Obsidian
 *     comments (`%% … %%`), except inside code, where they are code.
 *   - Photos inlined as `data:` URLs lose their GPS, time and device
 *     metadata, unless the user keeps it (Settings, the same switch as for
 *     photos added to a note). A photo whose metadata can't be removed (it
 *     can't be parsed, and there is no canvas to re-encode it) is replaced by
 *     an empty image: it never leaves as it was (review 12.11).
 */

import { cleanImageBytes, keepImageMetadata, stripImageMetadata } from "./imageMetadata";

/** What replaces each redacted passage. Fixed length on purpose. */
export const REDACTED = "█████";

export const REDACT_OPEN = "<redact>";
export const REDACT_CLOSE = "</redact>";

const TAG = /<(\/?)redact\s*>/gi;

/** Wrap `text` in redaction marks (the editor's "Redact selection"). */
export function wrapRedaction(text: string): string {
  return `${REDACT_OPEN}${text}${REDACT_CLOSE}`;
}

/** Does the note have any redaction mark? */
export function hasRedactions(markdown: string): boolean {
  TAG.lastIndex = 0;
  return TAG.test(markdown);
}

/** The marked passages, as written (for the author's own review before an export). */
export function redactedPassages(markdown: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(markdown); m; m = TAG.exec(markdown)) {
    if (m[1] === "") {
      if (depth === 0) start = m.index + m[0].length;
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) out.push(markdown.slice(start, m.index));
    }
  }
  if (depth > 0) out.push(markdown.slice(start));
  return out;
}

/** Remove every marked passage; returns the text and how many passages went. */
export function removeRedacted(markdown: string): { text: string; count: number } {
  let out = "";
  let depth = 0;
  let last = 0;
  let count = 0;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(markdown); m; m = TAG.exec(markdown)) {
    if (m[1] === "") {
      if (depth === 0) {
        out += markdown.slice(last, m.index);
        count++;
      }
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) out += REDACTED;
    } else {
      // A stray closing mark: drop the mark, keep the text before it.
      out += markdown.slice(last, m.index);
    }
    last = m.index + m[0].length;
  }
  if (depth > 0) return { text: out + REDACTED, count };
  return { text: out + markdown.slice(last), count };
}

/** Code fence opener/closer (``` or ~~~, up to three spaces in). */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Remove HTML and Obsidian comments outside code. An HTML comment that is
 * never closed runs to the end of the note (fail closed); `%%` needs a pair.
 */
export function removeHiddenComments(markdown: string): string {
  const lines = markdown.split("\n");
  // Mark which characters are code (fenced blocks and inline code spans).
  let open: { ch: string; len: number } | null = null;
  const segments: { text: string; code: boolean }[] = [];
  const push = (text: string, code: boolean) => {
    const prev = segments[segments.length - 1];
    if (prev && prev.code === code) prev.text += text;
    else segments.push({ text, code });
  };
  lines.forEach((line, i) => {
    const nl = i < lines.length - 1 ? "\n" : "";
    const m = FENCE.exec(line);
    if (open) {
      if (m && m[1][0] === open.ch && m[1].length >= open.len && m[2].trim() === "") open = null;
      push(line + nl, true);
      return;
    }
    if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
      open = { ch: m[1][0], len: m[1].length };
      push(line + nl, true);
      return;
    }
    // Inline code spans: a run of N backticks closed by the same run.
    let at = 0;
    const span = /(`+)([\s\S]*?[^`])\1(?!`)/g;
    for (let s = span.exec(line); s; s = span.exec(line)) {
      push(line.slice(at, s.index), false);
      push(s[0], true);
      at = s.index + s[0].length;
    }
    push(line.slice(at) + nl, false);
  });

  let out = "";
  let inHtml = false;
  let inObsidian = false;
  for (const seg of segments) {
    if (seg.code) {
      if (!inHtml && !inObsidian) out += seg.text;
      continue;
    }
    let s = seg.text;
    while (s.length) {
      if (inHtml) {
        const end = s.indexOf("-->");
        if (end < 0) {
          s = "";
          break;
        }
        s = s.slice(end + 3);
        inHtml = false;
        continue;
      }
      if (inObsidian) {
        const end = s.indexOf("%%");
        if (end < 0) {
          s = "";
          break;
        }
        s = s.slice(end + 2);
        inObsidian = false;
        continue;
      }
      const h = s.indexOf("<!--");
      const o = s.indexOf("%%");
      if (h < 0 && o < 0) {
        out += s;
        break;
      }
      if (h >= 0 && (o < 0 || h < o)) {
        out += s.slice(0, h);
        s = s.slice(h + 4);
        inHtml = true;
      } else {
        out += s.slice(0, o);
        s = s.slice(o + 2);
        inObsidian = true;
      }
    }
  }
  // An Obsidian comment that never closed was not a comment: put it back.
  if (inObsidian) return removeHiddenCommentsKeepingUnclosedPercent(markdown);
  return out;
}

/** Second pass for a note with an odd `%%`: the last one is literal text. */
function removeHiddenCommentsKeepingUnclosedPercent(markdown: string): string {
  const last = markdown.lastIndexOf("%%");
  const sentinel = "\u0000LUMEN-PCT\u0000";
  const swapped = markdown.slice(0, last) + sentinel + markdown.slice(last + 2);
  return removeHiddenComments(swapped).split(sentinel).join("%%");
}

const DATA_IMAGE = /data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})/gi;

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** What a photo becomes when its metadata can't be removed: a 1×1 transparent GIF. */
export const WITHHELD_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * Photos inlined in the note as data: URLs, without their metadata. One that
 * can't be parsed (or decoded) is withheld: replaced by WITHHELD_IMAGE.
 */
export function cleanInlineImages(markdown: string): { text: string; cleaned: number; withheld: number } {
  let cleaned = 0;
  let withheld = 0;
  const text = markdown.replace(DATA_IMAGE, (whole, type: string, b64: string) => {
    try {
      const r = stripImageMetadata(fromBase64(b64));
      if (!r.format || r.removed.length === 0) return whole;
      cleaned++;
      return `data:image/${type.toLowerCase()};base64,${toBase64(r.bytes)}`;
    } catch {
      // why: fail closed: a photo we can't clean never goes out as it was
      withheld++;
      return WITHHELD_IMAGE;
    }
  });
  return { text, cleaned, withheld };
}

/** The async form: a photo that can't be parsed is re-encoded through a canvas first, withheld only when that fails. */
export async function cleanInlineImagesAsync(markdown: string): Promise<{ text: string; cleaned: number; withheld: number }> {
  const found = [...markdown.matchAll(DATA_IMAGE)];
  if (!found.length) return { text: markdown, cleaned: 0, withheld: 0 };
  const out = new Map<string, string | null>();
  let cleaned = 0;
  let withheld = 0;
  for (const m of found) {
    if (out.has(m[0])) continue;
    const type = m[1].toLowerCase() === "jpg" ? "image/jpeg" : `image/${m[1].toLowerCase()}`;
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(m[2]);
    } catch {
      out.set(m[0], null);
      continue;
    }
    const r = await cleanImageBytes(bytes, type);
    out.set(m[0], !r ? null : !r.format || r.removed.length === 0 ? m[0] : `data:${r.type};base64,${toBase64(r.bytes)}`);
  }
  const text = markdown.replace(DATA_IMAGE, (whole) => {
    const url = out.get(whole);
    if (url === null || url === undefined) {
      withheld++;
      return WITHHELD_IMAGE;
    }
    if (url !== whole) cleaned++;
    return url;
  });
  return { text, cleaned, withheld };
}

/** `![alt](lumen-asset-…)` and `![[lumen-asset-…]]`: photos stored in the vault. */
const ASSET_IMAGE = /!\[([^\]\n]*)\]\(\s*<?(?:\.\/)?(lumen-asset-[^\s)>]+\.(?:jpe?g|png|webp))>?(?:\s+"[^"\n]*")?\s*\)|!\[\[\s*(?:\.\/)?(lumen-asset-[^\]|#\n]+\.(?:jpe?g|png|webp))\s*(?:\|[^\]\n]*)?\]\]/gi;

const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/**
 * Photos stored in the vault, inlined as clean data: URLs, so an exported
 * PDF or HTML file never carries the original's metadata (Chromium writes a
 * JPEG into a PDF as it is, EXIF and all). A photo that can't be read is left
 * as a link.
 */
export async function inlineVaultImages(markdown: string, read: (name: string) => Promise<Blob>): Promise<{ text: string; inlined: number; withheld: number }> {
  const found = [...markdown.matchAll(ASSET_IMAGE)];
  if (!found.length) return { text: markdown, inlined: 0, withheld: 0 };
  const urls = new Map<string, string | null>();
  let withheld = 0;
  for (const m of found) {
    const name = m[2] ?? m[3];
    if (urls.has(name)) continue;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await (await read(name)).arrayBuffer());
    } catch {
      urls.set(name, null); // why: not in the vault: left as a link, nothing to leak
      continue;
    }
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    const r = await cleanImageBytes(bytes, MIME[ext]);
    if (!r) {
      // Fail closed: the renderer would otherwise load the original file into the PDF.
      withheld++;
      urls.set(name, WITHHELD_IMAGE);
    } else urls.set(name, `data:${r.type};base64,${toBase64(r.bytes)}`);
  }
  let inlined = 0;
  const text = markdown.replace(ASSET_IMAGE, (whole, alt: string | undefined, a: string | undefined, b: string | undefined) => {
    const url = urls.get((a ?? b) as string);
    if (!url) return whole;
    inlined++;
    return `![${alt ?? ""}](${url})`;
  });
  return { text, inlined, withheld };
}

export interface ExportPrepOptions {
  /** Read a vault photo, to inline it clean (PDF and HTML exports). */
  readAsset?: (name: string) => Promise<Blob>;
  /** Keep photos' metadata (Settings). Defaults to the user's choice. */
  keepImageMetadata?: boolean;
}

export interface ExportPrepReport {
  /** Marked passages removed. */
  redacted: number;
  /** Inline photos that lost metadata. */
  imagesCleaned: number;
  /** Photos replaced by an empty image: their metadata could not be removed. */
  imagesWithheld: number;
}

/**
 * The same for a synchronous exporter (`lumen convert`, the API server):
 * marked passages and hidden comments removed, inline photos cleaned in
 * place or withheld (no canvas to re-encode with there).
 */
export function prepareForExportSync(markdown: string, opts: Pick<ExportPrepOptions, "keepImageMetadata"> = {}): string {
  const text = removeHiddenComments(removeRedacted(markdown).text);
  return (opts.keepImageMetadata ?? keepImageMetadata()) ? text : cleanInlineImages(text).text;
}

/**
 * The text an exporter gets: marked passages and hidden comments removed,
 * photos without metadata. Every export path calls this; the note itself is
 * never changed.
 */
export async function prepareForExport(markdown: string, opts: ExportPrepOptions = {}): Promise<{ text: string; report: ExportPrepReport }> {
  const { text: removed, count } = removeRedacted(markdown);
  let text = removeHiddenComments(removed);
  let imagesCleaned = 0;
  let imagesWithheld = 0;
  const keep = opts.keepImageMetadata ?? keepImageMetadata();
  if (!keep) {
    if (opts.readAsset) {
      const r = await inlineVaultImages(text, opts.readAsset);
      text = r.text;
      imagesCleaned += r.inlined - r.withheld;
      imagesWithheld += r.withheld;
    }
    const c = await cleanInlineImagesAsync(text);
    text = c.text;
    imagesCleaned += c.cleaned;
    imagesWithheld += c.withheld;
  }
  return { text, report: { redacted: count, imagesCleaned, imagesWithheld } };
}
