/**
 * Error rates for the public benchmark harness (plan W11.H5).
 *
 * Corpus-level ("micro") WER and CER are what the ivrit.ai leaderboard and
 * FLEURS papers report: total edits over total reference tokens, not the
 * mean of per-item rates. The median of per-item CER is reported next to it
 * for the handwriting benchmark (W11.H14), whose card lists both.
 */

/** Levenshtein distance between two token sequences (substitution, insertion, deletion all cost 1). */
export function editDistance<T>(a: readonly T[], b: readonly T[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1);
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

export const words = (s: string): string[] => s.split(/\s+/).filter(Boolean);
/** Characters of the normalised text, spaces included (single spaces after normalisation), as code points. */
export const chars = (s: string): string[] => Array.from(s.trim());

export interface Pair {
  ref: string;
  hyp: string;
}

export interface ErrorCounts {
  edits: number;
  refTokens: number;
}

export function countWords(p: Pair): ErrorCounts {
  const r = words(p.ref);
  return { edits: editDistance(r, words(p.hyp)), refTokens: r.length };
}

export function countChars(p: Pair): ErrorCounts {
  const r = chars(p.ref);
  return { edits: editDistance(r, chars(p.hyp)), refTokens: r.length };
}

/** Total edits / total reference tokens. An empty reference set gives NaN, never 0: no data is not a perfect score. */
export function microRate(counts: readonly ErrorCounts[]): number {
  let e = 0;
  let n = 0;
  for (const c of counts) {
    e += c.edits;
    n += c.refTokens;
  }
  return n === 0 ? Number.NaN : e / n;
}

export const wer = (pairs: readonly Pair[]): number => microRate(pairs.map(countWords));
export const cer = (pairs: readonly Pair[]): number => microRate(pairs.map(countChars));

export function median(xs: readonly number[]): number {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Per-item CER (an empty reference with an empty hypothesis is 0, with any hypothesis 1). */
export function itemCer(p: Pair): number {
  const c = countChars(p);
  return c.refTokens === 0 ? (chars(p.hyp).length ? 1 : 0) : c.edits / c.refTokens;
}

/** Round to 4 decimals for result files, so a rerun with the same inputs writes the same bytes. */
export const r4 = (x: number): number => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x);
