/**
 * Image captions in the browser (plan 6.6): Florence-2 base-ft (MIT) in the
 * transformers.js worker, SmolVLM-256M-Instruct (Apache-2.0) when Florence-2
 * cannot load or gives nothing usable. Both caption in English; the caption
 * is then translated into the document's language by local translation
 * (plan 6.4), and kept in English when no local layer can.
 *
 * Models come from Hugging Face only after the consent dialog (size,
 * licence, attribution). A background caption (a pasted image) never asks:
 * it uses a model only once the user has agreed to it from a command.
 */
import "./captionStrings";
import type { ConsentDeps } from "./mt/localModels";
import type { CaptionFamily } from "./transformers.worker";
import { altIsPlaceholder } from "./vision";

export interface CaptionModel {
  id: string;
  family: CaptionFamily;
  /** Download size the dialog shows (q4f16 on WebGPU; q8 on wasm is a little larger). */
  bytes: number;
  license: string;
  /** i18n key of the attribution line. */
  attribution: string;
}

export const CAPTION_MODELS: readonly CaptionModel[] = [
  { id: "onnx-community/Florence-2-base-ft", family: "florence2", bytes: 224_000_000, license: "MIT", attribution: "caption.attribution.florence" },
  { id: "HuggingFaceTB/SmolVLM-256M-Instruct", family: "smolvlm", bytes: 189_000_000, license: "Apache-2.0", attribution: "caption.attribution.smolvlm" },
];

const readyKey = (id: string) => `lumen.caption.ready.${id}`;

export interface CaptionDeps {
  /** Present only when the user asked (a command): may show the download dialog. */
  consent?: ConsentDeps;
  signal?: AbortSignal;
  /** The worker call (tests replace it). */
  caption?: (model: string, family: CaptionFamily, image: Blob, opts: { signal?: AbortSignal }) => Promise<string>;
  storage?: Pick<Storage, "getItem" | "setItem">;
  /** The image's file name or URL: a caption that only repeats it is rejected. */
  name?: string;
}

const SPECIAL = /<\/?(?:s|pad|unk|end_of_utterance|image|fake_token_around_image)>|<\|[^|]*\|>/g;
const ECHO = /^(?:assistant|user)\s*:\s*/i;
const NO_ANSWER = /^(?:unanswerable|none|n\/a|no caption|i (?:can(?:no|')t|am unable to)\b)/i;

/** A model's raw output → one clean sentence, or "" when it is not a caption. */
export function cleanCaption(raw: string): string {
  let s = raw.replace(SPECIAL, " ").replace(/\s+/g, " ").trim().replace(ECHO, "");
  s = s.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (!s || NO_ANSWER.test(s)) return "";
  if (s.length > 200) s = s.slice(0, 200).replace(/\s+\S*$/, "") + "…";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The validator (6.6.3): a caption is kept only when it says something —
 * not empty, at least two words, not the file name or a camera placeholder
 * ("IMG_1234"), and not the prompt read back.
 */
export function validCaption(text: string, name = ""): boolean {
  const s = text.trim();
  if (!s) return false;
  if (s.split(/\s+/).length < 2) return false;
  if (altIsPlaceholder(s, name)) return false;
  if (/describe this image|one short sentence|alt text/i.test(s)) return false;
  return true;
}

function isReady(storage: CaptionDeps["storage"], id: string): boolean {
  try {
    return storage?.getItem(readyKey(id)) === "1";
  } catch {
    return false;
  }
}

async function askConsent(consent: ConsentDeps, m: CaptionModel): Promise<boolean> {
  const size = consent.t("mt.size.approx", { size: `${Math.round(m.bytes / 1e6)} MB` });
  return consent.confirm({
    title: consent.t("models.consent.title"),
    message: consent.t("models.consent.body", {
      purpose: consent.t("caption.purpose"),
      name: m.id,
      size,
      license: m.license,
      attribution: consent.t(m.attribution),
    }),
    okLabel: consent.t("models.consent.ok", { size }),
  });
}

export interface BrowserCaption {
  /** English caption. */
  text: string;
  model: string;
}

/** An English caption from the first browser model that is allowed and gives a valid one. */
export async function captionInBrowser(image: Blob, deps: CaptionDeps = {}): Promise<BrowserCaption | null> {
  const storage = deps.storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  const run = deps.caption ?? (async (model, family, blob, opts) => (await import("./transformersEngine")).captionLocal(model, family, blob, opts));
  for (const m of CAPTION_MODELS) {
    if (!isReady(storage, m.id)) {
      if (!deps.consent) continue;
      // A declined download ends the attempt: no second dialog for the fallback.
      if (!(await askConsent(deps.consent, m))) return null;
    }
    let raw: string;
    try {
      raw = await run(m.id, m.family, image, { signal: deps.signal });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      continue; // could not load or run here (memory, no WebGPU op): try the fallback
    }
    try {
      storage?.setItem(readyKey(m.id), "1"); // in the browser's cache now: no second dialog
    } catch {
      /* why: private mode */
    }
    const text = cleanCaption(raw);
    if (validCaption(text, deps.name)) return { text, model: m.id };
  }
  return null;
}

/**
 * The caption in `lang` through local translation (plan 6.4). `consent`
 * absent: only layers that need no download are used. Returns the English
 * caption, marked "en", when no local layer can translate it.
 */
export async function captionInLanguage(caption: string, lang: string, consent?: ConsentDeps, signal?: AbortSignal): Promise<{ text: string; lang: string }> {
  if (!lang || lang === "en") return { text: caption, lang: "en" };
  try {
    const [{ translateLocally }, i18n] = await Promise.all([import("./mt"), import("../i18n")]);
    const quiet: ConsentDeps = consent ?? { confirm: async () => false, t: i18n.t, locale: i18n.getLocale() };
    const r = await translateLocally(caption, { source: "en", target: lang }, quiet, { signal });
    if (r.layer && r.text.trim()) return { text: r.text.trim(), lang };
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
  }
  return { text: caption, lang: "en" };
}
