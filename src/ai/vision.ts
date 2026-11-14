/**
 * Image understanding for alt text and search (T31).
 *
 *  1. OCR on this device (./ocr): an image that is mostly text (a
 *     screenshot, a slide, a scanned page) gets that text — Hebrew or
 *     English — as its alt text summary and its full text as the Markdown
 *     image title, so search finds it.
 *  2. Otherwise, a short description from a local vision model in Ollama
 *     (qwen2.5vl, gemma3, llava, minicpm-v, moondream…) when one is
 *     installed. Nothing is sent to the cloud.
 *  3. Otherwise a caption in the browser (plan 6.6, ./caption): Florence-2,
 *     SmolVLM as its fallback, translated into the document's language.
 *  4. Otherwise the file name stays — no invented alt text.
 * Every description passes validCaption (not empty, not the file name).
 */
import { getBaseUrl } from "./ollamaProvider";
import { meaningfulText, ocrImage } from "./ocr";

export interface ImageText {
  alt: string;
  /** Full recognised text, for the image title (searchable). */
  title?: string;
  source: "ocr" | "vision" | "browser" | "none";
  /** Language of the text: OCR's detected language (plan 6.5), or the caption's ("en" when it could not be translated). */
  lang?: string;
  /** The browser model that wrote the caption (source "browser"). */
  model?: string;
}

const VISION_RE = /(vl\b|vl:|llava|vision|gemma3|minicpm-v|moondream|bakllava|qwen2\.5vl|granite3\.2-vision)/i;

export async function visionModel(): Promise<string | null> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { models?: Array<{ name: string }> };
    return json.models?.map((m) => m.name).find((n) => VISION_RE.test(n)) ?? null;
  } catch {
    return null;
  }
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** One-sentence description from a local vision model, in `lang` ("he" / "en"). */
export async function describeImage(blob: Blob, lang: string, model?: string | null, signal?: AbortSignal): Promise<string | null> {
  const m = model ?? (await visionModel());
  if (!m) return null;
  const prompt =
    lang === "he"
      ? "תאר את התמונה במשפט אחד קצר, בעברית, כטקסט חלופי לנגישות. בלי הקדמה."
      : "Describe this image in one short sentence, as alt text for accessibility. No preamble.";
  try {
    const res = await fetch(`${getBaseUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: m, stream: false, messages: [{ role: "user", content: prompt, images: [await toBase64(blob)] }], options: { temperature: 0 } }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { message?: { content?: string } };
    const text = (json.message?.content ?? "").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 200) : null;
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
}

export interface ImageTextOptions {
  /** The image's file name or URL (the validator rejects a caption that repeats it). */
  name?: string;
  signal?: AbortSignal;
  /** Present when the user asked: the browser captioner may offer its download. */
  consent?: import("./mt/localModels").ConsentDeps;
}

/** Alt text (and searchable title) for an image. */
export async function imageText(blob: Blob, lang: string, opts: ImageTextOptions = {}): Promise<ImageText> {
  try {
    const ocr = await ocrImage(blob);
    if (meaningfulText(ocr)) {
      const firstLine = ocr.text.split("\n")[0].slice(0, 100);
      const prefix = lang === "he" ? "תמונה עם הטקסט: " : "Image with text: ";
      return { alt: `${prefix}${firstLine}`, title: ocr.text.slice(0, 600), source: "ocr", lang: ocr.lang };
    }
  } catch {
    /* why: OCR unavailable (offline before the first download, old engine) */
  }
  const { captionInBrowser, captionInLanguage, validCaption } = await import("./caption");
  const d = await describeImage(blob, lang, undefined, opts.signal);
  if (d && validCaption(d, opts.name)) return { alt: d, source: "vision" };
  const c = await captionInBrowser(blob, { consent: opts.consent, signal: opts.signal, name: opts.name });
  if (c) {
    const tr = await captionInLanguage(c.text, lang, opts.consent, opts.signal);
    return { alt: tr.text, source: "browser", lang: tr.lang, model: c.model };
  }
  return { alt: "", source: "none" };
}

/** Markdown-safe alt text and title. */
export function escapeAlt(s: string): string {
  return s.replace(/[[\]\n\r]/g, " ").replace(/\s+/g, " ").trim();
}
export function escapeTitle(s: string): string {
  return s.replace(/"/g, "'").replace(/[\r\n]+/g, " · ").replace(/\s+/g, " ").trim();
}

const GENERIC_IMAGE_NAME = /^(?:image|img|dsc|dscn|dcim|pxl|photo|pic|picture|screenshot|screen[ _-]?shot|pasted[ _-]?image|untitled|צילום[ _-]?מסך|תמונה)(?=$|[\s_\-.:(),\d])/i;

/**
 * Whether an image's alt text is really missing: empty, the referenced
 * file's own name, or a camera/clipboard file name ("image", "IMG_1234",
 * "Screenshot 2026-10-18 at 10.00.00") that a paste left behind. A real
 * one-word description ("logo", "cat") is kept.
 */
export function altIsPlaceholder(alt: string, url: string): boolean {
  const a = alt.trim();
  if (!a) return true;
  let file = url.split(/[?#]/)[0].split("/").pop() ?? "";
  try {
    file = decodeURIComponent(file);
  } catch {
    /* why: keep it encoded */
  }
  const stem = file.replace(/\.[^.]+$/, "");
  const lower = a.toLowerCase();
  if (lower === file.toLowerCase() || lower === stem.toLowerCase()) return true;
  if (/^[^\s/]+\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic|tiff?)$/i.test(a)) return true;
  const generic = GENERIC_IMAGE_NAME.exec(a);
  return !!generic && /^[\d\s_\-.:(),]*(?:(?:at|am|pm)[\d\s_\-.:(),]*)*$/i.test(a.slice(generic[0].length));
}

/** Local images in `markdown` whose alt text is a placeholder (see altIsPlaceholder). */
export function imagesNeedingAlt(markdown: string): Array<{ alt: string; url: string }> {
  return [...markdown.matchAll(/!\[([^\]]*)\]\(([^)\s"]+)\)/g)]
    .filter((m) => !/^(https?:|data:)/.test(m[2]) && altIsPlaceholder(m[1], m[2]))
    .map((m) => ({ alt: m[1], url: m[2] }));
}

/** Rewrite one image in the Markdown: same URL, new alt + optional title. */
export function withImageText(markdown: string, url: string, oldAlt: string, t: ImageText): string {
  if (t.source === "none" || !t.alt) return markdown;
  const from = `![${oldAlt}](${url})`;
  const idx = markdown.indexOf(from);
  if (idx < 0) return markdown;
  const title = t.title ? ` "${escapeTitle(t.title)}"` : "";
  return markdown.slice(0, idx) + `![${escapeAlt(t.alt)}](${url}${title})` + markdown.slice(idx + from.length);
}

/**
 * The language a caption should be in: the note's own (local detection,
 * plan 6.5), else `fallback` (the UI language) for an empty or unclear note.
 */
export async function documentLanguage(markdown: string, fallback: string): Promise<string> {
  try {
    const [{ detectLanguage }, { proseOf }] = await Promise.all([import("../text/langId"), import("../agents/defs/translator")]);
    const g = detectLanguage(proseOf(markdown));
    return g.confident && g.lang !== "und" ? g.lang : fallback;
  } catch {
    return fallback;
  }
}
