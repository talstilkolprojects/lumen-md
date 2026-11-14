/**
 * The en-US Hunspell files for the English spelling checker (plan 6.10),
 * shared by its worker and its main-thread fallback. They are data, not
 * code: fetched same-origin from the app's own dict/ (copied there by
 * scripts/copy-dictionary-en.mjs and precached by the service worker, so
 * it works offline and nothing leaves the device). Under Vitest the
 * `virtual:lumen-dictionary-en` module carries them inline instead.
 */
import { inline } from "virtual:lumen-dictionary-en";

export type EnglishDictionary = { aff: string; dic: string };

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`English dictionary: ${url} answered ${res.status}`);
  return res.text();
}

export async function loadEnglishDictionary(): Promise<EnglishDictionary> {
  if (inline) return inline;
  const base = (import.meta.env?.BASE_URL as string | undefined) ?? "/";
  const [aff, dic] = await Promise.all([fetchText(`${base}dict/en-US.aff.txt`), fetchText(`${base}dict/en-US.dic.txt`)]);
  return { aff, dic };
}
