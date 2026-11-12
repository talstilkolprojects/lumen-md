/**
 * Handwriting inside a note (plan W5.27): the ink block's data and its
 * Markdown form.
 *
 * An ink block is an inline `<svg>` written straight into the note:
 *
 *     <svg xmlns="http://www.w3.org/2000/svg" data-lumen-ink="1" data-ink-id="…" …>
 *     <path fill="#1f2937" d="M…Z" data-ink-size="4" data-ink-pts="12.5,8,0.42 …"/>
 *     </svg>
 *
 * - It is a CommonMark HTML block (type 7: a complete start tag alone on
 *   its line, running to the next blank line), so the note stays valid
 *   Markdown and every reader that renders inline HTML — Obsidian's
 *   reading view, Lumen's preview — draws the strokes; one that does not
 *   still keeps the text around it intact. The block never contains a
 *   blank line, and it is written with a blank line before and after.
 * - Each `<path>` carries the drawn outline (`d`, what other apps show) and
 *   the pen samples it came from (`data-ink-pts`: `x,y,pressure` — or `x,y`
 *   for a stroke whose pressure was simulated), so Lumen re-opens the ink
 *   for editing and `toMarkdown(parseInk(md))` gives back the same bytes.
 *   A path without samples (hand-written SVG) is kept as it is.
 * - Placement is decided by the note's direction when the ink was drawn
 *   (`data-ink-dir`), in physical CSS, so the block lands on the same side
 *   in every renderer: on its own line at the start edge (right in a
 *   Hebrew note), or beside the following paragraph, at its end edge
 *   ("study page", `data-ink-place="side"`).
 *
 * Pure: no DOM, no React — runs in a worker or Node.
 */
import { strokeOutline } from "./inkPath";

export interface InkPoint {
  x: number;
  y: number;
  /** Pen pressure 0…1; 0.5 for simulated strokes. */
  p: number;
}

export interface InkStroke {
  points: InkPoint[];
  /** Base stroke diameter, in SVG units. */
  size: number;
  /** `#rrggbb`. */
  color: string;
  /** Pressure is simulated from speed (mouse, finger), not measured. */
  simulated: boolean;
  /** A path read from SVG that has no samples: kept verbatim, not editable. */
  d?: string;
}

export type InkDir = "rtl" | "ltr";
export type InkPlacement = "block" | "side";

export interface Ink {
  id: string;
  width: number;
  height: number;
  dir: InkDir;
  placement: InkPlacement;
  /** The accessible name stored in the file (`aria-label`). */
  label: string;
  strokes: InkStroke[];
}

export const INK_MARKER = "data-lumen-ink";
const COLOR = /^#[0-9a-f]{6}$/i;
const PAD = 8;
const MIN_SIDE = 40;

/** A number with at most `digits` decimals and no trailing zeros (`-0` → `0`). */
export function fmt(n: number, digits = 1): string {
  const s = n.toFixed(digits).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

/** Round a pen sample the way it is stored, so a parsed ink equals the drawn one. */
export function roundPoint(x: number, y: number, p: number): InkPoint {
  return { x: Number(fmt(x)), y: Number(fmt(y)), p: Number(fmt(Math.min(1, Math.max(0, p)), 2)) };
}

export function newInkId(rand: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rand() * 36)];
  return s;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/** The inline style that places the block; physical sides, from the drawing's direction. */
export function placementStyle(ink: Pick<Ink, "dir" | "placement">): string {
  if (ink.placement === "side") {
    // Beside the text, at the end of the line: the left in a Hebrew note.
    return ink.dir === "rtl"
      ? "float:left;width:45%;height:auto;margin:0 1em 0.5em 0"
      : "float:right;width:45%;height:auto;margin:0 0 0.5em 1em";
  }
  // On its own line, at the start edge: the right in a Hebrew note.
  return `display:block;max-width:100%;height:auto;${ink.dir === "rtl" ? "margin-left:auto" : "margin-right:auto"}`;
}

function encodePoints(s: InkStroke): string {
  return s.points.map((pt) => (s.simulated ? `${fmt(pt.x)},${fmt(pt.y)}` : `${fmt(pt.x)},${fmt(pt.y)},${fmt(pt.p, 2)}`)).join(" ");
}

function decodePoints(raw: string): { points: InkPoint[]; simulated: boolean } | null {
  const points: InkPoint[] = [];
  let simulated: boolean | null = null;
  for (const tok of raw.trim().split(/\s+/)) {
    if (!tok) continue;
    const parts = tok.split(",").map(Number);
    if ((parts.length !== 2 && parts.length !== 3) || parts.some((n) => !Number.isFinite(n))) return null;
    const sim = parts.length === 2;
    if (simulated === null) simulated = sim;
    else if (simulated !== sim) return null;
    points.push({ x: parts[0], y: parts[1], p: sim ? 0.5 : parts[2] });
  }
  return points.length ? { points, simulated: simulated ?? true } : null;
}

/** Move the drawing so its strokes start `PAD` from the top-left, and fit the size to them. */
export function cropInk(ink: Ink): Ink {
  const live = ink.strokes.filter((s) => s.points.length);
  if (!live.length || ink.strokes.some((s) => s.d !== undefined)) return ink;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of live)
    for (const p of s.points) {
      const r = s.size / 2;
      minX = Math.min(minX, p.x - r);
      minY = Math.min(minY, p.y - r);
      maxX = Math.max(maxX, p.x + r);
      maxY = Math.max(maxY, p.y + r);
    }
  const dx = Math.round(PAD - minX);
  const dy = Math.round(PAD - minY);
  return {
    ...ink,
    width: Math.max(MIN_SIDE, Math.ceil(maxX - minX + 2 * PAD)),
    height: Math.max(MIN_SIDE, Math.ceil(maxY - minY + 2 * PAD)),
    strokes: live.map((s) => ({ ...s, points: s.points.map((p) => roundPoint(p.x + dx, p.y + dy, p.p)) })),
  };
}

/** The ink as its Markdown HTML block (no surrounding blank lines). */
export function toMarkdown(ink: Ink): string {
  const w = Math.max(1, Math.round(ink.width));
  const h = Math.max(1, Math.round(ink.height));
  const head =
    `<svg xmlns="http://www.w3.org/2000/svg" ${INK_MARKER}="1" data-ink-id="${escapeAttr(ink.id)}" data-ink-dir="${ink.dir}" data-ink-place="${ink.placement}"` +
    ` viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${escapeAttr(ink.label)}" style="${placementStyle(ink)}">`;
  const lines = [head];
  for (const s of ink.strokes) {
    const color = COLOR.test(s.color) ? s.color.toLowerCase() : "#1f2937";
    if (s.d !== undefined) {
      lines.push(`<path fill="${color}" d="${escapeAttr(s.d)}"/>`);
      continue;
    }
    if (!s.points.length) continue;
    lines.push(`<path fill="${color}" d="${strokeOutline(s)}" data-ink-size="${fmt(s.size)}" data-ink-pts="${encodePoints(s)}"/>`);
  }
  lines.push("</svg>");
  return lines.join("\n");
}

/** The ink block written into a note: blank lines around it, so it is its own HTML block. */
export function toInsertion(ink: Ink): string {
  return `\n\n${toMarkdown(ink)}\n\n`;
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][\w.:-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) out[m[1].toLowerCase()] = unescapeAttr(m[2]);
  return out;
}

/** Read an ink block (`<svg data-lumen-ink …>…</svg>`); null if `block` is not one. */
export function parseInk(block: string): Ink | null {
  const open = /^\s*<svg\b([^>]*)>/i.exec(block);
  if (!open) return null;
  const a = attrs(open[1]);
  if (a[INK_MARKER] !== "1") return null;
  const view = (a.viewbox ?? "").trim().split(/[\s,]+/).map(Number);
  const width = Number(a.width) || view[2] || 0;
  const height = Number(a.height) || view[3] || 0;
  if (!(width > 0 && height > 0)) return null;
  const strokes: InkStroke[] = [];
  const pathRe = /<path\b([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  const body = block.slice(open[0].length);
  while ((m = pathRe.exec(body)) !== null) {
    const p = attrs(m[1]);
    const color = COLOR.test(p.fill ?? "") ? p.fill.toLowerCase() : "#1f2937";
    const pts = p["data-ink-pts"] !== undefined ? decodePoints(p["data-ink-pts"]) : null;
    const size = Number(p["data-ink-size"]);
    if (pts && size > 0) strokes.push({ points: pts.points, simulated: pts.simulated, size, color });
    else if (p.d) strokes.push({ points: [], simulated: true, size: 0, color, d: p.d });
  }
  return {
    id: a["data-ink-id"] || newInkId(),
    width,
    height,
    dir: a["data-ink-dir"] === "ltr" ? "ltr" : "rtl",
    placement: a["data-ink-place"] === "side" ? "side" : "block",
    label: a["aria-label"] ?? "",
    strokes,
  };
}

/**
 * The direction of the text around `pos`: the first strong character of the
 * paragraph before it (else of the note, else `fallback`). Hebrew and Arabic
 * letters are right-to-left, Latin letters left-to-right.
 */
export function textDirAt(markdown: string, pos: number, fallback: InkDir): InkDir {
  const strong = (s: string): InkDir | null => {
    const m = /[A-Za-z\u00C0-\u024F\u0590-\u05FF\u0600-\u06FF\uFB1D-\uFDFF\uFE70-\uFEFC]/.exec(s.replace(/<[^>]*>/g, ""));
    if (!m) return null;
    return /[A-Za-z\u00C0-\u024F]/.test(m[0]) ? "ltr" : "rtl";
  };
  const before = markdown.slice(0, pos).split(/\n[ \t]*\n/);
  for (let i = before.length - 1; i >= 0; i--) {
    const d = strong(before[i].replace(/^---[\s\S]*?\n---/, ""));
    if (d) return d;
  }
  return strong(markdown.slice(pos)) ?? fallback;
}

export interface InkBlockRange {
  id: string;
  /** Offset of the `<svg` line. */
  start: number;
  /** Offset just past `</svg>`. */
  end: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Every ink block of a note, outside code fences. */
export function findInkBlocks(markdown: string): InkBlockRange[] {
  const out: InkBlockRange[] = [];
  let fence: string | null = null;
  let pos = 0;
  let open: { start: number; id: string } | null = null;
  for (const line of markdown.split("\n")) {
    const lineStart = pos;
    pos += line.length + 1;
    if (open) {
      if (/^\s*$/.test(line)) open = null; // a blank line ends the HTML block: not one of ours
      else if (/<\/svg>\s*\r?$/i.test(line)) {
        out.push({ id: open.id, start: open.start, end: lineStart + line.replace(/\s*\r?$/, "").length });
        open = null;
      }
      continue;
    }
    const f = FENCE.exec(line);
    if (f) {
      if (!fence) fence = f[1][0].repeat(f[1].length);
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*\r?$/.test(line)) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^ {0,3}<svg\b/i.test(line) && line.includes(`${INK_MARKER}="1"`)) {
      const id = /data-ink-id="([^"]*)"/.exec(line)?.[1] ?? "";
      open = { start: lineStart + line.length - line.trimStart().length, id };
    }
  }
  return out;
}

/** The ink block that contains offset `pos` (a cursor), if any. */
export function inkBlockAt(markdown: string, pos: number): InkBlockRange | null {
  return findInkBlocks(markdown).find((b) => pos >= b.start && pos <= b.end) ?? null;
}

/** `markdown` with the block `range` replaced by `ink` (or removed, with its blank lines, when `ink` has no strokes). */
export function replaceInkBlock(markdown: string, range: InkBlockRange, ink: Ink): string {
  if (!ink.strokes.length) {
    const before = markdown.slice(0, range.start).replace(/\n+$/, "\n");
    const after = markdown.slice(range.end).replace(/^\n+/, before ? "\n" : "");
    return before + after;
  }
  return markdown.slice(0, range.start) + toMarkdown(ink) + markdown.slice(range.end);
}
