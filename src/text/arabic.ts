/**
 * Arabic text core (plan W5.17), the Arabic side of ./hebrew.ts.
 *
 * Tashkeel (harakat, tanwin, shadda, sukun, the dagger alif and the
 * Quranic marks) is to Arabic what niqqud is to Hebrew: the same word with
 * or without it is the same word. Matching therefore ignores it, and the
 * spelling and search helpers here fold the spellings Arabic writers use
 * interchangeably: alif with or without hamza or madda, final ya and alif
 * maqsura, ta marbuta and ha, and the tatweel that only stretches a line.
 *
 * Folding is for comparison only; the note's text is never rewritten,
 * except by the explicit "remove tashkeel" command.
 */

/**
 * Tashkeel as a regex character-class body: the harakat and tanwin
 * (U+064B–U+065F), the superscript (dagger) alif U+0670, and the Quranic
 * annotation marks U+06D6–U+06DC, U+06DF–U+06E4, U+06E7–U+06E8,
 * U+06EA–U+06ED. Not the letters or punctuation around them.
 */
export const TASHKEEL_CHARS = "\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED";
const TASHKEEL = new RegExp(`[${TASHKEEL_CHARS}]`, "g");
const TASHKEEL_ONE = new RegExp(`[${TASHKEEL_CHARS}]`);
/** Tatweel (kashida): stretches a word, carries no meaning. */
const TATWEEL = /\u0640/g;
const ARABIC_LETTER = /[\u0620-\u063F\u0641-\u064A\u066E-\u06D3\u06D5\u06FA-\u06FC\u06FF\u0750-\u077F\u08A0-\u08C9]/;

export function hasArabic(text: string): boolean {
  return ARABIC_LETTER.test(text);
}

export function hasTashkeel(text: string): boolean {
  return TASHKEEL_ONE.test(text);
}

/** Remove tashkeel (keeps the letters, the hamza and the punctuation). */
export function removeTashkeel(text: string): string {
  return text.replace(TASHKEEL, "");
}

/** The share of the letters that are Arabic (0 when there are none). */
export function arabicRatio(text: string): number {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return 0;
  return letters.filter((c) => /\p{Script=Arabic}/u.test(c)).length / letters.length;
}

/**
 * Comparison form of Arabic: tashkeel and tatweel removed, alif with
 * hamza or madda (أ إ آ ٱ) folded to bare alif, alif maqsura to ya, ta
 * marbuta to ha. "مَدْرَسَةٌ", "مدرسة" and "مدرسه" compare equal, and so
 * do "إسلام" and "اسلام".
 */
export function foldArabic(text: string): string {
  return removeTashkeel(text)
    .replace(TATWEEL, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

/** Proclitics that glue onto the front of an Arabic word: conjunctions, prepositions, the future sa-. */
const PROCLITICS = ["و", "ف", "ب", "ك", "ل", "س"];

/**
 * The word without its proclitics and its article, longest first:
 * "والمدرسة" → ["والمدرسة", "المدرسة", "مدرسة"]. One clitic letter at a
 * time (at most two) then "ال" (or the "لل" of li + al), never below
 * three letters. Used as extra search and spelling forms, never to rewrite
 * the text.
 */
export function arabicPrefixVariants(word: string): string[] {
  const out = [word];
  if (!hasArabic(word)) return out;
  let w = word;
  for (let i = 0; i < 2 && w.length > 3 && PROCLITICS.includes(w[0]); i++) {
    // "لل" is li + the article: "للمدرسة" → "المدرسة".
    if (w.startsWith("لل") && w.length > 4) {
      w = "ال" + w.slice(2);
      out.push(w);
      break;
    }
    w = w.slice(1);
    out.push(w);
  }
  if (w.startsWith("ال") && w.length > 4) out.push(w.slice(2));
  return [...new Set(out)];
}

/** Enclitic pronouns and the common inflectional endings, longest first. */
const SUFFIXES = ["كما", "هما", "تما", "تموا", "كم", "كن", "هم", "هن", "نا", "ها", "ات", "ون", "ين", "ان", "تم", "تن", "وا", "ة", "ه", "ي", "ك", "ت"];

/** The word without one ending, never below three letters: "مدرستها" → ["مدرستها", "مدرست"]. */
export function arabicSuffixVariants(word: string): string[] {
  const out = [word];
  for (const s of SUFFIXES) {
    if (word.length - s.length >= 3 && word.endsWith(s)) out.push(word.slice(0, -s.length));
  }
  return out;
}
