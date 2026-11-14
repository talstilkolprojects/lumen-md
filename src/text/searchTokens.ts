/**
 * Search tokens for BM25 (plan 5.2), Hebrew-aware.
 *
 * Every word becomes its comparison form (`normalizeForMatch`: niqqud
 * stripped, final letters folded, lower-cased). A Hebrew word also yields
 * its forms without prefix letters (ו ה ב כ ל מ ש, `prefixVariants`) as
 * separate "stem" terms, marked with a leading `~`, so that "בבית",
 * "והבית" and "בית" meet on `~בית` while the exact form keeps its own,
 * stronger term. Stripping is careful: one letter at a time, at most three,
 * never below three letters — and a stem is only extra evidence, weighted
 * lower at query time, so a word that merely starts with a prefix letter
 * ("שלום" → "~לום") does not drown the exact match.
 *
 * Queries drop a few function words (question words, prepositions,
 * pronouns) that carry no topic; documents keep them (BM25's idf already
 * makes them cheap, and a note may be searched for one).
 *
 * Plan W2.11 adds morphology (text/hebrewMorph): every Hebrew word, and
 * each of its prefix-less forms, also yields its full/defective spelling
 * key (`≈`) and its lemma keys (`≃`), and a query word also asks for its
 * synonyms and, for a Hebrew word, its English equivalents. All of these
 * weigh less than the exact word.
 */

import { hasHebrew, normalizeForMatch, prefixVariants, words } from "./hebrew";
import { englishOf, ktivKey, lemmaKeys, synonymsOf } from "./hebrewMorph";
import { arabicPrefixVariants, hasArabic } from "./arabic";

export const STEM = "~";
/** Full/defective spelling key of a Hebrew word (W2.11), marked with a leading `≈`. */
export const KTIV = "≈";
/** Lemma keys of a Hebrew word (W2.11), marked with a leading `≃`. */
export const LEMMA = "≃";

/**
 * Comparison forms of the words of `text`, in order (no stems). The text
 * is normalised once, then split (normalising word by word is several
 * times slower on a large vault); geresh / gershayim inside a word are
 * dropped, so צה״ל and צה"ל are the term צהל.
 */
export function surfaceTokens(text: string): string[] {
  const out: string[] = [];
  for (const w of words(normalizeForMatch(text))) {
    const n = w.replace(/['"]/g, "");
    if (n) out.push(n);
  }
  return out;
}

/**
 * The other forms of one comparison form, as stem terms: for a Hebrew
 * word, itself and its prefix-less forms; for a hyphenated word
 * (מ-100, מזאל-שחר, e-mail), each part and the parts' own stems.
 */
export function stemTerms(token: string): string[] {
  const out = new Set<string>();
  if (!token.includes("-")) {
    if (hasHebrew(token)) for (const v of prefixVariants(token)) out.add(STEM + v);
    // W5.17: an Arabic word meets its forms without و ف ب ك ل س and the article.
    else if (hasArabic(token)) for (const v of arabicPrefixVariants(token)) out.add(STEM + v);
  } else {
    out.add(STEM + token);
    for (const part of hyphenParts(token)) {
      out.add(STEM + part);
      if (hasHebrew(part)) for (const v of prefixVariants(part)) out.add(STEM + v);
    }
  }
  return [...out];
}

/**
 * The morphology terms of one comparison form: ktiv and lemma keys of the
 * word and of its prefix-less forms. `stripped`: the key comes from a
 * prefix-less form (weaker, like a stem; and never a two-letter key, which
 * would join unrelated short words).
 */
export function morphForms(token: string): Array<{ term: string; stripped: boolean }> {
  if (!hasHebrew(token) || token.includes("-")) return [];
  const out = new Map<string, boolean>();
  const add = (term: string, stripped: boolean) => {
    if (!out.has(term) || !stripped) out.set(term, stripped && (out.get(term) ?? true));
  };
  prefixVariants(token).forEach((v, i) => {
    const stripped = i > 0;
    const k = ktivKey(v);
    if (k && (!stripped || k.length >= 3)) add(KTIV + k, stripped);
    for (const l of lemmaKeys(v)) if (!stripped || l.length >= 3) add(LEMMA + l, stripped);
  });
  return [...out].map(([term, stripped]) => ({ term, stripped }));
}

/** The morphology terms of one comparison form, as index terms. */
export function morphTerms(token: string): string[] {
  return morphForms(token).map((m) => m.term);
}

/** Stem terms by surface form: words repeat across a vault, their stems are computed once (bounded). */
const stemCache = new Map<string, string[]>();
const STEM_CACHE_MAX = 50_000;

/** The parts of a hyphenated word worth a term of their own (a lone letter is not; a digit is). */
export function hyphenParts(token: string): string[] {
  if (!token.includes("-")) return [];
  return token.split("-").filter((p) => p.length >= 2 || /\d/.test(p));
}

/**
 * Every term of a document: surface forms, the parts of hyphenated words
 * as surface forms too (so "mail" finds "e-mail", "100" finds "מ-100"),
 * and the stems of its Hebrew words.
 */
export function documentTerms(text: string): string[] {
  const out: string[] = [];
  for (const t of surfaceTokens(text)) {
    out.push(t);
    for (const p of hyphenParts(t)) out.push(p);
    let stems = stemCache.get(t);
    if (!stems) {
      stems = [...stemTerms(t), ...morphTerms(t)];
      if (stemCache.size >= STEM_CACHE_MAX) stemCache.clear();
      stemCache.set(t, stems);
    }
    for (const s of stems) out.push(s);
  }
  return out;
}

/** Topic-free words a query may start with or carry (comparison forms). */
const QUERY_STOP = new Set(
  [
    // Hebrew: question words, prepositions, pronouns, copulas
    "מה", "מי", "מתי", "איפה", "היכן", "איך", "כיצד", "למה", "מדוע", "כמה", "איזה", "איזו", "אילו", "האם",
    // ...and with the prefix letters they usually carry
    "מהו", "מהי", "מהם", "מהן", "למי", "ממי", "באיזה", "באיזו", "באילו", "לאיזה", "לאיזו", "מאיזה", "מאיזו", "בכמה", "לכמה", "ומה", "ומי",
    "של", "את", "על", "אל", "עם", "בין", "לפי", "אחרי", "לפני", "גם", "או", "כי", "אם", "לא", "יש", "אין",
    "הוא", "היא", "הם", "הן", "זה", "זו", "זאת", "אלה", "היה", "היתה", "הייתה", "היו", "שם", "כל", "אשר",
    // English
    "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "was", "were", "what", "who",
    "when", "where", "which", "how", "why", "does", "did", "do",
  ].map(normalizeForMatch),
);

export interface QueryTerm {
  term: string;
  /** Weight of this term in the score (exact forms 1, stems less). */
  weight: number;
  /**
   * The query word this term stands for: a document scores each word once,
   * by its best form (the exact word, or a prefix-less stem), so a note
   * with the exact word does not also collect its stem.
   */
  group: number;
}

/** Stem terms count this much of an exact match. */
export const STEM_WEIGHT = 0.6;
/**
 * A full/defective spelling key (W2.11): the same word in the other
 * spelling, so nearly an exact match — but not quite, since the key also
 * joins words that only share their consonants (שעור / שער).
 */
export const KTIV_WEIGHT = 0.85;
/** A lemma key (W2.11): another inflection of the word. */
export const LEMMA_WEIGHT = 0.45;
/** A synonym of the query word (W2.11). */
export const SYNONYM_WEIGHT = 0.5;
/** An English equivalent of a Hebrew query word (W2.11): an English note on the topic comes after the Hebrew ones. */
export const ENGLISH_WEIGHT = 0.2;

/**
 * The terms of a query with their weights. Function words are dropped
 * unless the query is nothing but function words.
 */
export function queryTerms(query: string): QueryTerm[] {
  const all = surfaceTokens(query);
  const content = all.filter((t) => !QUERY_STOP.has(t));
  const tokens = content.length ? content : all;
  const out: QueryTerm[] = [];
  const seen = new Set<string>();
  let group = 0;
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    const terms: QueryTerm[] = [
      { term: t, weight: 1, group },
      // A hyphenated query word also matches its parts, as a weaker form.
      ...hyphenParts(t).map((p) => ({ term: p, weight: STEM_WEIGHT, group })),
      ...stemTerms(t).map((s) => ({ term: s, weight: STEM_WEIGHT, group })),
      ...morphForms(t).map((m) => ({ term: m.term, weight: (m.term.startsWith(KTIV) ? KTIV_WEIGHT : LEMMA_WEIGHT) * (m.stripped ? STEM_WEIGHT : 1), group })),
    ];
    // W2.11: synonyms and English equivalents, of the word and of its prefix-less forms.
    for (const v of hasHebrew(t) ? prefixVariants(t) : [t]) {
      for (const syn of synonymsOf(v)) {
        terms.push({ term: syn, weight: SYNONYM_WEIGHT, group });
        for (const s of stemTerms(syn)) terms.push({ term: s, weight: SYNONYM_WEIGHT * STEM_WEIGHT, group });
      }
      for (const en of englishOf(v)) terms.push({ term: en, weight: ENGLISH_WEIGHT, group });
    }
    // One term once per word, at its best weight.
    const best = new Map<string, QueryTerm>();
    for (const q of terms) if ((best.get(q.term)?.weight ?? -1) < q.weight) best.set(q.term, q);
    out.push(...best.values());
    group++;
  }
  return out;
}
