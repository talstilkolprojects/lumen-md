/**
 * Local translation of a search hit (plan W5.28): the original paragraph is
 * shown, and next to it a translation made on this device. Never a cloud
 * call. In order:
 *   1. the translator a local engine registered (plan 6.4's Opus-MT /
 *      M2M100 in transformers.js calls registerLocalTranslator when it
 *      loads), or
 *   2. Chrome's built-in Translator API, which runs on the device
 *      (the global `Translator`, Chrome 138+), when it reports the language
 *      pair as available, or
 *   3. nothing: the dialog shows the original only and says why.
 */

export type Translate = (text: string, from: string, to: string, signal?: AbortSignal) => Promise<string>;

let registered: { name: string; translate: Translate } | null = null;

/** A local engine (6.4) offers itself here. */
export function registerLocalTranslator(name: string, translate: Translate): () => void {
  registered = { name, translate };
  return () => {
    if (registered?.translate === translate) registered = null;
  };
}

interface ChromeTranslator {
  translate(text: string): Promise<string>;
  destroy?(): void;
}
interface ChromeTranslatorFactory {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<"unavailable" | "downloadable" | "downloading" | "available">;
  create(o: { sourceLanguage: string; targetLanguage: string }): Promise<ChromeTranslator>;
}

const chromeCache = new Map<string, Promise<ChromeTranslator | null>>();

async function chromeTranslator(from: string, to: string, g: { Translator?: ChromeTranslatorFactory }): Promise<ChromeTranslator | null> {
  const T = g.Translator;
  if (!T?.availability || !T.create) return null;
  const key = `${from}>${to}`;
  if (!chromeCache.has(key)) {
    chromeCache.set(
      key,
      (async () => {
        // Only a pair that is already on the device: "downloadable" would start a download from a search.
        if ((await T.availability({ sourceLanguage: from, targetLanguage: to })) !== "available") return null;
        return T.create({ sourceLanguage: from, targetLanguage: to });
      })().catch(() => null),
    );
  }
  return chromeCache.get(key)!;
}

export interface TranslationResult {
  text: string | null;
  /** Which engine translated, or why nothing did. */
  engine: string | null;
}

export async function translatePassage(text: string, from: string, to: string, opts: { signal?: AbortSignal; globals?: { Translator?: ChromeTranslatorFactory } } = {}): Promise<TranslationResult> {
  const clipped = text.slice(0, 1500);
  if (registered) {
    try {
      return { text: await registered.translate(clipped, from, to, opts.signal), engine: registered.name };
    } catch {
      // why: the registered engine failed: the browser's translator is tried next
      /* fall through to the browser's translator */
    }
  }
  const t = await chromeTranslator(from, to, opts.globals ?? (globalThis as { Translator?: ChromeTranslatorFactory }));
  if (t) {
    try {
      return { text: await t.translate(clipped), engine: "browser" };
    } catch {
      // why: the browser's translator failed: the caller says no translation is available
      /* not translated */
    }
  }
  return { text: null, engine: null };
}

/** Tests. */
export function __resetTranslators(): void {
  registered = null;
  chromeCache.clear();
}
