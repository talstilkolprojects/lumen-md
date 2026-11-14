/**
 * Hebrew niqqud (vowel points) — the text side of plan 6.3: Nakdimon's
 * character tables and its input / output processing, ported from
 * nakdimon/hebrew.py and dataset.py (MIT, © 2022 Elazar Gershuni,
 * https://github.com/elazarg/nakdimon at a06ebfd). The model itself runs in
 * src/ai/nikud.worker.ts; everything here is pure and runs anywhere.
 *
 * Nakdimon reads one id per character and predicts, for every Hebrew
 * letter, three things: a vowel (16 classes), a dagesh (3) and a shin/sin
 * dot (4). Index 0 of every table is the padding mask.
 */

export const RAFE = "ֿ";
const DAGESH_LETTER = "ּ";
const SHIN_YEMANIT = "ׁ";
const SHIN_SMALIT = "ׂ";

const HEBREW_LETTERS = Array.from({ length: 0x05ea - 0x05d0 + 1 }, (_, i) => String.fromCharCode(0x05d0 + i));
/** The vowel classes, in the model's order (PATAKH appears twice, as in the original). */
const NIQQUD = [RAFE, ...Array.from({ length: 0x05bc - 0x05b0 + 1 }, (_, i) => String.fromCharCode(0x05b0 + i)), "ַ"];
const NIQQUD_SIN = [RAFE, SHIN_YEMANIT, SHIN_SMALIT];
const DAGESH = [RAFE, DAGESH_LETTER];
const VALID_LETTERS = [" ", "!", '"', "'", "(", ")", ",", "-", ".", ":", ";", "?", ...HEBREW_LETTERS];
const SPECIAL_TOKENS = ["H", "O", "5"];

const table = (chars: string[]) => ["", ...chars];
export const LETTERS_TABLE = table([...SPECIAL_TOKENS, ...VALID_LETTERS]);
export const NIQQUD_TABLE = table(NIQQUD);
export const DAGESH_TABLE = table(DAGESH);
export const SIN_TABLE = table(NIQQUD_SIN);
const LETTER_ID = new Map(LETTERS_TABLE.map((c, i) => [c, i]));
const VALID = new Set(VALID_LETTERS);

/** Every mark Nakdimon reads or writes (vowels, dagesh, shin/sin dots, rafe, qamats qatan). */
export const NIKUD_MARKS = /[ְ-ׇֽֿׁׂ]/g;

const CAN_DAGESH = new Set("בגדהוזטיכלמנספצקשתךף");
const CAN_NIQQUD = new Set("אבגדהוזחטיכלמנסעפצקרשתךן");
export const canDagesh = (c: string) => CAN_DAGESH.has(c);
export const canSin = (c: string) => c === "ש";
export const canNiqqud = (c: string) => CAN_NIQQUD.has(c);

/** hebrew.normalize(): the character the model sees. */
export function normalizeChar(c: string): string {
  if (VALID.has(c)) return c;
  if (c === "\n" || c === "\t") return " ";
  if ("־‒–—―−".includes(c)) return "-";
  if (c === "[") return "(";
  if (c === "]") return ")";
  if ("´‘’".includes(c)) return "'";
  if ("“”״".includes(c)) return '"';
  if (/^\p{Nd}$/u.test(c)) return "5";
  if (c === "…") return ",";
  if ("ײװױ".includes(c)) return "H";
  return "O";
}

/** Text without niqqud (hebrew.remove_niqqud; also the meteg, which Nakdimon never writes). */
export function removeNikud(text: string): string {
  return text.replace(NIKUD_MARKS, "");
}

/**
 * The consonant skeleton: the text without its points and cantillation
 * (maqaf, paseq and sof pasuq are punctuation and stay). The validator
 * (6.3.4) compares these.
 */
export function skeleton(text: string): string {
  return text.normalize("NFD").replace(/[֑-ׇֽֿׁׂׅׄ]/g, "").normalize("NFC");
}

export function sameSkeleton(a: string, b: string): boolean {
  return skeleton(a) === skeleton(b);
}

/**
 * Input chunks the way Nakdimon splits them (hebrew.split_by_length): at
 * most `maxlen - 1` characters, cut after the last space. Their
 * concatenation is the input, character for character (UTF-16 units: every
 * character the model sees is in the BMP; anything else becomes "O" twice).
 */
export function chunks(text: string, maxlen = 100): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let space = maxlen;
  for (const c of text) {
    for (const unit of c.length > 1 ? c.split("") : [c]) {
      if (unit === " ") space = cur.length;
      cur.push(unit);
      if (cur.length === maxlen - 1) {
        out.push(cur.slice(0, space + 1).join(""));
        cur = cur.slice(space + 1);
        space = maxlen;
      }
    }
  }
  if (cur.length) out.push(cur.join(""));
  return out;
}

/** Model input ids for a batch of chunks, padded to the longest (row-major, int32). */
export function encode(batch: string[]): { ids: Int32Array; length: number } {
  const length = Math.max(1, ...batch.map((s) => s.length));
  const ids = new Int32Array(batch.length * length);
  batch.forEach((s, row) => {
    for (let i = 0; i < s.length; i++) ids[row * length + i] = LETTER_ID.get(normalizeChar(s[i])) ?? LETTER_ID.get("O")!;
  });
  return { ids, length };
}

/** argmax over the last axis of a [rows, length, classes] tensor. */
export function argmax(data: ArrayLike<number>, rows: number, length: number, classes: number): Int32Array {
  const out = new Int32Array(rows * length);
  for (let p = 0; p < rows * length; p++) {
    let best = 0;
    let bestV = -Infinity;
    for (let k = 0; k < classes; k++) {
      const v = data[p * classes + k];
      if (v > bestV) {
        bestV = v;
        best = k;
      }
    }
    out[p] = best;
  }
  return out;
}

/** The probability gap between the best and the second-best class at one position. */
export function margin(data: ArrayLike<number>, pos: number, classes: number): number {
  let a = -Infinity;
  let b = -Infinity;
  for (let k = 0; k < classes; k++) {
    const v = data[pos * classes + k];
    if (v > a) {
      b = a;
      a = v;
    } else if (v > b) b = v;
  }
  return a - (b === -Infinity ? 0 : b);
}

export interface Prediction {
  niqqud: Int32Array;
  dagesh: Int32Array;
  sin: Int32Array;
}

/**
 * predict.merge_unconditional for one chunk: each letter, then its dagesh,
 * sin dot and vowel (marks the letter cannot carry are skipped; RAFE is
 * dropped). `row` / `length` locate the chunk in the batch.
 */
export function decodeChunk(text: string, p: Prediction, row: number, length: number): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const t = text[i];
    const at = row * length + i;
    out += t;
    if (canDagesh(t)) out += DAGESH_TABLE[p.dagesh[at]] ?? "";
    if (canSin(t)) out += SIN_TABLE[p.sin[at]] ?? "";
    if (canNiqqud(t)) out += NIQQUD_TABLE[p.niqqud[at]] ?? "";
  }
  return out.split(RAFE).join("");
}

/**
 * Canonical order of the marks on each letter (dagesh, then shin/sin dot,
 * then vowel) — the order Nakdimon writes; references often differ only
 * in order, which must not count as an error.
 */
export function canonicalMarks(text: string): string {
  return text.normalize("NFD").replace(/([א-ת])([ְ-ׇ]+)/g, (_, l: string, marks: string) => {
    const rank = (m: string) => (m === DAGESH_LETTER ? 0 : m === SHIN_YEMANIT || m === SHIN_SMALIT ? 1 : 2);
    return l + [...marks].filter((m) => m !== RAFE).sort((x, y) => rank(x) - rank(y)).join("");
  });
}
