/**
 * Hebrew text core (MASTER_PLAN v3, T26).
 *
 * Small, dependency-free helpers every Hebrew-aware feature shares:
 * matching that ignores niqqud and final-letter forms, the prefix
 * letters (ו, ה, ב, ל, מ, ש, כ and their combinations) that glue onto a
 * word, and word counting that does not break a pointed word apart.
 */

/**
 * Niqqud, cantillation and the other Hebrew combining marks, as a regex
 * character-class body: U+0591–U+05C7 *without* the punctuation inside
 * that block (maqaf U+05BE, paseq U+05C0, sof pasuq U+05C3, nun hafukha
 * U+05C6), which separates words rather than decorating a letter.
 */
export const HEBREW_MARK_CHARS = "\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7";
const HEBREW_MARKS = new RegExp(`[${HEBREW_MARK_CHARS}]`, "g");
const FINALS: Record<string, string> = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };
const HEBREW_LETTER = /[א-ת]/;

export function hasHebrew(text: string): boolean {
  return HEBREW_LETTER.test(text);
}

/** Remove niqqud and cantillation (keeps the letters). */
export function stripNiqqud(text: string): string {
  return text.normalize("NFD").replace(HEBREW_MARKS, "").normalize("NFC");
}

/**
 * Comparison form: NFC, lower-case, niqqud removed, final letters folded
 * into their regular form, Hebrew punctuation (geresh, gershayim, maqaf)
 * mapped to ASCII. Two spellings a reader sees as the same word compare
 * equal.
 */
export function normalizeForMatch(text: string): string {
  return stripNiqqud(text)
    .toLowerCase()
    .replace(/[ךםןףץ]/g, (c) => FINALS[c])
    .replace(/[׳’‘]/g, "'")
    .replace(/[״“”]/g, '"')
    .replace(/־/g, "-");
}

/** The letters that attach to the front of a Hebrew word (מש״ה וכל״ב). */
const PREFIX_LETTERS = new Set(["ו", "ה", "ב", "ל", "מ", "ש", "כ"]);

/**
 * The word without its prefix letters, one letter at a time, at most
 * three, keeping at least three letters: `"והבית"` → `["והבית", "הבית",
 * "בית"]`. Longest form first, so a search tries the exact word before the
 * bare one. Used as extra search forms, never to rewrite the text.
 */
export function prefixVariants(word: string): string[] {
  const out = [word];
  if (!hasHebrew(word)) return out;
  let rest = [...word];
  for (let i = 0; i < 3 && rest.length > 3 && PREFIX_LETTERS.has(rest[0]); i++) {
    rest = rest.slice(1);
    out.push(rest.join(""));
  }
  return out;
}

/**
 * Words of a text: letters (any script) with their combining marks,
 * digits, and in-word apostrophes / gershayim / hyphens. A pointed Hebrew
 * word is one word, `צה״ל` is one word.
 */
export function words(text: string): string[] {
  return text.match(/[\p{L}\p{M}\p{N}]+(?:['’׳״"\-־][\p{L}\p{M}\p{N}]+)*[׳]?/gu) ?? [];
}

export function countWords(text: string): number {
  return words(text).length;
}

/**
 * `normalizeForMatch`, plus where every character of the result came
 * from in the original, so a match found in the normalized text can be
 * highlighted in the text the user sees.
 */
/** `normalizeForMatch` of single characters, memoised: a text repeats few distinct characters. */
const foldCache = new Map<string, string>();

export function normalizeWithMap(text: string): { text: string; map: number[] } {
  let out = "";
  const map: number[] = [];
  let i = 0;
  for (const ch of text) {
    let folded = foldCache.get(ch);
    if (folded === undefined) {
      folded = normalizeForMatch(ch);
      if (foldCache.size < 4096) foldCache.set(ch, folded);
    }
    for (const c of folded) {
      out += c;
      map.push(i);
    }
    i += ch.length;
  }
  map.push(text.length);
  return { text: out, map };
}

/**
 * Find `needle` in `haystack` the way a Hebrew reader means it: niqqud-,
 * case- and final-letter-insensitive; when the needle is one Hebrew word
 * with prefix letters, its bare forms count too (searching "והבית" finds
 * "בית"). Returns the match as offsets in the *original* haystack, or null.
 */
export function hebrewFind(haystack: string, needle: string): { start: number; end: number } | null {
  const { text: h, map } = normalizeWithMap(haystack);
  const n = normalizeForMatch(needle.trim());
  if (!n) return null;
  const candidates = /\s/.test(n) ? [n] : prefixVariants(n);
  for (const c of candidates) {
    const at = h.indexOf(c);
    if (at >= 0) return { start: map[at], end: map[at + c.length] };
  }
  return null;
}

/** Share of letters that are Hebrew (0–1); 0 when there are no letters. */
export function hebrewRatio(text: string): number {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return 0;
  return letters.filter((c) => /\p{Script=Hebrew}/u.test(c)).length / letters.length;
}
