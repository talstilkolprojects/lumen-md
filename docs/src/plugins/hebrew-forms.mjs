/**
 * Hebrew attaches its small words to the next one: ה (the), ו (and),
 * ב (in), ל (to), מ (from), ש (that), כ (as) — "והפתקים" is "and the notes".
 * Pagefind, the docs site's search, matches a query word against the start
 * of the indexed words and has no Hebrew stemmer, so a search for "פתקים"
 * would miss "והפתקים". The docs index every prefixed word's bare forms
 * too (./rehype-hebrew-search.mjs), so the bare word finds them all —
 * and the absolute form of a feminine noun in construct state ("התקנת
 * Lumen" → "התקנה"), so a search for "התקנה" finds "התקנת".
 */

const PREFIX = new Set(["ו", "ה", "ב", "ל", "מ", "ש", "כ"]);
const WORD = /[\u{05D0}-\u{05EA}][\u{05D0}-\u{05EA}\u{05F3}\u{05F4}"'\u{05B0}-\u{05C7}]*/gu;
const POINTS = /[\u{0591}-\u{05C7}]/gu;

/** The Hebrew words of `text`, without nikud or cantillation. */
export function hebrewWords(text) {
  return [...String(text).replace(POINTS, "").matchAll(WORD)].map((m) => m[0].replace(/["'\u{05F3}\u{05F4}]+$/u, ""));
}

/**
 * The bare forms of a word: one and two prefix letters off ("והפתקים" →
 * "הפתקים", "פתקים"), while at least three letters are left. Empty when the
 * word does not start with a prefix letter.
 */
export function bareForms(word) {
  const out = [];
  let w = word;
  for (let i = 0; i < 2 && w.length > 3 && PREFIX.has(w[0]); i++) {
    w = w.slice(1);
    out.push(w);
  }
  return out;
}

/** A feminine noun in construct state ends in ת where its absolute form ends in ה: "התקנת" → "התקנה". */
export function absoluteForm(word) {
  return word.length >= 4 && word.endsWith("ת") ? `${word.slice(0, -1)}ה` : null;
}

/** Every bare or absolute form of the words in `text` that the text does not already contain as a word. */
export function hebrewBaseForms(text) {
  const words = hebrewWords(text);
  const have = new Set(words);
  const out = new Set();
  for (const w of words) {
    for (const f of [w, ...bareForms(w)]) {
      if (f !== w && !have.has(f)) out.add(f);
      const a = absoluteForm(f);
      if (a && !have.has(a)) out.add(a);
    }
  }
  return [...out];
}
