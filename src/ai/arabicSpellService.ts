/**
 * Arabic spelling service (plan W5.17): the word-list download (explicit,
 * once), where it is kept (IndexedDB on this device), and the check. Without
 * the list the rules that need none still run. The list is built into a set
 * of folded stems once, on first use, on the main thread: a check is a few
 * set lookups per word.
 */
import "./arabicStrings";
import { get, set, del } from "idb-keyval";
import type { GrammarMatch } from "./grammar";
import { ARABIC_DICT_URL, arabicRules, arabicSpelling, buildArabicDictionary } from "./arabicSpell";

/** The event open editors listen to (editor/grammarExtension.ts): they check again. */
const DICTIONARY_CHANGED_EVENT = "lumen-hebrew-dictionary-changed";

const DICT_KEY = "lumen.dict.ar.v1";

let dictionary: Promise<Set<string> | null> | null = null;

function announceDictionaryChange(): void {
  dictionary = null;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DICTIONARY_CHANGED_EVENT));
}

export async function arabicDictionaryInstalled(): Promise<boolean> {
  try {
    return typeof (await get<string>(DICT_KEY)) === "string";
  } catch {
    return false;
  }
}

/**
 * Download Ayaspell's word list (GPL / LGPL / MPL) to this device. Called
 * only from the user's own command: the app never fetches it by itself.
 */
export async function downloadArabicDictionary(fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await fetchImpl(ARABIC_DICT_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!/^\d+\r?\n/.test(text)) throw new Error("not a hunspell .dic file");
  await set(DICT_KEY, text);
  announceDictionaryChange();
  return Number.parseInt(text, 10);
}

export async function removeArabicDictionary(): Promise<void> {
  await del(DICT_KEY);
  announceDictionaryChange();
}

function loadDictionary(): Promise<Set<string> | null> {
  // Through a resolved promise: a storage that throws synchronously still lands in the catch.
  dictionary ??= Promise.resolve()
    .then(() => get<string>(DICT_KEY))
    .then((dic) => (typeof dic === "string" ? buildArabicDictionary(dic) : null))
    .catch(() => null);
  return dictionary;
}

/** Check Arabic text: the rules always; spelling once the user installed the list. */
export async function checkArabic(text: string): Promise<GrammarMatch[]> {
  const dict = await loadDictionary();
  const out = arabicRules(text);
  if (dict) out.push(...arabicSpelling(dict, text));
  return out.sort((a, b) => a.offset - b.offset);
}
