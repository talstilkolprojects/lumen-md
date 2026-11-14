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
 */

import { hasHebrew, normalizeForMatch, prefixVariants, words } from "./hebrew";

export const STEM = "~";

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
  } else {
    out.add(STEM + token);
    for (const part of hyphenParts(token)) {
      out.add(STEM + part);
      if (hasHebrew(part)) for (const v of prefixVariants(part)) out.add(STEM + v);
    }
  }
  return [...out];
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
      stems = stemTerms(t);
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
    out.push(
      { term: t, weight: 1, group },
      // A hyphenated query word also matches its parts, as a weaker form.
      ...hyphenParts(t).map((p) => ({ term: p, weight: STEM_WEIGHT, group })),
      ...stemTerms(t).map((s) => ({ term: s, weight: STEM_WEIGHT, group })),
    );
    group++;
  }
  return out;
}
