/**
 * Enhanced Semantic Search — BM25+ with n-gram support.
 * 
 * Upgrades over the base TF-IDF: 
 * - BM25+ ranking (better for long documents)
 * - Bigram support for phrase matching
 * - Stopword filtering for Hebrew + English
 * - Query expansion with synonyms
 * - Fuzzy matching via Levenshtein distance
 */

import { stripNiqqud } from "../text/hebrew";

// ── Stopwords (EN + HE) ────────────────────────────────────────────────

const EN_STOPWORDS = new Set([
  "the", "be", "to", "of", "and", "a", "in", "that", "have", "i", "it",
  "for", "not", "on", "with", "he", "as", "you", "do", "at", "this",
  "but", "his", "by", "from", "they", "we", "say", "her", "she", "or",
  "an", "will", "my", "one", "all", "would", "there", "their", "what",
  "so", "up", "out", "if", "about", "who", "get", "which", "go", "me",
  "when", "make", "can", "like", "time", "no", "just", "him", "know",
  "take", "people", "into", "year", "your", "good", "some", "could",
  "them", "see", "other", "than", "then", "now", "look", "only", "come",
  "its", "over", "think", "also", "back", "after", "use", "two", "how",
  "our", "work", "first", "well", "way", "even", "new", "want", "because",
  "any", "these", "give", "day", "most", "us", "is", "was", "are", "been",
  "has", "had", "did", "does", "were", "being", "am",
]);

const HE_STOPWORDS = new Set([
  "של", "את", "על", "עם", "זה", "הוא", "היא", "הם", "הן", "אני",
  "אתה", "אתם", "שלי", "שלו", "שלה", "שלנו", "שלהם", "כי", "אם",
  "אבל", "גם", "או", "כל", "מה", "למה", "איך", "מי", "כמה", "היה",
  "היו", "יהיה", "אין", "יש", "לא", "כן", "עוד", "רק", "אחרי",
  "לפני", "בין", "תחת", "מעל", "בתוך",
]);

const ALL_STOPWORDS = new Set([...EN_STOPWORDS, ...HE_STOPWORDS]);

// ── Enhanced Tokenizer ──────────────────────────────────────────────────

export function tokenize(text: string): string[] {
  // Niqqud and cantillation first: as non-letters they would split a
  // pointed word into fragments ("שָׁלוֹם" → "ש", "לו", "ם").
  return stripNiqqud(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && w.length < 40 && !ALL_STOPWORDS.has(w));
}

/** Generate bigrams from tokens */
export function bigrams(tokens: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    result.push(`${tokens[i]}_${tokens[i + 1]}`);
  }
  return result;
}

/** Tokenize with bigrams for better phrase matching */
export function tokenizeWithBigrams(text: string): string[] {
  const unigrams = tokenize(text);
  const bi = bigrams(unigrams);
  return [...unigrams, ...bi];
}

// ── BM25+ Parameters ───────────────────────────────────────────────────

const K1 = 1.5;  // Term frequency saturation
const B = 0.75;   // Length normalization
const DELTA = 1;  // BM25+ floor (prevents zero contribution)

// ── BM25+ Index ─────────────────────────────────────────────────────────

export interface BM25Doc {
  path: string;
  tokens: string[];
  length: number;
  snippet: string;
}

export interface BM25Index {
  docs: BM25Doc[];
  df: Map<string, number>;      // Document frequency per term
  avgDL: number;                  // Average document length
  N: number;                      // Total number of documents
  builtAt: number;
}

/** Build a BM25+ index from documents */
export function buildBM25Index(
  rawDocs: { path: string; content: string }[],
): BM25Index {
  const docs: BM25Doc[] = rawDocs.map((doc) => {
    const tokens = tokenizeWithBigrams(doc.content);
    return {
      path: doc.path,
      tokens,
      length: tokens.length,
      snippet: doc.content.slice(0, 300).replace(/\s+/g, " ").trim(),
    };
  });

  const N = docs.length;
  const avgDL = docs.reduce((sum, d) => sum + d.length, 0) / (N || 1);

  // Compute document frequency
  const df = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set<string>();
    for (const token of doc.tokens) {
      if (!seen.has(token)) {
        seen.add(token);
        df.set(token, (df.get(token) ?? 0) + 1);
      }
    }
  }

  return { docs, df, avgDL, N, builtAt: Date.now() };
}

/** Compute BM25+ score for a document given query terms */
export function bm25Score(
  doc: BM25Doc,
  queryTokens: string[],
  index: BM25Index,
): number {
  let score = 0;

  // Build term frequency map for this document
  const tf = new Map<string, number>();
  for (const token of doc.tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }

  for (const term of queryTokens) {
    const termFreq = tf.get(term) ?? 0;
    if (termFreq === 0) continue;

    const docFreq = index.df.get(term) ?? 0;
    const idf = Math.log((index.N - docFreq + 0.5) / (docFreq + 0.5) + 1);

    // BM25+ formula (with delta floor to prevent zero contribution)
    const norm = termFreq * (K1 + 1) / (termFreq + K1 * (1 - B + B * doc.length / index.avgDL));
    score += idf * (norm + DELTA);
  }

  return score;
}

/** Search with BM25+ ranking */
export function bm25Search(
  query: string,
  index: BM25Index,
  topK = 10,
): { path: string; score: number; snippet: string }[] {
  const queryTokens = tokenizeWithBigrams(query);

  return index.docs
    .map((doc) => ({
      path: doc.path,
      score: bm25Score(doc, queryTokens, index),
      snippet: doc.snippet,
    }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ── Fuzzy Matching ──────────────────────────────────────────────────────

/** Levenshtein distance for fuzzy matching */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Find fuzzy matches from a vocabulary */
export function fuzzyMatch(
  term: string,
  vocab: Set<string>,
  maxDistance = 2,
): string[] {
  const results: string[] = [];
  for (const word of vocab) {
    if (Math.abs(word.length - term.length) > maxDistance) continue;
    if (levenshteinDistance(term, word) <= maxDistance) {
      results.push(word);
    }
  }
  return results;
}
