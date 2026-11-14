/**
 * Niqqud alternatives per word (plan W2.5), the way Dicta's Nakdan offers
 * them: every Hebrew letter gets a short list of mark sets with their
 * probabilities (from whichever model pointed the text), and a word's
 * alternatives are the most probable combinations of its letters' options.
 * The first alternative is the model's own reading. Pure; no model here.
 */
import { DAGESH_TABLE, NIQQUD_TABLE, RAFE, SIN_TABLE, canDagesh, canNiqqud, canSin, sameSkeleton } from "./nikud";

/** One way to point one letter: the marks after it, and how likely the model finds them. */
export interface LetterOption {
  marks: string;
  p: number;
}

/** One reading of a word, with its probability (the product of its letters' options). */
export interface Alternative {
  text: string;
  p: number;
}

/** A pointed word in the output text, [from, to) in UTF-16 units, with its readings (the first is the one in the text). */
export interface WordAlternatives {
  from: number;
  to: number;
  alternatives: Alternative[];
}

/** Softmax of `classes` logits at position `pos`. */
export function softmaxAt(data: ArrayLike<number>, pos: number, classes: number): number[] {
  let max = -Infinity;
  for (let k = 0; k < classes; k++) max = Math.max(max, data[pos * classes + k]);
  const out = new Array<number>(classes);
  let sum = 0;
  for (let k = 0; k < classes; k++) sum += out[k] = Math.exp(data[pos * classes + k] - max);
  for (let k = 0; k < classes; k++) out[k] /= sum;
  return out;
}

/** The `top` most probable classes (index 0, the padding mask, never), most probable first. */
export function topClasses(probs: readonly number[], top: number, from = 1): Array<{ k: number; p: number }> {
  const all: Array<{ k: number; p: number }> = [];
  for (let k = from; k < probs.length; k++) all.push({ k, p: probs[k] });
  return all.sort((a, b) => b.p - a.p).slice(0, top);
}

/** Options below this probability are dropped (they would never make a useful alternative). */
export const MIN_OPTION_P = 0.02;

/**
 * Combine independent per-head choices (vowel × dagesh × shin dot) into a
 * letter's options, most probable first. Each head contributes the marks of
 * a choice; a choice the letter cannot carry contributes nothing.
 */
export function combineHeads(heads: ReadonlyArray<ReadonlyArray<{ marks: string; p: number }>>, max = 4, minP = MIN_OPTION_P): LetterOption[] {
  let out: LetterOption[] = [{ marks: "", p: 1 }];
  for (const h of heads) {
    if (!h.length) continue;
    const next: LetterOption[] = [];
    for (const a of out) for (const c of h) next.push({ marks: a.marks + c.marks, p: a.p * c.p });
    out = next;
  }
  // The same mark set reached twice (two classes that both write nothing): add their probabilities.
  const merged = new Map<string, number>();
  for (const o of out) merged.set(o.marks, (merged.get(o.marks) ?? 0) + o.p);
  const list = [...merged].map(([marks, p]) => ({ marks, p })).sort((a, b) => b.p - a.p);
  return list.filter((o, i) => i === 0 || o.p >= minP).slice(0, max);
}

/**
 * Nakdimon's options for the letter at `at`: the top two classes of each of
 * its three heads (vowel 16, dagesh 3, shin dot 4), in Nakdimon's mark
 * order (dagesh, shin dot, vowel), marks the letter cannot carry dropped.
 * The first option is exactly what decodeChunk writes.
 */
export function nakdimonOptions(letter: string, logits: { N: ArrayLike<number>; D: ArrayLike<number>; S: ArrayLike<number> }, at: number): LetterOption[] {
  const head = (data: ArrayLike<number>, classes: number, table: readonly string[], allowed: boolean) => {
    if (!allowed) return [];
    return topClasses(softmaxAt(data, at, classes), 2).map(({ k, p }) => ({ marks: (table[k] ?? "").split(RAFE).join(""), p }));
  };
  return combineHeads([head(logits.D, 3, DAGESH_TABLE, canDagesh(letter)), head(logits.S, 4, SIN_TABLE, canSin(letter)), head(logits.N, 16, NIQQUD_TABLE, canNiqqud(letter))]);
}

const IS_LETTER = /[א-ת]/;

/**
 * The `k` most probable readings of one word. `chars` is the plain word
 * (letters and the odd geresh); `options[i]` the options of `chars[i]`
 * (ignored for a character that is not a letter). Beam search: a word of
 * n letters with two options each has 2^n readings, and only the best few
 * matter. Every reading keeps the word's consonants (the validator).
 */
export function wordAlternatives(chars: string, options: ReadonlyArray<readonly LetterOption[] | undefined>, k = 5): Alternative[] {
  let beams: Alternative[] = [{ text: "", p: 1 }];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const opts = IS_LETTER.test(c) && options[i]?.length ? options[i]! : [{ marks: "", p: 1 }];
    const next: Alternative[] = [];
    for (const b of beams) for (const o of opts) next.push({ text: b.text + c + o.marks, p: b.p * o.p });
    beams = next.sort((a, b) => b.p - a.p).slice(0, k * 2);
  }
  const seen = new Set<string>();
  return beams
    .filter((a) => sameSkeleton(a.text, chars) && !seen.has(a.text) && seen.add(a.text))
    .slice(0, k);
}

/** A word is ambiguous when its second reading is at least `ratio` as likely as its first. */
export function isAmbiguous(alts: readonly Alternative[], ratio = 0.25): boolean {
  return alts.length > 1 && alts[1].p >= ratio * alts[0].p;
}
