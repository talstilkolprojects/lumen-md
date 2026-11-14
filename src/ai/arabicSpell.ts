/**
 * Arabic spelling and simple typography, on this device (plan W5.17).
 *
 * Two layers, like the Hebrew checker (./hebrewSpell.ts):
 * 1. Rules that need no word list: a word typed twice, a space before
 *    punctuation, and Latin punctuation (, ; ?) right after an Arabic word,
 *    where Arabic has its own (، ؛ ؟). Always on.
 * 2. Spelling against Ayaspell's word list (the hunspell export in
 *    `wooorm/dictionaries`). Ayaspell is GPL-2.0+ / LGPL-2.1+ / MPL-1.1, so,
 *    like Hspell, it is **not bundled** with this MIT app: the user
 *    downloads it once with an explicit command and it stays on this device.
 *    The .dic lists stems; the proclitics (و ف ب ك ل س), the article and
 *    the common endings are peeled here, and words are compared folded
 *    (tashkeel, hamza seats, ى / ي, ة / ه: ../text/arabic.ts), so no
 *    hunspell engine is needed.
 *
 * Messages are in Arabic: they describe the text, not the interface.
 */

import type { GrammarMatch } from "./grammar";
import { arabicPrefixVariants, arabicSuffixVariants, foldArabic, removeTashkeel } from "../text/arabic";

export const ARABIC_DICT_URL = "https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/ar/index.dic";
export const ARABIC_DICT_LICENSE = "GPL-2.0-or-later OR LGPL-2.1-or-later OR MPL-1.1 (Ayaspell, ayaspell.sourceforge.net)";

/** An Arabic word: letters and tashkeel, tatweel inside. */
const AR_WORD = /[ء-غف-يٱ-ۓ][ء-\u065F\u0670-ۓ\u0640]*/g;

/** Parse a hunspell .dic (first line = count, then `word/flags`) into folded stems. */
export function buildArabicDictionary(dic: string): Set<string> {
  const set = new Set<string>();
  const lines = dic.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const slash = line.indexOf("/");
    const word = (slash < 0 ? line : line.slice(0, slash)).trim();
    if (word) set.add(foldArabic(word));
  }
  return set;
}

/** Is the word (or the word without its clitics and one ending) in the list? */
export function isKnownArabic(dict: Set<string>, word: string): boolean {
  const folded = foldArabic(word);
  if (dict.has(folded)) return true;
  for (const p of arabicPrefixVariants(folded)) {
    if (dict.has(p)) return true;
    for (const s of arabicSuffixVariants(p)) if (dict.has(s)) return true;
  }
  return false;
}

const LETTERS = "ءآأؤإئابةتثجحخدذرزسشصضطظعغفقكلمنهوىي";

/**
 * Up to five known words one edit away (delete, swap, replace, insert),
 * in the order they were found. Folded forms come back as written in the
 * list's spelling, which is close enough to choose from.
 */
export function suggestArabic(dict: Set<string>, word: string, max = 5): string[] {
  const w = removeTashkeel(word).replace(/\u0640/g, "");
  const out: string[] = [];
  const seen = new Set<string>([w]);
  const tryWord = (c: string) => {
    if (out.length >= max || seen.has(c) || c.length < 2) return;
    seen.add(c);
    if (isKnownArabic(dict, c)) out.push(c);
  };
  for (let i = 0; i < w.length && out.length < max; i++) {
    tryWord(w.slice(0, i) + w.slice(i + 1));
    if (i + 1 < w.length) tryWord(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
  }
  for (let i = 0; i < w.length && out.length < max; i++) for (const c of LETTERS) tryWord(w.slice(0, i) + c + w.slice(i + 1));
  for (let i = 0; i <= w.length && out.length < max; i++) for (const c of LETTERS) tryWord(w.slice(0, i) + c + w.slice(i));
  return out;
}

/** The rules that need no word list. Offsets are into `text`. */
export function arabicRules(text: string): GrammarMatch[] {
  const out: GrammarMatch[] = [];
  for (const m of text.matchAll(/(?<![\p{L}\p{M}])([\p{Script=Arabic}\p{M}]{2,})\s+\1(?![\p{L}\p{M}])/gu)) {
    out.push({ offset: m.index!, length: m[0].length, message: "كلمة مكررة", replacements: [m[1]], rule: { id: "AR_DOUBLE_WORD", category: "GRAMMAR" } });
  }
  for (const m of text.matchAll(/[ء-ي] +([،؛؟.!:])/g)) {
    out.push({ offset: m.index! + 1, length: m[0].length - 1, message: "مسافة قبل علامة الترقيم", replacements: [m[1]], rule: { id: "AR_SPACE_BEFORE_PUNCT", category: "TYPOGRAPHY" } });
  }
  const ARABIC_PUNCT: Record<string, string> = { ",": "،", ";": "؛", "?": "؟" };
  for (const m of text.matchAll(/[ء-ي\u064B-\u0652]([,;?])(?=\s|$)/g)) {
    out.push({ offset: m.index! + 1, length: 1, message: "علامة ترقيم لاتينية في نص عربي", replacements: [ARABIC_PUNCT[m[1]]], rule: { id: "AR_LATIN_PUNCT", category: "TYPOGRAPHY" } });
  }
  return out.sort((a, b) => a.offset - b.offset);
}

/** Unknown words against the list. Offsets are into `text`. */
export function arabicSpelling(dict: Set<string>, text: string): GrammarMatch[] {
  const out: GrammarMatch[] = [];
  for (const m of text.matchAll(AR_WORD)) {
    const w = m[0];
    if (removeTashkeel(w).length < 2) continue;
    if (isKnownArabic(dict, w)) continue;
    out.push({ offset: m.index!, length: w.length, message: "كلمة غير معروفة", replacements: suggestArabic(dict, w), rule: { id: "AR_SPELLING", category: "TYPOS" } });
  }
  return out;
}
