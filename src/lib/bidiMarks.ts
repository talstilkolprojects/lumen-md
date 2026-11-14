/**
 * Invisible direction controls in a note (plan W5.4).
 *
 * Hebrew pasted from a word processor, a web page or a chat app often
 * carries characters you cannot see: marks (LRM, RLM, ALM), embeddings
 * (LRE, RLE … PDF), overrides (LRO, RLO … PDF) and isolates (LRI, RLI,
 * FSI … PDI). They are why a pasted paragraph suddenly runs the wrong way
 * or a bracket jumps to the other end of the line, and an editor that
 * hides them leaves the writer guessing. This module finds them, tells
 * the harmless ones from the dangerous ones, and removes only those that
 * change nothing on screen.
 *
 * Dangerous (Trojan Source, CVE-2021-42574): an override, or an embedding /
 * isolate still open at the end of its line. Both make the text display in
 * an order other than the one it is stored in — what you read is not what
 * a search, a diff or a compiler sees.
 *
 * "Unneeded" (cleanBidiMarks) is decided with the rules of UAX #9, never
 * by guessing, so cleaning keeps the visual order of every line:
 *   - a mark directly followed by a strong character of its direction
 *     (RLM before Hebrew, LRM before Latin), or directly after a strong
 *     character of exactly its class (RLM after Hebrew, ALM after Arabic,
 *     LRM after Latin; combining marks such as niqqud belong to the letter
 *     before them);
 *   - an embedding, override or isolate that encloses nothing;
 *   - a PDF or PDI that closes nothing (UAX #9 ignores it).
 * Everything else stays, including every override: removing one changes
 * the display, which is a decision for the writer (see removeRisky).
 *
 * Reversed brackets (fixReversedBrackets): in a right-to-left line typed
 * in a tool that did not know about direction, ")טקסט(" was entered so
 * that it would look right there. Where every bracket of one kind in a
 * line is backwards that way and swapping them balances the line, they
 * are swapped. Code is never touched.
 */

import { markdownLineDirection, strongDirection, type LineDirection } from "./bidiDirection";

export type BidiControlKind = "mark" | "embedding" | "override" | "isolate" | "pop";

export interface BidiControl {
  /** Short Unicode name, shown on the tag: "RLM", "LRI", … */
  name: string;
  code: number;
  kind: BidiControlKind;
  /** The direction it sets; "first" for FSI (the first strong character inside). */
  dir?: "ltr" | "rtl" | "first";
  /** For a pop: which openers it closes. */
  closes?: "embedding" | "isolate";
}

const LIST: BidiControl[] = [
  { name: "LRM", code: 0x200e, kind: "mark", dir: "ltr" },
  { name: "RLM", code: 0x200f, kind: "mark", dir: "rtl" },
  { name: "ALM", code: 0x061c, kind: "mark", dir: "rtl" },
  { name: "LRE", code: 0x202a, kind: "embedding", dir: "ltr" },
  { name: "RLE", code: 0x202b, kind: "embedding", dir: "rtl" },
  { name: "PDF", code: 0x202c, kind: "pop", closes: "embedding" },
  { name: "LRO", code: 0x202d, kind: "override", dir: "ltr" },
  { name: "RLO", code: 0x202e, kind: "override", dir: "rtl" },
  { name: "LRI", code: 0x2066, kind: "isolate", dir: "ltr" },
  { name: "RLI", code: 0x2067, kind: "isolate", dir: "rtl" },
  { name: "FSI", code: 0x2068, kind: "isolate", dir: "first" },
  { name: "PDI", code: 0x2069, kind: "pop", closes: "isolate" },
];

export const BIDI_CONTROLS: ReadonlyMap<number, BidiControl> = new Map(LIST.map((c) => [c.code, c]));

/** Every direction control, for a quick test or a global search. */
export const BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function bidiControlAt(text: string, index: number): BidiControl | null {
  return BIDI_CONTROLS.get(text.charCodeAt(index)) ?? null;
}

export interface FoundControl {
  /** UTF-16 offset in the text. */
  index: number;
  control: BidiControl;
}

/** Every direction control in `text`, in order. */
export function findBidiControls(text: string): FoundControl[] {
  const out: FoundControl[] = [];
  BIDI_CONTROL_RE.lastIndex = 0;
  for (let m = BIDI_CONTROL_RE.exec(text); m; m = BIDI_CONTROL_RE.exec(text)) out.push({ index: m.index, control: BIDI_CONTROLS.get(m[0].charCodeAt(0))! });
  return out;
}

export type BidiRiskReason = "override" | "unterminated";

export interface BidiRisk {
  index: number;
  control: BidiControl;
  reason: BidiRiskReason;
}

interface Opener {
  index: number;
  control: BidiControl;
}

/**
 * Walk one line the way UAX #9 X1–X8 pairs controls: PDI closes the last
 * open isolate (and every embedding opened after it), PDF closes the last
 * embedding or override unless an isolate opened after it is still open.
 * Returns what was left open, what closed nothing, and the matched pairs.
 */
function pairLine(text: string, from: number, to: number) {
  const stack: Opener[] = [];
  const unmatched: FoundControl[] = [];
  const pairs: Array<[Opener, number]> = [];
  for (let i = from; i < to; i++) {
    const c = BIDI_CONTROLS.get(text.charCodeAt(i));
    if (!c || c.kind === "mark") continue;
    if (c.kind !== "pop") {
      stack.push({ index: i, control: c });
      continue;
    }
    if (c.closes === "isolate") {
      const at = stack.map((o) => o.control.kind).lastIndexOf("isolate");
      if (at < 0) {
        unmatched.push({ index: i, control: c });
        continue;
      }
      pairs.push([stack[at], i]);
      stack.length = at; // embeddings inside the isolate close with it
    } else {
      const top = stack[stack.length - 1];
      if (!top || top.control.kind === "isolate") {
        unmatched.push({ index: i, control: c });
        continue;
      }
      pairs.push([stack.pop()!, i]);
    }
  }
  return { open: stack, unmatched, pairs };
}

/** Line ranges [from, to) of a text (paragraph separators end a bidi paragraph). */
function lineRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "\n" || text[i] === "\r" || text[i] === " ") {
      out.push([start, i]);
      if (text[i] === "\r" && text[i + 1] === "\n") i++;
      start = i + 1;
    }
  }
  return out;
}

/**
 * The Trojan Source risks in `text`: every override (LRO, RLO), and every
 * embedding or isolate still open at the end of its line.
 */
export function bidiRisks(text: string): BidiRisk[] {
  const out: BidiRisk[] = [];
  for (const [from, to] of lineRanges(text)) {
    const { open } = pairLine(text, from, to);
    const openAt = new Set(open.map((o) => o.index));
    for (let i = from; i < to; i++) {
      const c = BIDI_CONTROLS.get(text.charCodeAt(i));
      if (!c) continue;
      if (c.kind === "override") out.push({ index: i, control: c, reason: openAt.has(i) ? "unterminated" : "override" });
      else if (openAt.has(i)) out.push({ index: i, control: c, reason: "unterminated" });
    }
  }
  return out;
}

export function hasBidiRisk(text: string): boolean {
  BIDI_CONTROL_RE.lastIndex = 0;
  return BIDI_CONTROL_RE.test(text) && bidiRisks(text).length > 0;
}

/** One replacement in the text, in CodeMirror's shape. */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

export function applyEdits(text: string, edits: TextEdit[]): string {
  let out = "";
  let at = 0;
  for (const e of [...edits].sort((a, b) => a.from - b.from)) {
    out += text.slice(at, e.from) + e.insert;
    at = e.to;
  }
  return out + text.slice(at);
}

/**
 * The edits that remove every risky control: each override with its PDF,
 * and each embedding or isolate left open at the end of its line. The
 * text then displays in the order it is stored.
 */
export function removeRiskyEdits(text: string): TextEdit[] {
  const drop = new Set<number>();
  for (const [from, to] of lineRanges(text)) {
    const { open, pairs } = pairLine(text, from, to);
    for (const o of open) drop.add(o.index);
    for (const [o, close] of pairs) if (o.control.kind === "override") {
      drop.add(o.index);
      drop.add(close);
    }
  }
  return [...drop].sort((a, b) => a - b).map((i) => ({ from: i, to: i + 1, insert: "" }));
}

// ── Cleaning ────────────────────────────────────────────────────────────

/** Arabic Letter (AL) blocks: Arabic, Syriac, Thaana, Arabic Extended, presentation forms, Arabic math. */
function isArabicLetter(cp: number): boolean {
  return (cp >= 0x0600 && cp <= 0x07bf) || (cp >= 0x0860 && cp <= 0x08ff) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff) || (cp >= 0x10d00 && cp <= 0x10d3f) || (cp >= 0x1ee00 && cp <= 0x1eeff);
}

type StrongClass = "L" | "R" | "AL";

/** The strong bidi class of one code point (marks included), or null. */
function strongClass(cp: number): StrongClass | null {
  if (cp === 0x200e) return "L";
  if (cp === 0x200f) return "R";
  if (cp === 0x061c) return "AL";
  const d = strongDirection(cp);
  if (!d) return null;
  if (d === "ltr") return "L";
  return isArabicLetter(cp) ? "AL" : "R";
}

const MARK_CLASS: Record<string, StrongClass> = { LRM: "L", RLM: "R", ALM: "AL" };
const sameDirection = (a: StrongClass, b: StrongClass) => (a === "L") === (b === "L");

/** Nonspacing and enclosing combining marks take the class of the character before them (UAX #9 W1). */
const NSM = /[\p{Mn}\p{Me}]/u;

function codePointBefore(s: string, end: number): { cp: number; start: number } | null {
  if (end <= 0) return null;
  const low = s.charCodeAt(end - 1);
  if (low >= 0xdc00 && low <= 0xdfff && end >= 2) {
    const high = s.charCodeAt(end - 2);
    if (high >= 0xd800 && high <= 0xdbff) return { cp: s.codePointAt(end - 2)!, start: end - 2 };
  }
  return { cp: low, start: end - 1 };
}

/** The strong class of the last character of `s`, through trailing combining marks; null if it is not strong. */
function classBefore(s: string): StrongClass | null {
  let end = s.length;
  for (let p = codePointBefore(s, end); p; p = codePointBefore(s, end)) {
    if (NSM.test(String.fromCodePoint(p.cp))) {
      end = p.start;
      continue;
    }
    return strongClass(p.cp);
  }
  return null;
}

/** Fenced code lines (``` / ~~~), tracked textually, by line index. */
function fencedLines(lines: string[]): boolean[] {
  const out: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(true);
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !line.trim().slice(open[1].length).length) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      out.push(true);
      continue;
    }
    out.push(false);
  }
  return out;
}

/** Offsets [from, to) of the code spans in one line (CommonMark backtick runs). */
function codeSpans(line: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  const runAt = (k: number) => {
    let e = k;
    while (line[e] === "`") e++;
    return e - k;
  };
  while (i < line.length) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    const n = runAt(i);
    let k = i + n;
    let close = -1;
    while (k < line.length) {
      if (line[k] !== "`") {
        k++;
        continue;
      }
      const m = runAt(k);
      if (m === n) {
        close = k;
        break;
      }
      k += m;
    }
    if (close < 0) i += n;
    else {
      out.push([i, close + n]);
      i = close + n;
    }
  }
  return out;
}

/** Edits that remove the unneeded controls of one line (offsets relative to the line). */
function cleanLine(line: string): Array<[number, number]> {
  if (!/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(line)) return [];
  const remove = new Set<number>();
  // Empty pairs and pops that close nothing.
  const { unmatched, pairs } = pairLine(line, 0, line.length);
  for (const u of unmatched) remove.add(u.index);
  for (const [o, close] of pairs) {
    const inside = line.slice(o.index + 1, close);
    if (!inside.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (ch, at: number) => (remove.has(o.index + 1 + at) ? "" : ch)).length) {
      remove.add(o.index);
      remove.add(close);
    }
  }
  // Marks, left to right, each checked against the line as already cleaned.
  let kept = "";
  for (let i = 0; i < line.length; i++) {
    if (remove.has(i)) continue;
    const c = BIDI_CONTROLS.get(line.charCodeAt(i));
    if (c?.kind === "mark") {
      const own = MARK_CLASS[c.name];
      const nextCp = line.codePointAt(i + 1);
      const next = nextCp === undefined || remove.has(i + 1) ? null : strongClass(nextCp);
      const prev = classBefore(kept);
      if ((next && sameDirection(next, own)) || prev === own) {
        remove.add(i);
        continue;
      }
    }
    kept += line[i];
  }
  return [...remove].sort((a, b) => a - b).map((i) => [i, i + 1]);
}

export interface BidiFixResult {
  edits: TextEdit[];
  /** Direction controls removed. */
  removed: number;
  /** Bracket pairs swapped. */
  swapped: number;
}

const BRACKETS: Array<[string, string]> = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
];

/**
 * Brackets typed backwards in a right-to-left line: for each kind, if the
 * line's brackets do not balance but would with every one of them swapped,
 * swap them. Code spans are left alone. Returns offsets to flip.
 */
export function reversedBrackets(line: string): number[] {
  const spans = codeSpans(line);
  const inCode = (i: number) => spans.some(([a, b]) => i >= a && i < b);
  const out: number[] = [];
  for (const [open, close] of BRACKETS) {
    const at: number[] = [];
    let depth = 0;
    let min = 0;
    let depthSwapped = 0;
    let minSwapped = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if ((ch !== open && ch !== close) || inCode(i) || line[i - 1] === "\\") continue;
      at.push(i);
      depth += ch === open ? 1 : -1;
      depthSwapped += ch === open ? -1 : 1;
      min = Math.min(min, depth);
      minSwapped = Math.min(minSwapped, depthSwapped);
    }
    if (!at.length || depth !== 0 || min === 0 || minSwapped < 0) continue;
    out.push(...at);
  }
  return out.sort((a, b) => a - b);
}

const FLIP: Record<string, string> = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{" };

export interface BidiFixOptions {
  /** The note's direction, for lines without a strong character. */
  noteDir?: LineDirection;
  /** Leave brackets alone. */
  brackets?: boolean;
}

/**
 * "Clean unneeded marks and fix reversed brackets", as one set of edits
 * (the editor applies them as one undoable change). Fenced code is never
 * touched; bracket fixes skip code spans and left-to-right lines.
 */
export function fixBidi(text: string, opts: BidiFixOptions = {}): BidiFixResult {
  const edits: TextEdit[] = [];
  let removed = 0;
  let swapped = 0;
  const ranges = lineRanges(text);
  const lines = ranges.map(([a, b]) => text.slice(a, b));
  const fenced = fencedLines(lines);
  ranges.forEach(([from], n) => {
    if (fenced[n]) return;
    const line = lines[n];
    const drop = cleanLine(line);
    for (const [a, b] of drop) edits.push({ from: from + a, to: from + b, insert: "" });
    removed += drop.length;
    if (opts.brackets === false) return;
    const dir = markdownLineDirection(line) ?? opts.noteDir ?? "ltr";
    if (dir !== "rtl") return;
    const flips = reversedBrackets(line);
    for (const i of flips) edits.push({ from: from + i, to: from + i + 1, insert: FLIP[line[i]] });
    swapped += flips.length / 2;
  });
  edits.sort((a, b) => a.from - b.from);
  return { edits, removed, swapped };
}

/** The text with fixBidi applied. */
export function fixBidiText(text: string, opts?: BidiFixOptions): string {
  return applyEdits(text, fixBidi(text, opts).edits);
}
