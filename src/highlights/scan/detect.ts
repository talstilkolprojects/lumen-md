/**
 * Finding what was marked on a photographed page (plan W7.2): highlighter
 * colour by an HSV mask, and pen underlines by thin dark horizontal runs.
 * Pure, on RGBA pixels, so it runs (and is tested) without a canvas.
 *
 * Output: boxes in the image's pixels, one per marked stretch of a text
 * line, in reading order (top to bottom; inside a line, right to left on a
 * Hebrew page). OCR then reads only those boxes.
 */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type MarkColor = "yellow" | "green" | "pink" | "orange" | "blue" | "pen";

export interface Mark {
  box: Box;
  color: MarkColor;
}

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, 4 bytes a pixel (ImageData's layout). */
  data: Uint8ClampedArray | Uint8Array;
}

/** Hue in degrees, saturation and value in 0–1. */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max / 255];
}

/**
 * Highlighter inks by hue. Saturation over 0.25 and value over 0.45 keep out
 * paper (unsaturated), print (dark) and shadows; a highlighter over black
 * text is still dark there, which is why lines are found by rows, not pixels.
 */
const INKS: Array<{ color: Exclude<MarkColor, "pen">; from: number; to: number }> = [
  { color: "pink", from: 300, to: 360 },
  { color: "pink", from: 0, to: 12 },
  { color: "orange", from: 12, to: 40 },
  { color: "yellow", from: 40, to: 70 },
  { color: "green", from: 70, to: 170 },
  { color: "blue", from: 170, to: 250 },
];

export function inkOf(r: number, g: number, b: number): Exclude<MarkColor, "pen"> | null {
  const [h, s, v] = rgbToHsv(r, g, b);
  if (s < 0.25 || v < 0.45) return null;
  for (const ink of INKS) if (h >= ink.from && h < ink.to) return ink.color;
  return null;
}

export interface DetectOptions {
  /** A row counts as marked when this share of a stretch is ink (default 0.35). */
  rowShare?: number;
  /** Shortest marked stretch, as a share of the width (default 0.03). */
  minWidth?: number;
  /** Shortest band, in pixels (default: height / 200, at least 4). */
  minHeight?: number;
  /** Right to left inside a line (a Hebrew page). */
  rtl?: boolean;
  /** Look for pen underlines too (default true). */
  pen?: boolean;
}

/** Group sorted row indices into runs of consecutive rows (allowing `gap` missing rows). */
function runs(rows: number[], gap: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && r - last[1] <= gap + 1) last[1] = r;
    else out.push([r, r]);
  }
  return out;
}

/** Horizontal stretches of `on` columns in [y0, y1], merging gaps under `gap` pixels. */
function stretches(on: (x: number) => boolean, width: number, gap: number, minLen: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  let lastOn = -1;
  for (let x = 0; x < width; x++) {
    if (!on(x)) continue;
    if (start < 0 || x - lastOn > gap) {
      if (start >= 0 && lastOn - start + 1 >= minLen) out.push([start, lastOn]);
      start = x;
    }
    lastOn = x;
  }
  if (start >= 0 && lastOn - start + 1 >= minLen) out.push([start, lastOn]);
  return out;
}

/** Highlighter bands: rows where ink covers enough, then the inked stretches across each band. */
export function highlighterMarks(px: Pixels, opts: DetectOptions = {}): Mark[] {
  const { width: w, height: h, data } = px;
  const minW = Math.max(4, Math.round(w * (opts.minWidth ?? 0.03)));
  const minH = opts.minHeight ?? Math.max(4, Math.round(h / 200));
  const share = opts.rowShare ?? 0.35;
  const ink = new Uint8Array(w * h);
  const counts: Record<string, number> = {};
  const rowInk = new Uint32Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = inkOf(data[i], data[i + 1], data[i + 2]);
      if (!c) continue;
      ink[y * w + x] = INKS.findIndex((k) => k.color === c) + 1;
      rowInk[y]++;
    }
  }
  const rows: number[] = [];
  for (let y = 0; y < h; y++) if (rowInk[y] >= minW * share) rows.push(y);
  const marks: Mark[] = [];
  for (const [y0, y1] of runs(rows, 2)) {
    if (y1 - y0 + 1 < minH) continue;
    const colInk = new Uint32Array(w);
    for (let y = y0; y <= y1; y++) for (let x = 0; x < w; x++) if (ink[y * w + x]) colInk[x]++;
    const need = Math.max(1, (y1 - y0 + 1) * share);
    for (const [x0, x1] of stretches((x) => colInk[x] >= need, w, Math.round(minW / 2), minW)) {
      for (const k of Object.keys(counts)) delete counts[k];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const v = ink[y * w + x];
        if (v) counts[INKS[v - 1].color] = (counts[INKS[v - 1].color] ?? 0) + 1;
      }
      const color = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "yellow") as Exclude<MarkColor, "pen">;
      marks.push({ box: { x0, y0, x1, y1 }, color });
    }
  }
  return marks;
}

const dark = (data: Pixels["data"], i: number) => data[i] + data[i + 1] + data[i + 2] < 3 * 110;

/**
 * Pen underlines: in a band of 7 rows, a long stretch where nearly every
 * column has a little ink (1–4 px of it) is a drawn line, wobbly or slanted
 * as a hand makes it. Print is the opposite: its strokes fill the band
 * where they are, and words leave gaps. The mark is the text line right
 * above, as wide as the underline.
 */
export function underlineMarks(px: Pixels, opts: DetectOptions = {}): Mark[] {
  const { width: w, height: h, data } = px;
  const minW = Math.max(12, Math.round(w * Math.max(0.08, (opts.minWidth ?? 0.03) * 2)));
  const BAND = 7;
  const isDark = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) isDark[k] = dark(data, k * 4) ? 1 : 0;
  const count = new Uint8Array(w);
  const marks: Mark[] = [];
  const taken: Box[] = [];
  for (let yy = 0; yy < Math.min(BAND, h); yy++) for (let x = 0; x < w; x++) count[x] += isDark[yy * w + x];
  for (let y = 0; y + BAND <= h; y++) {
    // The band slides down one row: add the new bottom row, drop the old top one.
    if (y > 0) for (let x = 0; x < w; x++) count[x] += isDark[(y + BAND - 1) * w + x] - isDark[(y - 1) * w + x];
    for (const [x0, x1] of stretches((x) => count[x] > 0, w, 3, minW)) {
      if (taken.some((b) => b.y1 >= y && b.x0 <= x1 && x0 <= b.x1)) continue;
      let covered = 0;
      let ink = 0;
      for (let x = x0; x <= x1; x++) if (count[x]) {
        covered++;
        ink += count[x];
      }
      if (covered / (x1 - x0 + 1) < 0.9 || ink / covered > 4) continue;
      // The band must start at the line: no ink in the row above it across most of the stretch.
      let above = 0;
      if (y > 0) for (let x = x0; x <= x1; x++) above += isDark[(y - 1) * w + x];
      if (above > (x1 - x0 + 1) * 0.5) continue;
      // Text above: some ink in about two line heights over the line, but not a solid area.
      const lineH = Math.max(8, Math.round(h / 60));
      const top = Math.max(0, y - lineH * 2);
      let darkPx = 0;
      let total = 0;
      for (let yy = top; yy < y; yy++) for (let x = x0; x <= x1; x++) {
        total++;
        darkPx += isDark[yy * w + x];
      }
      const density = total ? darkPx / total : 0;
      if (density < 0.03 || density > 0.6) continue;
      // The text's own top: going up from the line, past the blank rows, to the last inked row before the next blank.
      let yBottom = -1;
      let yTop = -1;
      let blank = 0;
      for (let yy = y - 1; yy >= top; yy--) {
        let rowInk = 0;
        for (let x = x0; x <= x1; x++) rowInk += isDark[yy * w + x];
        const inked = rowInk > (x1 - x0 + 1) * 0.02;
        if (inked) {
          if (yBottom < 0) yBottom = yy;
          yTop = yy;
          blank = 0;
        } else if (yBottom >= 0 && ++blank > 2) break;
      }
      if (yBottom < 0) continue;
      taken.push({ x0, y0: y, x1, y1: y + BAND });
      marks.push({ box: { x0, y0: yTop, x1, y1: yBottom }, color: "pen" });
    }
  }
  // A hand-drawn line found in pieces (it wandered out of the band): one mark per text line.
  marks.sort((a, b) => a.box.x0 - b.box.x0);
  const merged: Mark[] = [];
  for (const m of marks) {
    const same = merged.find((x) => overlap(x.box, m.box) > 0.5 && m.box.x0 - x.box.x1 < w * 0.05 && x.box.x0 - m.box.x1 < w * 0.05);
    if (same) same.box = { x0: Math.min(same.box.x0, m.box.x0), y0: Math.min(same.box.y0, m.box.y0), x1: Math.max(same.box.x1, m.box.x1), y1: Math.max(same.box.y1, m.box.y1) };
    else merged.push({ ...m, box: { ...m.box } });
  }
  return merged;
}

function overlap(a: Box, b: Box): number {
  return Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)) / Math.max(1, Math.min(a.y1 - a.y0, b.y1 - b.y0));
}

/** Every mark on the page, in reading order; a pen line inside a highlighted band counts once. */
export function detectMarks(px: Pixels, opts: DetectOptions = {}): Mark[] {
  const hi = highlighterMarks(px, opts);
  const pen = opts.pen === false ? [] : underlineMarks(px, opts).filter((p) => !hi.some((m) => overlap(m.box, p.box) > 0.5 && m.box.x0 <= p.box.x1 && p.box.x0 <= m.box.x1));
  const all = [...hi, ...pen];
  // Same line when the boxes overlap vertically by half; inside a line, by the page's direction.
  all.sort((a, b) => (overlap(a.box, b.box) > 0.5 ? (opts.rtl ? b.box.x1 - a.box.x1 : a.box.x0 - b.box.x0) : a.box.y0 - b.box.y0));
  return all;
}

/** A mark's box grown by a margin (OCR reads a box with some air around the letters better), inside the image. */
export function padBox(b: Box, px: { width: number; height: number }, margin = 4): Box {
  return { x0: Math.max(0, b.x0 - margin), y0: Math.max(0, b.y0 - margin), x1: Math.min(px.width - 1, b.x1 + margin), y1: Math.min(px.height - 1, b.y1 + margin) };
}
