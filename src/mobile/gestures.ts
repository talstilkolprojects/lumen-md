/**
 * Touch gestures for phones (plan W1.25), as pure functions so the rules
 * are the same in the app and in tests.
 *
 * - Edge swipes open the side panels: a swipe in from the screen's *start*
 *   edge opens the file tree, one in from the *end* edge opens the outline.
 *   "Start" follows the writing direction, so in Hebrew the file tree comes
 *   in from the right, the way it sits on a wide screen; a swipe back
 *   towards a panel's edge closes it.
 * - A tap on reading-view text switches to editing at the tapped line.
 */

export interface Stroke {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Milliseconds from touch to lift. */
  ms: number;
}

export type SwipeAction = "open-start" | "open-end" | "close-start" | "close-end";

/** How far in from the edge a swipe may start (px): wide enough for a thumb, narrow enough to leave text selection alone. */
export const EDGE_PX = 28;
/** The shortest horizontal travel that counts as a swipe (px). */
export const MIN_SWIPE_PX = 56;
/** A slower movement is a drag, not a swipe (ms). */
export const MAX_SWIPE_MS = 700;

/**
 * What a finished stroke means, or null. `width` is the viewport width;
 * `rtl` the UI direction; `open` which panels are open now.
 */
export function classifySwipe(s: Stroke, width: number, rtl: boolean, open: { start: boolean; end: boolean }): SwipeAction | null {
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  if (s.ms > MAX_SWIPE_MS || Math.abs(dx) < MIN_SWIPE_PX || Math.abs(dx) < 2 * Math.abs(dy)) return null;
  // In physical terms: which edge is "start", and which way is "inwards" from it.
  const fromLeft = s.x0 <= EDGE_PX;
  const fromRight = s.x0 >= width - EDGE_PX;
  const rightwards = dx > 0;
  const startFromEdge = rtl ? fromRight && !rightwards : fromLeft && rightwards;
  const endFromEdge = rtl ? fromLeft && rightwards : fromRight && !rightwards;
  // Towards a panel's edge = the opposite of "inwards".
  const towardsStart = rtl ? rightwards : !rightwards;
  if (open.start && towardsStart) return "close-start";
  if (open.end && !towardsStart) return "close-end";
  if (startFromEdge && !open.start) return "open-start";
  if (endFromEdge && !open.end) return "open-end";
  return null;
}

/** A tap: short, and the finger hardly moved. */
export function isTap(s: Stroke): boolean {
  return s.ms < 350 && Math.hypot(s.x1 - s.x0, s.y1 - s.y0) < 10;
}

/** Words in a note, for the "long note opens in reading view" rule. Front matter and code fences count as nothing. */
export function wordCount(md: string): number {
  const body = md.replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/```[\s\S]*?```/g, " ");
  const m = body.match(/[\p{L}\p{N}][\p{L}\p{N}'’״"\-]*/gu);
  return m ? m.length : 0;
}

/** Long notes open in reading view on a phone (Bear and Craft do the same); the threshold is a setting. */
export const DEFAULT_READING_WORDS = 600;

export function opensInReading(md: string, opts: { phone: boolean; enabled: boolean; words?: number }): boolean {
  return opts.phone && opts.enabled && wordCount(md) >= (opts.words ?? DEFAULT_READING_WORDS);
}

const strip = (s: string) =>
  s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)+/, "")
    .replace(/[*_~`=]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * The 1-based source line a tap on reading view stands for.
 *
 * `headingIndex` is how many headings come before the tapped block in the
 * rendered page (or -1 before the first), and `text` the block's text. The
 * line is looked for inside that heading's section first, so a sentence that
 * repeats elsewhere still lands in the right place; then anywhere; then on
 * the heading itself.
 */
export function lineForTap(source: string, tap: { headingIndex: number; text: string }): number {
  const lines = source.split("\n");
  let fence = false;
  const headings: number[] = [];
  const front = /^---\n[\s\S]*?\n---\n/.exec(source);
  const skip = front ? front[0].split("\n").length - 1 : 0;
  for (let i = skip; i < lines.length; i++) {
    if (/^(```|~~~)/.test(lines[i])) fence = !fence;
    else if (!fence && /^#{1,6}\s/.test(lines[i])) headings.push(i);
  }
  const lo = tap.headingIndex >= 0 ? (headings[tap.headingIndex] ?? skip) : skip;
  const hi = tap.headingIndex + 1 < headings.length ? headings[tap.headingIndex + 1] : lines.length;
  const needle = strip(tap.text).slice(0, 40);
  if (needle) {
    const find = (a: number, b: number) => {
      for (let i = a; i < b; i++) {
        const l = strip(lines[i]);
        if (l && (l.startsWith(needle) || (l.length >= 8 && needle.startsWith(l)) || l.includes(needle))) return i;
      }
      return -1;
    };
    const inSection = find(lo, hi);
    if (inSection >= 0) return inSection + 1;
    const anywhere = find(skip, lines.length);
    if (anywhere >= 0) return anywhere + 1;
  }
  return lo + 1;
}
