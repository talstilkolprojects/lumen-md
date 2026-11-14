/**
 * Niqqud on the Nakdimon test set (plan W11.H10), with the paper's metrics
 * (Gershuni & Pinter, "Restoring Hebrew Diacritics Without a Dictionary",
 * Findings of NAACL 2022):
 * - DEC: decisions — per Hebrew letter, the vowel point, the dagesh/mappiq
 *   and (for ש) the shin/sin dot are separate decisions; the share right.
 * - CHA: characters — letters whose decisions are all right.
 * - WOR: words — words whose letters are all right.
 * (VOC, the paper's pronunciation-equivalent word score, needs its
 * equivalence table and is not implemented here; it is not reported.)
 *
 * Format "nakdimon-test": the repository's test texts (elazarg/nakdimon,
 * tests/<corpus>/<source>/*.txt), UTF-8 dotted Hebrew. Each non-empty line
 * is an item. The input to the model is the line with every point removed.
 */
import { r4 } from "../metrics";

export interface NikudItem {
  id: string;
  /** Dotted gold text. */
  gold: string;
}

export interface NikudEngine {
  id: string;
  /** Dot undotted text; must return the same letters in the same order. */
  dot(text: string): Promise<string>;
}

const LETTER = /[א-ת]/;
const DAGESH = "ּ";
const SHIN = "ׁ";
const SIN = "ׂ";
/** Vowel points (sheva … qubuts, holam haser for vav, qamats qatan). */
const VOWEL = /[ְ-ׇֻ]/;
/** Letters that take no dagesh (gutturals and resh). ה takes mappiq, written with the same point. */
const NO_DAGESH = new Set(["א", "ח", "ע", "ר"]);
const POINTS = /[֑-ׇ]/g;

export const undot = (s: string): string => s.normalize("NFD").replace(POINTS, "").normalize("NFC");

export function parseNakdimonTest(files: Record<string, string>): NikudItem[] {
  const out: NikudItem[] = [];
  for (const name of Object.keys(files).sort()) {
    files[name].split(/\r?\n/).forEach((line, i) => {
      if (line.trim() && LETTER.test(line)) out.push({ id: `${name}#${i + 1}`, gold: line.trim() });
    });
  }
  return out;
}

interface Letter {
  ch: string;
  vowel: string;
  dagesh: boolean;
  dot: string;
  word: number;
}

/** The letters of a dotted text with their decisions; non-letters only advance the word counter. */
export function letters(text: string): Letter[] {
  const out: Letter[] = [];
  let word = 0;
  let inWord = false;
  for (const ch of Array.from(text.normalize("NFD"))) {
    if (LETTER.test(ch)) {
      if (!inWord) {
        word++;
        inWord = true;
      }
      out.push({ ch, vowel: "", dagesh: false, dot: "", word });
    } else if (out.length && /[֑-ׇ]/.test(ch) && inWord) {
      const l = out[out.length - 1];
      if (ch === DAGESH) l.dagesh = true;
      else if (ch === SHIN || ch === SIN) l.dot = ch;
      else if (VOWEL.test(ch)) l.vowel += ch;
    } else if (/\s/.test(ch)) inWord = false;
    // Other characters (geresh, digits, Latin) are kept in the word but carry no decision.
  }
  return out;
}

export interface NikudScore {
  n: number;
  metrics: { dec: number; cha: number; wor: number };
  /** Items whose prediction changed the letters: all their decisions count as wrong. */
  misaligned: string[];
}

export function compareNikud(gold: string, pred: string): { dec: [number, number]; cha: [number, number]; wor: [number, number]; aligned: boolean } {
  const g = letters(gold);
  const p = letters(pred);
  const aligned = g.length === p.length && g.every((l, i) => l.ch === p[i].ch);
  let decOk = 0;
  let decN = 0;
  let chaOk = 0;
  const wordOk = new Map<number, boolean>();
  g.forEach((gl, i) => {
    const pl = aligned ? p[i] : undefined;
    let all = true;
    const decide = (right: boolean) => {
      decN++;
      if (right) decOk++;
      else all = false;
    };
    decide(pl !== undefined && [...pl.vowel].sort().join("") === [...gl.vowel].sort().join(""));
    if (!NO_DAGESH.has(gl.ch)) decide(pl !== undefined && pl.dagesh === gl.dagesh);
    if (gl.ch === "ש") decide(pl !== undefined && pl.dot === gl.dot);
    if (all) chaOk++;
    wordOk.set(gl.word, (wordOk.get(gl.word) ?? true) && all);
  });
  const words = [...wordOk.values()];
  return { dec: [decOk, decN], cha: [chaOk, g.length], wor: [words.filter(Boolean).length, words.length], aligned };
}

export async function scoreNikud(items: readonly NikudItem[], engine: NikudEngine): Promise<NikudScore> {
  const tot = { dec: [0, 0], cha: [0, 0], wor: [0, 0] };
  const misaligned: string[] = [];
  for (const it of items) {
    const pred = await engine.dot(undot(it.gold));
    const c = compareNikud(it.gold, pred);
    if (!c.aligned) misaligned.push(it.id);
    for (const k of ["dec", "cha", "wor"] as const) {
      tot[k][0] += c[k][0];
      tot[k][1] += c[k][1];
    }
  }
  const rate = ([ok, n]: number[]) => r4(n ? ok / n : Number.NaN);
  return { n: items.length, metrics: { dec: rate(tot.dec), cha: rate(tot.cha), wor: rate(tot.wor) }, misaligned };
}
