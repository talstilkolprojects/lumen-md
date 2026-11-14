/**
 * Hebrew spelling and simple grammar, entirely on this device (T28).
 *
 * Two layers:
 * 1. Rules that need no dictionary — a final letter (ך ם ן ף ץ) inside a
 *    word, a word typed twice, a space before punctuation. Always on.
 * 2. Spelling against Hspell's word list (via the hunspell export in
 *    `wooorm/dictionaries`). Hspell is AGPL-3.0, so it is **not bundled**:
 *    the user downloads it once (5.7 MB) with an explicit command, it is
 *    stored on this device, and nothing else is ever sent anywhere. The
 *    .dic file already lists every inflected form; its affix flags only add
 *    the prefix letters (ו ה ב כ ל מ ש …), which are peeled here — no
 *    hunspell engine is needed (nspell needed minutes to load it).
 */

import type { GrammarMatch } from "./grammar";
import { HEBREW_MARK_CHARS as M } from "../text/hebrew";

export const HEBREW_DICT_URL = "https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/he/index.dic";
export const HEBREW_DICT_LICENSE = "AGPL-3.0 (Hspell, hspell.ivrix.org.il)";

const LETTERS = "אבגדהוזחטיכלמנסעפצקרשתךםןףץ";
const FINALS = "ךםןףץ";
const TO_REGULAR: Record<string, string> = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };
const TO_FINAL: Record<string, string> = { "כ": "ך", "מ": "ם", "נ": "ן", "פ": "ף", "צ": "ץ" };
export const PREFIX = new Set(["ו", "ה", "ב", "כ", "ל", "מ", "ש"]);

/** Parse a hunspell .dic (first line = count, then `word/flags`). */
export function buildDictionary(dic: string): Set<string> {
  const set = new Set<string>();
  const lines = dic.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const slash = line.indexOf("/");
    set.add(slash < 0 ? line.trim() : line.slice(0, slash));
  }
  return set;
}

// Combining marks only: a maqaf (U+05BE) separates the two words of a compound.
const MARKS = new RegExp(`[${M}]`, "g");

export function stripMarks(word: string): string {
  return word.normalize("NFD").replace(MARKS, "").normalize("NFC").replace(/״/g, '"').replace(/׳/g, "'");
}

/**
 * Which prefix letter may follow which: ו only first; ה, ב and ל end the
 * prefix (ב/ל/כ absorb the article); כ only before ש (כש); מ before ה or ש;
 * ש before the rest. So "ההבית" or "בבית" peeled twice are not words.
 */
export const PREFIX_NEXT: Record<string, string> = { "ו": "שהבכלמ", "ש": "הבכלמ", "כ": "ש", "מ": "הש", "ה": "", "ב": "", "ל": "" };

/** Is the word in the dictionary, with up to three valid prefix letters peeled? */
export function isKnown(dict: Set<string>, raw: string): boolean {
  const word = stripMarks(raw);
  if (dict.has(word)) return true;
  let rest = word;
  let prev: string | null = null;
  for (let i = 0; i < 3 && rest.length > 2 && PREFIX.has(rest[0]) && (prev === null || PREFIX_NEXT[prev].includes(rest[0])); i++) {
    prev = rest[0];
    rest = rest.slice(1);
    // Hspell writes the ו of a prefixed word doubled ("הוולד"); try both.
    if (dict.has(rest) || (rest.startsWith("ו") && dict.has(rest.slice(1))) || dict.has("ו" + rest)) return true;
  }
  return false;
}

/**
 * Up to `max` known words one edit away, best first: the final-letter fix,
 * then a deleted or swapped letter, then a replaced one, then an inserted
 * one; words in the dictionary as they are rank above prefix-peeled ones.
 */
export function suggest(dict: Set<string>, raw: string, max = 5): string[] {
  const word = stripMarks(raw);
  const scored = new Map<string, number>();
  const add = (w: string, cost: number) => {
    if (w === word || w.length < 2 || !isKnown(dict, w)) return;
    const c = cost + (dict.has(w) ? 0 : 0.5);
    if (c < (scored.get(w) ?? Infinity)) scored.set(w, c);
  };
  const last = word.at(-1) ?? "";
  add(word.slice(0, -1) + (TO_FINAL[last] ?? last), 0);
  add([...word].map((c, i) => (i < word.length - 1 ? TO_REGULAR[c] ?? c : c)).join(""), 0);
  for (let i = 0; i <= word.length; i++) {
    // Deleting one of two equal neighbours (a doubled key) ranks first.
    if (i < word.length) add(fixFinal(word.slice(0, i) + word.slice(i + 1)), word[i] === word[i + 1] || word[i] === word[i - 1] ? 0.8 : 1);
    if (i < word.length - 1) add(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2), 1);
    for (const c of LETTERS) {
      if (i < word.length) add(word.slice(0, i) + c + word.slice(i + 1), 2);
      add(fixFinal(word.slice(0, i) + c + word.slice(i)), 3);
    }
  }
  return [...scored.entries()].sort((x, y) => x[1] - y[1]).slice(0, max).map(([w]) => w);
}

/** Regular forms inside, the final form at the end. */
function fixFinal(w: string): string {
  const chars = [...w].map((c, i, a) => (i < a.length - 1 ? TO_REGULAR[c] ?? c : TO_FINAL[c] ?? c));
  return chars.join("");
}

const HEB_WORD = new RegExp(`[\u05D0-\u05EA${M}]+(?:["״'׳][\u05D0-\u05EA]+)?`, "g");

const MISSING_FINAL = new RegExp(`(?<![\u05D0-\u05EA${M}])[\u05D0-\u05EA${M}]*[כמנפצ](?![\u05D0-\u05EA${M}"״'׳])`, "g");

/** Rules that need no dictionary. Offsets are into `text`. */
export function hebrewRules(text: string): GrammarMatch[] {
  const out: GrammarMatch[] = [];
  for (const m of text.matchAll(HEB_WORD)) {
    const w = m[0];
    const plain = stripMarks(w);
    // A final form anywhere but the end (and not before a geresh/gershayim).
    for (let i = 0; i < plain.length - 1; i++) {
      if (FINALS.includes(plain[i]) && !`"'`.includes(plain[i + 1])) {
        const fixed = fixFinal(plain);
        out.push({ offset: m.index!, length: w.length, message: "אות סופית באמצע מילה", replacements: [fixed], rule: { id: "HE_FINAL_LETTER_MIDWORD", category: "TYPOS" } });
        break;
      }
    }
  }
  // The regular form where the final one belongs ("שלומ" → "שלום").
  for (const m of text.matchAll(MISSING_FINAL)) {
    const w = m[0];
    if ([...stripMarks(w)].length < 2) continue;
    out.push({ offset: m.index!, length: w.length, message: "חסרה אות סופית", replacements: [fixFinal(stripMarks(w))], rule: { id: "HE_MISSING_FINAL_LETTER", category: "TYPOS" } });
  }
  for (const m of text.matchAll(/(?<![\p{L}\p{M}])([\p{L}\p{M}]{2,})\s+\1(?![\p{L}\p{M}])/gu)) {
    out.push({ offset: m.index!, length: m[0].length, message: "מילה כפולה", replacements: [m[1]], rule: { id: "HE_DOUBLE_WORD", category: "GRAMMAR" } });
  }
  for (const m of text.matchAll(/[א-ת] +([,.;:!?])/g)) {
    const at = m.index! + 1;
    out.push({ offset: at, length: m[0].length - 1, message: "רווח לפני סימן פיסוק", replacements: [m[1]], rule: { id: "HE_SPACE_BEFORE_PUNCT", category: "TYPOGRAPHY" } });
  }
  return out;
}

/** Spelling issues against the dictionary. Offsets are into `text`. */
export function hebrewSpelling(dict: Set<string>, text: string): GrammarMatch[] {
  const out: GrammarMatch[] = [];
  for (const m of text.matchAll(HEB_WORD)) {
    const w = m[0];
    if ([...stripMarks(w)].length < 2 || /["״'׳]/.test(w)) continue; // acronyms and abbreviations
    if (isKnown(dict, w)) continue;
    out.push({ offset: m.index!, length: w.length, message: "מילה לא מוכרת", replacements: suggest(dict, w), rule: { id: "HE_SPELLING", category: "TYPOS" } });
  }
  return out;
}
