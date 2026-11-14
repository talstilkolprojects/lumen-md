/**
 * DictaBERT-char-menaked (plan W2.5): the input and output side of Dicta's
 * character-level niqqud model, as a "high quality" layer above Nakdimon.
 * Pure: the model runs in src/ai/nikud.worker.ts (onnxruntime-web) or in
 * the eval harness (onnxruntime-node).
 *
 * The model reads one token per character ([CLS] c1 … cn [SEP]) and
 * predicts, per character, a niqqud class (a set of marks: vowel, with or
 * without dagesh) and a shin/sin class. The exact vocabulary, class lists
 * and tensor names come with the converted model as `menaked.json`
 * (scripts/models/export-menaked.py writes it from the checkpoint's own
 * config and tokenizer), so nothing here guesses them.
 *
 * DictaBERT-char-menaked © DICTA: The Israel Center for Text Analysis,
 * CC BY 4.0 (attribution in models/registry.json).
 */
import { canDagesh, canNiqqud, canSin } from "./nikud";
import { combineHeads, softmaxAt, topClasses, type LetterOption } from "./nikudAlt";

/** menaked.json, written next to the ONNX file by the export script. */
export interface MenakedSpec {
  /** Character → token id (the tokenizer's vocab.txt, one character per token). */
  vocab: Record<string, number>;
  cls: number;
  sep: number;
  pad: number;
  unk: number;
  /** The niqqud classes, in the head's order: each a string of combining marks, or a special label such as "<MAT_LECT>". */
  nikudClasses: string[];
  /** The shin/sin classes, in the head's order. */
  shinClasses: string[];
  /** Longest input in tokens, [CLS] and [SEP] included (512 for BERT). */
  maxTokens: number;
  /** ONNX input and output names. */
  inputs: { ids: string; mask: string; types?: string };
  outputs: { nikud: string; shin: string };
}

const DAGESH = "ּ";
const SHIN_DOTS = /[ׁׂ]/g;
/** Combining marks the model may write; anything else in a class label (a special label) writes nothing. */
const MARK = /^[ְ-ׇֽֿׁׂ]+$/;

/** Check a spec read from the network before using it. */
export function parseMenakedSpec(raw: unknown): MenakedSpec {
  const s = raw as Partial<MenakedSpec> | null;
  const ok =
    !!s &&
    typeof s.vocab === "object" &&
    [s.cls, s.sep, s.pad, s.unk, s.maxTokens].every((n) => Number.isInteger(n)) &&
    Array.isArray(s.nikudClasses) &&
    Array.isArray(s.shinClasses) &&
    typeof s.inputs?.ids === "string" &&
    typeof s.inputs?.mask === "string" &&
    typeof s.outputs?.nikud === "string" &&
    typeof s.outputs?.shin === "string";
  if (!ok) throw new Error("menaked.json: not a DictaBERT-char-menaked spec");
  return s as MenakedSpec;
}

/** Token ids and attention mask for a batch of chunks, [CLS] … [SEP], padded to the longest (int64, as BERT exports take). */
export function encodeMenaked(batch: readonly string[], spec: MenakedSpec): { ids: BigInt64Array; mask: BigInt64Array; length: number } {
  const length = Math.max(...batch.map((s) => s.length)) + 2;
  const ids = new BigInt64Array(batch.length * length).fill(BigInt(spec.pad));
  const mask = new BigInt64Array(batch.length * length);
  batch.forEach((s, r) => {
    const at = r * length;
    ids[at] = BigInt(spec.cls);
    mask[at] = 1n;
    for (let i = 0; i < s.length; i++) {
      ids[at + 1 + i] = BigInt(spec.vocab[s[i]] ?? spec.unk);
      mask[at + 1 + i] = 1n;
    }
    ids[at + 1 + s.length] = BigInt(spec.sep);
    mask[at + 1 + s.length] = 1n;
  });
  return { ids, mask, length };
}

/** The marks a class writes on `letter`: only real marks, a dagesh only where one can stand, no shin dot (the shin head says that). */
export function classMarks(label: string, letter: string): string {
  if (!MARK.test(label)) return "";
  let m = label.replace(SHIN_DOTS, "");
  if (!canDagesh(letter)) m = m.split(DAGESH).join("");
  if (!canNiqqud(letter)) m = m.replace(/[^ּ]/g, "");
  // Nakdimon's order on a letter: dagesh first, then the vowel.
  return m.includes(DAGESH) ? DAGESH + m.split(DAGESH).join("") : m;
}

export interface MenakedLogits {
  /** [rows, length, nikudClasses.length] */
  nikud: ArrayLike<number>;
  /** [rows, length, shinClasses.length] */
  shin: ArrayLike<number>;
}

/**
 * One chunk's pointed text and its letters' options. Position i of the
 * chunk is token i + 1 (after [CLS]). The first option of every letter is
 * what the text carries.
 */
export function decodeMenaked(chunk: string, logits: MenakedLogits, row: number, length: number, spec: MenakedSpec): { text: string; options: Array<LetterOption[] | undefined>; unsure: boolean[] } {
  const nN = spec.nikudClasses.length;
  const nS = spec.shinClasses.length;
  let text = "";
  const options: Array<LetterOption[] | undefined> = [];
  const unsure: boolean[] = [];
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i];
    text += c;
    if (!/[א-ת]/.test(c)) {
      options.push(undefined);
      unsure.push(false);
      continue;
    }
    const at = row * length + i + 1;
    const nProbs = softmaxAt(logits.nikud, at, nN);
    const nikud = topClasses(nProbs, 2, 0).map(({ k, p }) => ({ marks: classMarks(spec.nikudClasses[k] ?? "", c), p }));
    const shin = canSin(c) ? topClasses(softmaxAt(logits.shin, at, nS), 2, 0).map(({ k, p }) => ({ marks: (spec.shinClasses[k] ?? "").replace(/[^ׁׂ]/g, ""), p })) : [];
    // Dagesh first, then the shin dot, then the vowel (Nakdimon's order; canonicalMarks sorts the same way).
    const opts = combineHeads([shin, nikud]).map((o) => {
      const d = o.marks.includes(DAGESH) ? DAGESH : "";
      return { marks: d + o.marks.replace(DAGESH, ""), p: o.p };
    });
    options.push(opts);
    text += opts[0]?.marks ?? "";
    // As in Nakdimon's partial mode: unsure when the best vowel leads the next by less than half.
    const [a, b] = topClasses(nProbs, 2, 0);
    unsure.push(!!b && a.p - b.p < 0.5);
  }
  return { text, options, unsure };
}
