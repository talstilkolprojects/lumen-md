/**
 * Direction of a Markdown line for the editors (plan 9.7).
 *
 * The rule is the golden set's (eval/golden/bidi): UAX #9 P2–P3, the first
 * strong character decides, looked for in the text the reader sees — after
 * the Markdown markers (`#`, `>`, list bullets and numbers, task boxes),
 * with link URLs and code spans left out. U+200F (RLM) and U+200E (LRM)
 * are strong, so a writer can pin a line that starts with a number or a
 * Latin token.
 *
 * `dir="auto"` alone gets some of these wrong: "> `iPhone` הפגישה נדחתה"
 * is a Hebrew line to its reader, but the browser sees the code span's "i"
 * first and lays it out left-to-right, which also reverses its arrow keys.
 *
 * Strong classes come from a 1 KB table generated from bidi-js
 * (scripts/gen-bidi-strong.mjs), so every script is covered, not only
 * Hebrew, Arabic and Latin.
 */

import { BIDI_STRONG_RUNS } from "./bidiStrong.generated";

export type LineDirection = "ltr" | "rtl";

let starts: Uint32Array | null = null;
let classes: Uint8Array | null = null;

function decode(): void {
  const re = /([0-9a-z]+)([NLR])/g;
  const s: number[] = [];
  const c: number[] = [];
  let cp = 0;
  for (let m = re.exec(BIDI_STRONG_RUNS); m; m = re.exec(BIDI_STRONG_RUNS)) {
    s.push(cp);
    c.push(m[2] === "L" ? 1 : m[2] === "R" ? 2 : 0);
    cp += parseInt(m[1], 36);
  }
  starts = Uint32Array.from(s);
  classes = Uint8Array.from(c);
}

/** "ltr" for Bidi_Class L, "rtl" for R / AL, null for everything else. */
export function strongDirection(codePoint: number): LineDirection | null {
  if (!starts || !classes) decode();
  const st = starts!;
  let lo = 0;
  let hi = st.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (st[mid] <= codePoint) lo = mid;
    else hi = mid - 1;
  }
  const c = classes![lo];
  return c === 1 ? "ltr" : c === 2 ? "rtl" : null;
}

/** First strong direction in `text`, or null when it has none. */
export function firstStrong(text: string): LineDirection | null {
  for (const ch of text) {
    const d = strongDirection(ch.codePointAt(0)!);
    if (d) return d;
  }
  return null;
}

const MARKERS = /^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)*/;

/**
 * Drop `(destination "title")` after every `]`, so no part of a URL is left:
 * an angle-bracketed destination runs to its unescaped `>`; a bare one
 * balances parentheses; backslash escapes are skipped. An unclosed `(` is
 * ordinary text.
 */
function stripLinkDestinations(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    out += ch;
    i++;
    if (ch !== "]" || text[i] !== "(") continue;
    let j = i + 1;
    while (text[j] === " " || text[j] === "\t") j++;
    if (text[j] === "<") {
      for (j++; j < text.length && text[j] !== ">"; j++) if (text[j] === "\\") j++;
      if (j >= text.length) continue; // no closing ">": not a destination
      j++;
    }
    let depth = 1;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === "\\") j++;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
    }
    if (j < text.length) i = j + 1;
  }
  return out;
}

/**
 * Remove code spans the CommonMark way: a run of n backticks opens a span
 * that closes at the next run of exactly n backticks; an opening run
 * without one is literal text.
 */
function stripCodeSpans(text: string): string {
  let out = "";
  let i = 0;
  const runAt = (k: number) => {
    let e = k;
    while (text[e] === "`") e++;
    return e - k;
  };
  while (i < text.length) {
    if (text[i] !== "`") {
      out += text[i++];
      continue;
    }
    const n = runAt(i);
    let k = i + n;
    let close = -1;
    while (k < text.length) {
      if (text[k] !== "`") {
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
    if (close < 0) {
      out += text.slice(i, i + n);
      i += n;
    } else i = close + n;
  }
  return out;
}

/** The part of a Markdown line its reader sees as text, for the direction rule. */
export function visibleLineText(line: string): string {
  return stripCodeSpans(stripLinkDestinations(line.replace(MARKERS, "")));
}

/** Direction of one Markdown line, or null for a neutral line (numbers, emoji, punctuation only). */
export function markdownLineDirection(line: string): LineDirection | null {
  return firstStrong(visibleLineText(line));
}
