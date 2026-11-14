/**
 * Numbers for the model benchmark (plan 7.8): latency percentiles and the
 * error rates of text outputs. Plain JavaScript, shared by
 * scripts/bench-models.mjs and its tests.
 */

/** The p-th percentile (0–100) of a list, nearest-rank; null for an empty list. */
export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length, Math.max(1, rank)) - 1];
}

export const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Levenshtein distance between two sequences (strings or arrays). */
export function editDistance(a, b) {
  const m = b.length;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[m];
}

// Niqqud and cantillation, but not the maqaf (U+05BE), which joins words and must split them.
// (scripts/golden/evals/asr-he.mjs on feat/live-dictation strips the maqaf with the marks first, so
// there "בית־ספר" counts as one word; the set's own rule says it splits.)
const MARKS = /[\u0591-\u05BD\u05BF-\u05C7]/g;

/** OCR text for CER: NFC, one space between words, trimmed. Niqqud is kept (the nikud lines are scored with it). */
export const normalizeOcr = (t) => String(t ?? "").normalize("NFC").replace(/\s+/g, " ").trim();

/**
 * Speech text for WER / CER — the rules of the asr-he set (scripts/golden/evals/asr-he.mjs, plan 6.1):
 * NFC, no niqqud or cantillation, maqaf and dashes split words, no punctuation, lower case.
 */
export function normalizeAsr(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(MARKS, "")
    .normalize("NFC")
    .replace(/[\u05BE\-\u2010-\u2015]/g, " ")
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Accumulates edits over reference length (micro average), for CER or WER. */
export function errorRate() {
  let edits = 0;
  let length = 0;
  return {
    add(ref, hyp) {
      edits += editDistance(ref, hyp);
      length += ref.length;
    },
    get value() {
      return length ? edits / length : null;
    },
  };
}
