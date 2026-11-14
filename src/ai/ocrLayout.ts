/**
 * Page layout for Hebrew OCR (plan W1.18): columns, reading order and a
 * selectable text layer for scanned pages.
 *
 * tesseract finds the text lines of a multi-column page, but the order in
 * which it lists them follows a left-to-right reading of the page: on a
 * Hebrew page with two columns, the left column (the second one to read)
 * can come first, and a heading that spans both columns can land between
 * them. This module orders the lines from their boxes alone, by a recursive
 * XY cut:
 *  - a region is first split at the widest vertical gutter that no line
 *    crosses (columns), and the columns are read right to left on a Hebrew
 *    page (left to right on a Latin one);
 *  - a region without a gutter is split into bands, read top to bottom: a
 *    run of rows that share a gutter (columns), or a run of rows of which
 *    none has one (a heading above the columns, a footer below);
 *  - a region that splits neither way is read top to bottom.
 * Pure functions, no DOM except `renderOcrTextLayer`.
 *
 * The text layer gives every recognised line one absolutely positioned,
 * transparent span over the page image, holding the line's logical text
 * (./ocrMixed already rebuilt mixed lines in logical order), in reading
 * order, with `dir` set from its first strong letter. Selecting and copying
 * over a scanned Hebrew page then yields the words in the order they are
 * read, not in the visual order of the glyph boxes.
 */

import type { Box, OcrLine } from "./ocrMixed";

/** A recognised line with its box (tesseract.js lines carry one; otherwise the words' union). */
export interface LayoutLine extends OcrLine {
  bbox?: Box;
}

/** A line placed on the page: its logical text and its box. */
export interface PlacedLine {
  text: string;
  bbox: Box;
  /** Index of the column the line was read in (0 = first read), within its band. */
  column: number;
}

export interface LayoutOptions {
  /** Read columns right to left. Default: decided from the lines' letters (`isRtlPage`). */
  rtl?: boolean;
  /** Narrowest gutter that separates two columns, in pixels. Default: 1.5 × the median line height. */
  minGutter?: number;
}

const HEB = /[א-ת]/g;
const LATIN = /[A-Za-z]/g;
const MARKS = /[‎‏‪-‮⁦-⁩]/g;

/** The line's box: its own, or the union of its words' boxes. */
export function lineBox(l: LayoutLine): Box | null {
  if (l.bbox) return l.bbox;
  if (!l.words.length) return null;
  return {
    x0: Math.min(...l.words.map((w) => w.bbox.x0)),
    y0: Math.min(...l.words.map((w) => w.bbox.y0)),
    x1: Math.max(...l.words.map((w) => w.bbox.x1)),
    y1: Math.max(...l.words.map((w) => w.bbox.y1)),
  };
}

/** A page is read right to left when it has at least as many Hebrew letters as Latin ones (and some letters). */
export function isRtlPage(texts: readonly string[]): boolean {
  let he = 0;
  let en = 0;
  for (const t of texts) {
    he += t.match(HEB)?.length ?? 0;
    en += t.match(LATIN)?.length ?? 0;
  }
  return he > 0 && he >= en;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

interface Item {
  bbox: Box;
  index: number;
}

/** Groups of items separated by gaps of at least `gap` along one axis, in increasing order. */
function splitAlong(items: Item[], axis: "x" | "y", gap: number): Item[][] {
  const lo = axis === "x" ? "x0" : "y0";
  const hi = axis === "x" ? "x1" : "y1";
  const sorted = [...items].sort((a, b) => a.bbox[lo] - b.bbox[lo]);
  const groups: Item[][] = [];
  let cur: Item[] = [];
  let end = -Infinity;
  for (const it of sorted) {
    if (cur.length && it.bbox[lo] - end >= gap) {
      groups.push(cur);
      cur = [];
    }
    cur.push(it);
    end = Math.max(cur.length > 1 ? end : -Infinity, it.bbox[hi]);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

const midY = (b: Box) => (b.y0 + b.y1) / 2;

/** Items grouped into rows (an item whose middle lies within a row's height joins it), top to bottom. */
function rowsOf(items: Item[]): Item[][] {
  const rows: Array<{ y0: number; y1: number; items: Item[] }> = [];
  for (const it of [...items].sort((a, b) => midY(a.bbox) - midY(b.bbox))) {
    const row = rows.at(-1);
    const m = midY(it.bbox);
    if (row && m >= row.y0 && m <= row.y1) {
      row.items.push(it);
      row.y1 = Math.max(row.y1, it.bbox.y1);
    } else rows.push({ y0: it.bbox.y0, y1: it.bbox.y1, items: [it] });
  }
  return rows.map((r) => r.items);
}

/** One row's items in reading order: right to left on a Hebrew page. */
const sortRow = (row: Item[], rtl: boolean) => [...row].sort((a, b) => (rtl ? b.bbox.x1 - a.bbox.x1 : a.bbox.x0 - b.bbox.x0));

/**
 * Rows (any vertical gap at all) grouped into bands: consecutive rows stay
 * together while they share a gutter (a band of columns) or while none of
 * them has one (a single-column band); a heading or a footer across the
 * columns is its own band.
 */
function bandsOf(items: Item[], minGutter: number): Item[][] {
  const hasGutter = (xs: Item[]) => splitAlong(xs, "x", minGutter).length > 1;
  const bands: Item[][] = [];
  let cur: Item[] = [];
  let curGutter = false;
  for (const row of splitAlong(items, "y", 1)) {
    const rowGutter = hasGutter(row);
    if (cur.length && (curGutter ? hasGutter([...cur, ...row]) : !rowGutter)) {
      cur.push(...row);
      continue;
    }
    if (cur.length) bands.push(cur);
    cur = [...row];
    curGutter = rowGutter;
  }
  if (cur.length) bands.push(cur);
  return bands;
}

/**
 * Reading order of boxes by recursive XY cut. Returns indices into `boxes`,
 * each with the column it was read in.
 */
export function readingOrder(boxes: readonly Box[], opts: { rtl: boolean; minGutter: number }): Array<{ index: number; column: number }> {
  const out: Array<{ index: number; column: number }> = [];
  const visit = (items: Item[], column: number, depth: number): void => {
    if (items.length <= 1 || depth > 32) {
      for (const row of rowsOf(items)) for (const it of sortRow(row, opts.rtl)) out.push({ index: it.index, column });
      return;
    }
    const cols = splitAlong(items, "x", opts.minGutter);
    if (cols.length > 1) {
      (opts.rtl ? cols.reverse() : cols).forEach((c, k) => visit(c, k, depth + 1));
      return;
    }
    const bands = bandsOf(items, opts.minGutter);
    if (bands.length > 1) {
      for (const band of bands) visit(band, 0, depth + 1);
      return;
    }
    for (const row of rowsOf(items)) for (const it of sortRow(row, opts.rtl)) out.push({ index: it.index, column });
  };
  visit(
    boxes.map((bbox, index) => ({ bbox, index })),
    0,
    0,
  );
  return out;
}

/** The narrowest gap taken for a gutter: 1.5 × the median line height, at least 8 px. */
export function defaultGutter(lines: readonly LayoutLine[]): number {
  const hs = lines.map(lineBox).filter((b): b is Box => !!b).map((b) => b.y1 - b.y0);
  return Math.max(8, 1.5 * median(hs));
}

/**
 * tesseract can join the lines of two narrow columns into one line across
 * the gutter. Split every line at gaps between its words at least
 * `minGutter` wide; each piece gets its words and, on a right-to-left page,
 * their text right to left (./ocrMixed rebuilds mixed pieces anyway). Lines
 * without such a gap are returned as they are.
 */
export function splitAtGutters(lines: readonly LayoutLine[], minGutter: number, rtl: boolean): LayoutLine[] {
  const out: LayoutLine[] = [];
  for (const l of lines) {
    if (l.words.length < 2) {
      out.push(l);
      continue;
    }
    const byX = [...l.words].sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const groups: (typeof byX)[] = [[byX[0]]];
    let right = byX[0].bbox.x1;
    for (const w of byX.slice(1)) {
      if (w.bbox.x0 - right >= minGutter) groups.push([]);
      groups[groups.length - 1].push(w);
      right = Math.max(right, w.bbox.x1);
    }
    if (groups.length === 1) {
      out.push(l);
      continue;
    }
    for (const g of rtl ? groups.reverse() : groups) {
      const ws = rtl ? [...g].reverse() : g;
      out.push({ text: `${ws.map((w) => w.text).join(" ")}\n`, words: ws });
    }
  }
  return out;
}

/** The number of columns of the page's widest band (1 for a single-column page). */
export function columnCount(placed: readonly PlacedLine[]): number {
  return placed.reduce((n, l) => Math.max(n, l.column + 1), placed.length ? 1 : 0);
}

/**
 * Order the page's lines for reading. `texts[i]` is the logical text of
 * `lines[i]` (fixed by ./ocrMixed, or tesseract's own); lines without a box
 * or without text are dropped.
 */
export function layoutLines(lines: readonly LayoutLine[], texts: readonly string[], opts: LayoutOptions = {}): PlacedLine[] {
  const kept: Array<{ text: string; bbox: Box }> = [];
  lines.forEach((l, i) => {
    const bbox = lineBox(l);
    const text = (texts[i] ?? "").replace(/\n$/, "");
    if (bbox && text.trim()) kept.push({ text, bbox });
  });
  if (!kept.length) return [];
  const rtl = opts.rtl ?? isRtlPage(kept.map((k) => k.text));
  const minGutter = opts.minGutter ?? defaultGutter(lines);
  const ordered = readingOrder(
    kept.map((k) => k.bbox),
    { rtl, minGutter },
  ).map(({ index, column }) => ({ ...kept[index], column }));
  // tesseract sometimes cuts one printed line in two (even inside a word): pieces of one row and one column,
  // next to each other, become one line again, joined in reading order.
  const out: PlacedLine[] = [];
  for (const l of ordered) {
    const prev = out.at(-1);
    const sameRow = prev && prev.column === l.column && midY(l.bbox) >= prev.bbox.y0 && midY(l.bbox) <= prev.bbox.y1;
    const gap = prev ? (rtl ? prev.bbox.x0 - l.bbox.x1 : l.bbox.x0 - prev.bbox.x1) : Infinity;
    if (prev && sameRow && gap > -minGutter && gap < minGutter) {
      prev.text = `${prev.text} ${l.text}`;
      prev.bbox = { x0: Math.min(prev.bbox.x0, l.bbox.x0), y0: Math.min(prev.bbox.y0, l.bbox.y0), x1: Math.max(prev.bbox.x1, l.bbox.x1), y1: Math.max(prev.bbox.y1, l.bbox.y1) };
    } else out.push({ ...l });
  }
  return out;
}

/** The page's text in reading order: one line per line, a blank line between columns and bands. */
export function layoutText(placed: readonly PlacedLine[]): string {
  const out: string[] = [];
  placed.forEach((l, i) => {
    const prev = placed[i - 1];
    if (prev && (prev.column !== l.column || l.bbox.y0 < prev.bbox.y0)) out.push("");
    out.push(l.text);
  });
  return out.join("\n");
}

// ── Text layer ──────────────────────────────────────────────────────────

/** One span of the text layer, in fractions of the page (0–1), so it scales with the rendered image. */
export interface TextLayerSpan {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  dir: "rtl" | "ltr";
}

/** "rtl" when the line's first strong letter is Hebrew. */
export function lineDir(text: string): "rtl" | "ltr" {
  const first = /[א-תA-Za-z]/.exec(text.replace(MARKS, ""))?.[0];
  return first && /[A-Za-z]/.test(first) ? "ltr" : "rtl";
}

/** The text layer of one page of `width` × `height` pixels (the image OCR read), in reading order. */
export function textLayerSpans(placed: readonly PlacedLine[], width: number, height: number): TextLayerSpan[] {
  if (width <= 0 || height <= 0) return [];
  return placed.map((l) => ({
    text: l.text,
    left: l.bbox.x0 / width,
    top: l.bbox.y0 / height,
    width: Math.max(1, l.bbox.x1 - l.bbox.x0) / width,
    height: Math.max(1, l.bbox.y1 - l.bbox.y0) / height,
    dir: lineDir(l.text),
  }));
}

/**
 * Lay the spans over a page image inside `container` (which must be
 * `position: relative` and sized like the image). The spans are
 * transparent, so the image shows, but selectable; their DOM order is the
 * reading order, so a selection copies the text in logical order. Each line
 * ends with a newline so that copying several lines keeps them apart.
 */
export function renderOcrTextLayer(container: HTMLElement, spans: readonly TextLayerSpan[]): HTMLElement {
  const doc = container.ownerDocument;
  const layer = doc.createElement("div");
  layer.className = "ocr-text-layer";
  Object.assign(layer.style, { position: "absolute", inset: "0", overflow: "hidden", lineHeight: "1", userSelect: "text" });
  const h = container.clientHeight || 1;
  for (const s of spans) {
    const el = doc.createElement("span");
    el.dir = s.dir;
    el.textContent = `${s.text}\n`;
    Object.assign(el.style, {
      position: "absolute",
      left: `${s.left * 100}%`,
      top: `${s.top * 100}%`,
      width: `${s.width * 100}%`,
      height: `${s.height * 100}%`,
      fontSize: `${Math.max(4, s.height * h * 0.9)}px`,
      whiteSpace: "pre",
      color: "transparent",
      textAlign: "justify",
      textAlignLast: "justify",
      overflow: "hidden",
    });
    layer.appendChild(el);
  }
  container.appendChild(layer);
  return layer;
}

// ── Word order metric ───────────────────────────────────────────────────

const words = (s: string) =>
  s
    .replace(MARKS, "")
    .split(/\s+/)
    .map((w) => w.replace(/^[.,;:!?"'()•*+–-]+|[.,;:!?"'()–-]+$/g, ""))
    .filter(Boolean);

/**
 * The share of reference lines whose words come out in the right order
 * (acceptance of W1.18: "≥ 95% of the lines"). Each reference line is
 * matched with the output line sharing most of its words; recognition
 * errors are not order errors, so only the words both lines share are
 * compared, in sequence. A line with fewer than half its words found counts
 * as wrong. Reading order across lines counts too: the matched output lines
 * must come in the reference's order.
 */
export function lineOrderAccuracy(reference: string, hypothesis: string): { correct: number; total: number } {
  const ref = reference.split("\n").map(words).filter((w) => w.length);
  const hyp = hypothesis.split("\n").map(words).filter((w) => w.length);
  let correct = 0;
  let lastMatch = -1;
  for (const r of ref) {
    let best = -1;
    let bestShared = 0;
    hyp.forEach((h, k) => {
      const hs = new Set(h);
      const shared = r.filter((x) => hs.has(x)).length;
      if (shared > bestShared) {
        bestShared = shared;
        best = k;
      }
    });
    if (best < 0 || bestShared * 2 < r.length) continue;
    const h = hyp[best];
    const rs = new Set(r);
    const hSet = new Set(h);
    const a = r.filter((x) => hSet.has(x));
    const b = h.filter((x) => rs.has(x));
    const inOrder = a.length === b.length && a.every((x, i) => x === b[i]);
    if (inOrder && best >= lastMatch) correct++;
    lastMatch = Math.max(lastMatch, best);
  }
  return { correct, total: ref.length };
}
