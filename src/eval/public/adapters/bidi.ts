/**
 * Unicode bidi conformance (plan W11.H1): the UCD's BidiCharacterTest.txt
 * and BidiTest.txt (UAX #9 §3.4, "Bidi Conformance Testing").
 *
 * What is measured, and by what:
 * - **Paragraph level** (UAX #9 P2–P3) is Lumen's own code: firstStrong()
 *   in src/lib/bidiDirection.ts over the 1 KB strong-class table of plan
 *   9.7 (bidiStrong.generated.ts). That is what the editors use to pick
 *   each line's direction, so it is checked on every BidiCharacterTest row
 *   with paragraph direction "auto" (field 1 = 2), and its explicit rows.
 * - **Levels and visual order** need the whole algorithm (W1–L2), which
 *   Lumen does not implement: the browser lays the line out. They are
 *   checked through a pluggable `UbaEngine` — the CLI uses bidi-js 1.1.0
 *   (MIT, the dev dependency the strong table is generated from) — so the
 *   report says which engine produced them.
 *
 * A row passes when every check that ran on it matched. The report groups
 * the failing rows by category (paragraph level / levels / order) with the
 * first examples of each, and the runner fails (exit 1) under 99.9 %.
 *
 * Formats, as published in the UCD (UAX #9 §3.4):
 * BidiCharacterTest.txt — `cps; dir; paraLevel; levels; order` where cps are
 *   hex code points, dir 0 = LTR, 1 = RTL, 2 = auto, levels are numbers or
 *   "x" (removed by X9), order is the visual order of the non-removed
 *   indices. `#` starts a comment.
 * BidiTest.txt — `@Levels: …` and `@Reorder: …` set the expectation for the
 *   data lines after them; a data line is `bidi classes; bitset` where the
 *   bitset is 1 = auto, 2 = LTR, 4 = RTL.
 */
import { firstStrong, strongDirection, type LineDirection } from "../../../lib/bidiDirection";

export interface CharTestRow {
  line: number;
  cps: number[];
  dir: 0 | 1 | 2;
  paraLevel: number;
  levels: (number | null)[];
  order: number[];
}

export function parseBidiCharacterTest(text: string): CharTestRow[] {
  const rows: CharTestRow[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) return;
    const f = line.split(";").map((s) => s.trim());
    if (f.length < 5) throw new Error(`BidiCharacterTest line ${i + 1}: expected 5 fields, got ${f.length}`);
    const dir = Number(f[1]);
    if (dir !== 0 && dir !== 1 && dir !== 2) throw new Error(`BidiCharacterTest line ${i + 1}: direction must be 0, 1 or 2`);
    rows.push({
      line: i + 1,
      cps: f[0].split(/\s+/).map((h) => parseInt(h, 16)),
      dir,
      paraLevel: Number(f[2]),
      levels: f[3].split(/\s+/).map((x) => (x === "x" ? null : Number(x))),
      order: f[4] ? f[4].split(/\s+/).map(Number) : [],
    });
  });
  return rows;
}

export const BIDI_CLASSES = ["L", "R", "AL", "EN", "ES", "ET", "AN", "CS", "NSM", "BN", "B", "S", "WS", "ON", "LRE", "LRO", "RLE", "RLO", "PDF", "LRI", "RLI", "FSI", "PDI"] as const;
export type BidiClass = (typeof BIDI_CLASSES)[number];

/** One character of each class, to run BidiTest's class sequences through a character-level engine. */
export const REPRESENTATIVE: Record<BidiClass, number> = {
  L: 0x61, R: 0x5d0, AL: 0x627, EN: 0x31, ES: 0x2b, ET: 0x24, AN: 0x661, CS: 0x2c, NSM: 0x300, BN: 0xad, B: 0x2029, S: 0x09, WS: 0x20, ON: 0x21,
  LRE: 0x202a, LRO: 0x202d, RLE: 0x202b, RLO: 0x202e, PDF: 0x202c, LRI: 0x2066, RLI: 0x2067, FSI: 0x2068, PDI: 0x2069,
};

export interface ClassTestRow {
  line: number;
  classes: BidiClass[];
  /** Bitset: 1 auto, 2 LTR, 4 RTL. */
  dirs: number;
  levels: (number | null)[];
  order: number[];
}

export function parseBidiTest(text: string): ClassTestRow[] {
  const rows: ClassTestRow[] = [];
  let levels: (number | null)[] = [];
  let order: number[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) return;
    if (line.startsWith("@Levels:")) {
      levels = line.slice(8).trim().split(/\s+/).filter(Boolean).map((x) => (x === "x" ? null : Number(x)));
      return;
    }
    if (line.startsWith("@Reorder:")) {
      order = line.slice(9).trim().split(/\s+/).filter(Boolean).map(Number);
      return;
    }
    if (line.startsWith("@")) return;
    const [cls, bits] = line.split(";").map((s) => s.trim());
    const classes = cls.split(/\s+/) as BidiClass[];
    for (const c of classes) if (!(c in REPRESENTATIVE)) throw new Error(`BidiTest line ${i + 1}: unknown class "${c}"`);
    rows.push({ line: i + 1, classes, dirs: Number(bits), levels: [...levels], order: [...order] });
  });
  return rows;
}

/** A full UAX #9 implementation, character level. `dir` null = auto (P2–P3). */
export interface UbaEngine {
  id: string;
  /** Resolved level per code point of `cps` (null where X9 removes the character). */
  levels(cps: readonly number[], dir: LineDirection | null): { paraLevel: number; levels: (number | null)[] };
  /** Visual order (indices into cps) of the characters that are not removed. */
  order(cps: readonly number[], dir: LineDirection | null): number[];
}

const PARAGRAPH_SEP = new Set([0x0a, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2029]);

/**
 * Lumen's paragraph level for a row: 0 / 1 when explicit, else P2–P3 with
 * firstStrong over the first paragraph (up to the first B character), 0
 * when it has no strong character.
 */
export function lumenParagraphLevel(cps: readonly number[], dir: 0 | 1 | 2, strong: (cp: number) => LineDirection | null = strongDirection): number {
  if (dir !== 2) return dir;
  const cut = cps.findIndex((c) => PARAGRAPH_SEP.has(c));
  const text = String.fromCodePoint(...(cut < 0 ? cps : cps.slice(0, cut)));
  return firstStrong(text, strong) === "rtl" ? 1 : 0;
}

export type FailureKind = "paragraphLevel" | "levels" | "order";

export interface ConformanceReport {
  file: "BidiCharacterTest" | "BidiTest";
  rows: number;
  passed: number;
  rate: number;
  /** Which checks ran: "paragraphLevel" is Lumen's; "levels"/"order" are the engine's. */
  checks: { paragraphLevel: boolean; levels: string | null; order: string | null };
  failures: Record<FailureKind, { count: number; examples: number[] }>;
}

const sameLevels = (a: readonly (number | null)[], b: readonly (number | null)[]) => a.length === b.length && a.every((x, i) => (x === null) === (b[i] === null) && (x === null || x === b[i]));
const sameOrder = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function emptyFailures(): ConformanceReport["failures"] {
  return { paragraphLevel: { count: 0, examples: [] }, levels: { count: 0, examples: [] }, order: { count: 0, examples: [] } };
}

const EXAMPLES = 10;
const toDir = (d: 0 | 1 | 2): LineDirection | null => (d === 0 ? "ltr" : d === 1 ? "rtl" : null);

export function runCharacterTest(rows: readonly CharTestRow[], opts: { engine?: UbaEngine | null; strong?: (cp: number) => LineDirection | null } = {}): ConformanceReport {
  const failures = emptyFailures();
  let passed = 0;
  const fail = (k: FailureKind, line: number) => {
    failures[k].count++;
    if (failures[k].examples.length < EXAMPLES) failures[k].examples.push(line);
  };
  for (const r of rows) {
    let ok = true;
    if (lumenParagraphLevel(r.cps, r.dir, opts.strong) !== r.paraLevel) {
      ok = false;
      fail("paragraphLevel", r.line);
    }
    if (opts.engine) {
      const dir = toDir(r.dir);
      if (!sameLevels(opts.engine.levels(r.cps, dir).levels, r.levels)) {
        ok = false;
        fail("levels", r.line);
      }
      if (!sameOrder(opts.engine.order(r.cps, dir), r.order)) {
        ok = false;
        fail("order", r.line);
      }
    }
    if (ok) passed++;
  }
  return { file: "BidiCharacterTest", rows: rows.length, passed, rate: rows.length ? passed / rows.length : Number.NaN, checks: { paragraphLevel: true, levels: opts.engine?.id ?? null, order: opts.engine?.id ?? null }, failures };
}

/** BidiTest.txt has no paragraph-level column: only the engine's levels and order are checked, once per direction in the bitset. */
export function runClassTest(rows: readonly ClassTestRow[], engine: UbaEngine): ConformanceReport {
  const failures = emptyFailures();
  let cases = 0;
  let passed = 0;
  for (const r of rows) {
    const cps = r.classes.map((c) => REPRESENTATIVE[c]);
    for (const [bit, dir] of [[1, null], [2, "ltr"], [4, "rtl"]] as const) {
      if (!(r.dirs & bit)) continue;
      cases++;
      let ok = true;
      if (!sameLevels(engine.levels(cps, dir).levels, r.levels)) {
        ok = false;
        failures.levels.count++;
        if (failures.levels.examples.length < EXAMPLES) failures.levels.examples.push(r.line);
      }
      if (!sameOrder(engine.order(cps, dir), r.order)) {
        ok = false;
        failures.order.count++;
        if (failures.order.examples.length < EXAMPLES) failures.order.examples.push(r.line);
      }
      if (ok) passed++;
    }
  }
  return { file: "BidiTest", rows: cases, passed, rate: cases ? passed / cases : Number.NaN, checks: { paragraphLevel: false, levels: engine.id, order: engine.id }, failures };
}

/** W11.H1 acceptance: at least 99.9 % of BidiCharacterTest rows. */
export const BIDI_CONFORMANCE_MIN = 0.999;

/**
 * bidi-js as a UbaEngine (pass its factory's result). bidi-js works on
 * UTF-16 strings, the tests on code points: a supplementary character's
 * level is its first code unit's, and the order is mapped back.
 */
export function bidiJsEngine(bidi: {
  getEmbeddingLevels(text: string, dir?: "ltr" | "rtl"): { levels: Uint8Array; paragraphs: { start: number; end: number; level: number }[] };
  getReorderedIndices(text: string, levels: unknown, start?: number, end?: number): number[];
}, removed: (cp: number) => boolean): UbaEngine {
  const units = (cps: readonly number[]) => {
    const unitOf: number[] = [];
    const cpOfUnit: number[] = [];
    let u = 0;
    cps.forEach((cp, i) => {
      unitOf.push(u);
      const n = cp > 0xffff ? 2 : 1;
      for (let k = 0; k < n; k++) cpOfUnit[u + k] = i;
      u += n;
    });
    return { text: String.fromCodePoint(...cps), unitOf, cpOfUnit };
  };
  return {
    id: "bidi-js@1.1.0",
    levels(cps, dir) {
      const { text, unitOf } = units(cps);
      const res = bidi.getEmbeddingLevels(text, dir ?? undefined);
      return { paraLevel: res.paragraphs[0]?.level ?? 0, levels: cps.map((cp, i) => (removed(cp) ? null : res.levels[unitOf[i]])) };
    },
    order(cps, dir) {
      const { text, cpOfUnit } = units(cps);
      const res = bidi.getEmbeddingLevels(text, dir ?? undefined);
      const seen = new Set<number>();
      const out: number[] = [];
      for (const u of bidi.getReorderedIndices(text, res)) {
        const i = cpOfUnit[u];
        if (seen.has(i) || removed(cps[i])) continue;
        seen.add(i);
        out.push(i);
      }
      return out;
    },
  };
}
