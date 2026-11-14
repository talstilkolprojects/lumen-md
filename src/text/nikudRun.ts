/**
 * Adding niqqud with a Nakdimon-shaped model (plan 6.3), independent of
 * where it runs: the browser worker passes onnxruntime-web, the eval
 * harness onnxruntime-node. `infer` gets int32 ids [rows, length] and
 * returns the three logit tensors.
 */
import { argmax, chunks, decodeChunk, encode, margin, removeNikud, sameSkeleton, canNiqqud } from "./nikud";

export interface Logits {
  /** [rows, length, 16] */
  N: ArrayLike<number>;
  /** [rows, length, 3] */
  D: ArrayLike<number>;
  /** [rows, length, 4] */
  S: ArrayLike<number>;
}

export type Infer = (ids: Int32Array, rows: number, length: number) => Promise<Logits>;

export interface NikudOptions {
  /** Partial niqqud (6.3.5): only words the model is unsure about keep their points. */
  partial?: boolean;
  /** In partial mode: a word is "ambiguous" when some letter's best vowel leads the next by less than this (softmax probability). */
  partialMargin?: number;
  /** Chunks per model call. */
  batch?: number;
  maxlen?: number;
  signal?: AbortSignal;
}

const HEBREW_WORD = /[א-ת][א-תְ-ׇ'"״׳]*/g;

/**
 * Point `text`. Existing points are removed first (the model reads plain
 * letters). Throws when the result's consonant skeleton differs from the
 * input's (the validator, 6.3.4) — that would be a bug, never shown.
 */
export async function addNikud(text: string, infer: Infer, opts: NikudOptions = {}): Promise<string> {
  const plain = removeNikud(text);
  const parts = chunks(plain, opts.maxlen ?? 100);
  const per = opts.batch ?? 16;
  let out = "";
  const unsure: Array<[number, number]> = []; // [start, end) in `plain` of letters the model is unsure about
  let offset = 0;
  for (let b = 0; b < parts.length; b += per) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const batch = parts.slice(b, b + per);
    const { ids, length } = encode(batch);
    const logits = await infer(ids, batch.length, length);
    const pred = {
      niqqud: argmax(logits.N, batch.length, length, 16),
      dagesh: argmax(logits.D, batch.length, length, 3),
      sin: argmax(logits.S, batch.length, length, 4),
    };
    batch.forEach((chunk, row) => {
      out += decodeChunk(chunk, pred, row, length);
      if (opts.partial) {
        const probs = softmaxRows(logits.N, batch.length * length, 16);
        for (let i = 0; i < chunk.length; i++) {
          if (canNiqqud(chunk[i]) && margin(probs, row * length + i, 16) < (opts.partialMargin ?? 0.5)) unsure.push([offset + i, offset + i + 1]);
        }
      }
      offset += chunk.length;
    });
  }
  if (!sameSkeleton(out, plain)) throw new Error("niqqud: the consonants changed");
  return opts.partial ? keepAmbiguousWords(plain, out, unsure) : out;
}

function softmaxRows(data: ArrayLike<number>, positions: number, classes: number): Float32Array {
  const out = new Float32Array(positions * classes);
  for (let p = 0; p < positions; p++) {
    let max = -Infinity;
    for (let k = 0; k < classes; k++) max = Math.max(max, data[p * classes + k]);
    let sum = 0;
    for (let k = 0; k < classes; k++) sum += out[p * classes + k] = Math.exp(data[p * classes + k] - max);
    for (let k = 0; k < classes; k++) out[p * classes + k] /= sum;
  }
  return out;
}

/** The pointed text where a word has an unsure letter; the plain word elsewhere. */
export function keepAmbiguousWords(plain: string, pointed: string, unsure: Array<[number, number]>): string {
  // Map every plain character to its span in the pointed text.
  const starts: number[] = [];
  let j = 0;
  for (let i = 0; i < plain.length; i++) {
    while (j < pointed.length && pointed[j] !== plain[i]) j++;
    starts.push(j);
    j++;
  }
  starts.push(pointed.length);
  const isUnsure = new Uint8Array(plain.length);
  for (const [a, e] of unsure) for (let i = a; i < e; i++) isUnsure[i] = 1;
  let out = "";
  let last = 0;
  for (const m of plain.matchAll(HEBREW_WORD)) {
    const a = m.index!;
    const e = a + m[0].length;
    out += plain.slice(last, a);
    out += isUnsure.subarray(a, e).some((x) => x) ? pointed.slice(starts[a], starts[e]) : m[0];
    last = e;
  }
  return out + plain.slice(last);
}
