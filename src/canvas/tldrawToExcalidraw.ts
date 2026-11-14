/**
 * tldraw → Excalidraw scene converter (plan 4.19, step 2).
 *
 * Pure and dependency-free on purpose: no imports at all, so it can run in a
 * worker, in Node, or in the one-shot vault migration without pulling tldraw
 * or Excalidraw into the bundle, and it can never touch the network.
 *
 * Input — any of the three shapes a tldraw canvas is stored in:
 *   - `getSnapshot(editor.store)` (what `CanvasTldraw.tsx` writes to
 *     `canvases/<name>.tldr`): `{ document: { store, schema }, session }`
 *   - a store snapshot: `{ store: { [id]: record }, schema }` (the legacy
 *     `.canvas.json` → `.tldr` converter writes this one)
 *   - a `.tldr` file exported by tldraw: `{ tldrawFileFormatVersion, records: [] }`
 *
 * Output — an Excalidraw scene file (`{ type: "excalidraw", version: 2, … }`)
 * plus a list of warnings. Nothing is dropped silently: a shape with no
 * Excalidraw equivalent becomes a dashed, labelled rectangle and a warning.
 *
 * Ids are stable (`shape:abc` → `abc`), and converting the same input twice
 * gives byte-identical output (seeds are hashes of the id, timestamps come
 * from `options.updated`).
 *
 * Hebrew / RTL: Excalidraw text has no `dir` field. The text is copied
 * character for character; only the alignment is resolved — tldraw's
 * logical `start`/`end` become `right`/`left` when the text's first strong
 * character is right-to-left, so a Hebrew label stays where it was.
 */

// ---------------------------------------------------------------------------
// Excalidraw scene types (a structural subset of @excalidraw/excalidraw's
// element types — kept local so this module has no dependency).

export type ExFillStyle = "hachure" | "cross-hatch" | "solid" | "zigzag";
export type ExStrokeStyle = "solid" | "dashed" | "dotted";
export type ExArrowhead =
  | "arrow"
  | "bar"
  | "circle"
  | "triangle"
  | "triangle_outline"
  | "diamond";
export type ExTextAlign = "left" | "center" | "right";
export type ExVerticalAlign = "top" | "middle" | "bottom";
export type ExPoint = [number, number];

export interface ExBoundElement {
  id: string;
  type: "text" | "arrow";
}

export interface ExBinding {
  elementId: string;
  focus: number;
  gap: number;
  /** tldraw's normalised anchor inside the target (0..1 on each axis). */
  fixedPoint: ExPoint | null;
}

export interface ExBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: ExFillStyle;
  strokeWidth: number;
  strokeStyle: ExStrokeStyle;
  roughness: number;
  opacity: number;
  groupIds: string[];
  frameId: string | null;
  index: string | null;
  roundness: { type: number } | null;
  seed: number;
  version: number;
  versionNonce: number;
  isDeleted: false;
  boundElements: ExBoundElement[] | null;
  updated: number;
  link: string | null;
  locked: boolean;
  /** Where the element came from: a tldraw shape, or a JSON Canvas node / edge (./jsonCanvas.ts). */
  customData?: { tldrawId?: string; tldrawType?: string; jsonCanvas?: Record<string, unknown> };
}

export interface ExShapeElement extends ExBase {
  type: "rectangle" | "ellipse" | "diamond";
}

export interface ExTextElement extends ExBase {
  type: "text";
  text: string;
  originalText: string;
  fontSize: number;
  fontFamily: number;
  textAlign: ExTextAlign;
  verticalAlign: ExVerticalAlign;
  containerId: string | null;
  autoResize: boolean;
  lineHeight: number;
}

export interface ExLinearElement extends ExBase {
  type: "arrow" | "line";
  points: ExPoint[];
  lastCommittedPoint: null;
  startBinding: ExBinding | null;
  endBinding: ExBinding | null;
  startArrowhead: ExArrowhead | null;
  endArrowhead: ExArrowhead | null;
  elbowed?: boolean;
  polygon?: boolean;
}

export interface ExFreedrawElement extends ExBase {
  type: "freedraw";
  points: ExPoint[];
  pressures: number[];
  simulatePressure: boolean;
  lastCommittedPoint: null;
}

export interface ExCrop {
  x: number;
  y: number;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
}

export interface ExImageElement extends ExBase {
  type: "image";
  fileId: string;
  status: "saved";
  scale: [number, number];
  crop: ExCrop | null;
}

export interface ExFrameElement extends ExBase {
  type: "frame";
  name: string | null;
}

export type ExcalidrawElement =
  | ExShapeElement
  | ExTextElement
  | ExLinearElement
  | ExFreedrawElement
  | ExImageElement
  | ExFrameElement;

export interface ExBinaryFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
  lastRetrieved: number;
}

export interface ExcalidrawFile {
  type: "excalidraw";
  version: 2;
  source: string;
  elements: ExcalidrawElement[];
  appState: { viewBackgroundColor: string; gridSize: number | null; [key: string]: unknown };
  files: Record<string, ExBinaryFile>;
}

// ---------------------------------------------------------------------------
// Result types.

export type ConversionWarningCode =
  /** A shape type this converter doesn't know — kept as a labelled rectangle. */
  | "unknown-shape"
  /** A known tldraw shape with no Excalidraw element (video, embed, bookmark). */
  | "unsupported-shape"
  /** A geo shape Excalidraw has no primitive for — drawn as a polygon / ellipse. */
  | "approximated-geo"
  /** An elbow arrow — drawn as a straight one. */
  | "elbow-arrow"
  /** A frame inside a frame — Excalidraw frames don't nest. */
  | "nested-frame"
  /** An image whose asset is missing or isn't embedded (remote URL). */
  | "image-not-embedded"
  /** An arrow binding whose target is gone or can't hold a binding. */
  | "binding-dropped"
  /** A draw stroke whose points couldn't be read. */
  | "draw-unreadable"
  /** A second (third…) tldraw page — placed to the right of the previous one. */
  | "extra-page";

export interface ConversionWarning {
  code: ConversionWarningCode;
  /** The tldraw record id (shape, page or binding). */
  recordId: string;
  /** The tldraw shape type (or "page" / "binding"). */
  recordType: string;
  detail?: string;
}

export interface ConversionStats {
  /** tldraw shape records read. */
  shapes: number;
  /** Excalidraw elements written (labels count separately). */
  elements: number;
  byTldrawType: Record<string, number>;
  byElementType: Record<string, number>;
}

export interface ConversionResult {
  file: ExcalidrawFile;
  warnings: ConversionWarning[];
  stats: ConversionStats;
}

export interface ConvertOptions {
  /** `source` field of the scene file. */
  source?: string;
  /** `updated` / `created` timestamp for every element and file (default 0 — deterministic). */
  updated?: number;
}

export class TldrawFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TldrawFormatError";
  }
}

// ---------------------------------------------------------------------------
// tldraw record access. Records are untyped JSON: every read is defensive.

export interface TlRecord {
  id: string;
  typeName: string;
  [key: string]: unknown;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}
function props(r: TlRecord): Obj {
  return isObj(r.props) ? r.props : {};
}

function isRecord(v: unknown): v is TlRecord {
  return isObj(v) && typeof v.id === "string" && typeof v.typeName === "string";
}

/**
 * Pull the record list out of any of the stored tldraw formats.
 * Throws `TldrawFormatError` when the input isn't a tldraw canvas.
 */
export function extractTldrawRecords(input: unknown): TlRecord[] {
  let data: unknown = input;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data) as unknown;
    } catch {
      throw new TldrawFormatError("not JSON");
    }
  }
  if (!isObj(data)) throw new TldrawFormatError("not a tldraw canvas");
  let list: unknown[];
  if (isObj(data.document) && isObj(data.document.store)) {
    list = Object.values(data.document.store);
  } else if (isObj(data.store)) {
    list = Object.values(data.store);
  } else if (Array.isArray(data.records)) {
    list = data.records;
  } else {
    throw new TldrawFormatError("no tldraw store or records");
  }
  return list.filter(isRecord);
}

// ---------------------------------------------------------------------------
// Style mapping (tldraw default style values → Excalidraw).

/** tldraw's light-theme solid colours. */
const COLORS: Record<string, string> = {
  black: "#1d1d1d",
  grey: "#9fa8b2",
  "light-violet": "#e085f4",
  violet: "#ae3ec9",
  blue: "#4465e9",
  "light-blue": "#4ba1f1",
  yellow: "#f1ac4b",
  orange: "#e16919",
  green: "#099268",
  "light-green": "#4cb05e",
  "light-red": "#f87777",
  red: "#e03131",
  white: "#ffffff",
};
/** tldraw's light-theme `semi` colours — what `fill: "solid"` paints. */
const TINTS: Record<string, string> = {
  black: "#e8e8e8",
  grey: "#eceef0",
  "light-violet": "#f5eafa",
  violet: "#ecdcf2",
  blue: "#dce1f8",
  "light-blue": "#ddedfa",
  yellow: "#f9f0e6",
  orange: "#f8e2d4",
  green: "#d3e9e3",
  "light-green": "#dbf0e0",
  "light-red": "#f4dadb",
  red: "#f4dadb",
  white: "#f5f5f5",
};
/** tldraw light theme `solid` — what `fill: "semi"` paints. */
const SEMI_FILL = "#fcfffe";
/** Sticky-note paper colours (tldraw light theme `note.fill`). */
const NOTE_FILLS: Record<string, string> = {
  black: "#2c2c2c",
  grey: "#e3e7eb",
  "light-violet": "#f1c4fb",
  violet: "#dca9ec",
  blue: "#bccafa",
  "light-blue": "#a9d6fb",
  yellow: "#fed49a",
  orange: "#fbc29c",
  green: "#9cdfc9",
  "light-green": "#b0e5b8",
  "light-red": "#fbbcbc",
  red: "#fca4a4",
  white: "#ffffff",
};

function color(name: unknown): string {
  return COLORS[str(name, "black")] ?? COLORS.black;
}
function tint(name: unknown): string {
  return TINTS[str(name, "black")] ?? TINTS.black;
}

const STROKE_WIDTHS: Record<string, number> = { s: 1, m: 2, l: 4, xl: 6 };
/** tldraw FONT_SIZES (text shapes). */
const TEXT_FONT_SIZES: Record<string, number> = { s: 18, m: 24, l: 36, xl: 44 };
/** tldraw LABEL_FONT_SIZES (geo and note labels). */
const LABEL_FONT_SIZES: Record<string, number> = { s: 18, m: 22, l: 26, xl: 32 };
/** tldraw ARROW_LABEL_FONT_SIZES. */
const ARROW_FONT_SIZES: Record<string, number> = { s: 18, m: 20, l: 24, xl: 28 };

/** Excalidraw font families: 3 Cascadia, 5 Excalifont, 6 Nunito. */
const FONTS: Record<string, number> = { draw: 5, sans: 6, serif: 6, mono: 3 };

function strokeWidth(size: unknown): number {
  return STROKE_WIDTHS[str(size, "m")] ?? 2;
}
function fontFamily(font: unknown): number {
  return FONTS[str(font, "draw")] ?? 5;
}

function strokeStyle(dash: unknown): { strokeStyle: ExStrokeStyle; roughness: number } {
  switch (dash) {
    case "dashed":
      return { strokeStyle: "dashed", roughness: 0 };
    case "dotted":
      return { strokeStyle: "dotted", roughness: 0 };
    case "solid":
      return { strokeStyle: "solid", roughness: 0 };
    default: // "draw" — tldraw's hand-drawn line
      return { strokeStyle: "solid", roughness: 1 };
  }
}

function fill(fillName: unknown, colorName: unknown): { backgroundColor: string; fillStyle: ExFillStyle } {
  switch (fillName) {
    // tldraw's naming is crossed: "semi" paints the near-white theme
    // background, "solid" the colour's pale tint, "fill" the full colour.
    case "semi":
      return { backgroundColor: SEMI_FILL, fillStyle: "solid" };
    case "solid":
      return { backgroundColor: tint(colorName), fillStyle: "solid" };
    case "fill":
      return { backgroundColor: color(colorName), fillStyle: "solid" };
    case "pattern":
      return { backgroundColor: color(colorName), fillStyle: "hachure" };
    default:
      return { backgroundColor: "transparent", fillStyle: "solid" };
  }
}

const ARROWHEADS: Record<string, ExArrowhead | null> = {
  none: null,
  arrow: "arrow",
  triangle: "triangle",
  inverted: "triangle_outline",
  square: "diamond",
  diamond: "diamond",
  dot: "circle",
  pipe: "bar",
  bar: "bar",
};
function arrowhead(v: unknown, fallback: ExArrowhead | null): ExArrowhead | null {
  const key = str(v, "");
  return key in ARROWHEADS ? (ARROWHEADS[key] ?? null) : fallback;
}

// ---------------------------------------------------------------------------
// Text helpers.

/** Plain text of a tldraw rich-text (TipTap) document. Characters are kept as-is. */
export function richTextToPlain(node: unknown): string {
  if (!isObj(node)) return "";
  const type = node.type;
  const content = Array.isArray(node.content) ? node.content : [];
  switch (type) {
    case "text":
      return str(node.text, "");
    case "hardBreak":
      return "\n";
    case "doc":
    case "blockquote":
    case "listItem":
      return content.map(richTextToPlain).join("\n");
    case "bulletList":
      return content.map((c) => "• " + richTextToPlain(c)).join("\n");
    case "orderedList": {
      const start = isObj(node.attrs) ? num(node.attrs.start, 1) : 1;
      return content.map((c, i) => `${start + i}. ` + richTextToPlain(c)).join("\n");
    }
    default:
      return content.map(richTextToPlain).join("");
  }
}

/** The text of a shape — `richText` (tldraw ≥ 3.10) or the older `text` string. */
function shapeText(p: Obj): string {
  if (isObj(p.richText)) return richTextToPlain(p.richText);
  return str(p.text, "");
}

const RTL_STRONG = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LTR_STRONG = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;

/** True when the first strong-direction character of `text` is right-to-left. */
export function isRtlText(text: string): boolean {
  for (const ch of text) {
    if (RTL_STRONG.test(ch)) return true;
    if (LTR_STRONG.test(ch)) return false;
  }
  return false;
}

function textAlign(align: unknown, text: string): ExTextAlign {
  const a = str(align, "middle").replace(/-legacy$/, "");
  if (a === "middle") return "center";
  const rtl = isRtlText(text);
  if (a === "start") return rtl ? "right" : "left";
  if (a === "end") return rtl ? "left" : "right";
  return "center";
}

function verticalAlign(v: unknown): ExVerticalAlign {
  return v === "start" ? "top" : v === "end" ? "bottom" : "middle";
}

const LINE_HEIGHT = 1.25;
/** Excalidraw's BOUND_TEXT_PADDING: the gap between a container and its text. */
const BOUND_TEXT_PADDING = 5;

const WIDE_CHAR = /[\u2E80-\u9FFF\uAC00-\uD7AF\uFF00-\uFFEF]/;

/** Estimated width of one line, in ems. */
function lineEms(line: string): number {
  let w = 0;
  for (const ch of line) w += WIDE_CHAR.test(ch) ? 1 : 0.55;
  return w;
}

/**
 * Greedy word wrap at `width` px, as Excalidraw stores a fixed-width text's
 * `text` (with `originalText` holding the source). Only line breaks are
 * inserted at spaces (or inside a word longer than the line).
 */
export function wrapText(text: string, fontSize: number, width: number): string {
  const max = width / fontSize;
  return text
    .split("\n")
    .map((line) => {
      const out: string[] = [];
      let cur = "";
      for (const word of line.split(/(?<=\s)/)) {
        if (cur && lineEms(cur + word.trimEnd()) > max) {
          out.push(cur.trimEnd());
          cur = "";
        }
        let w = word;
        while (!cur && lineEms(w.trimEnd()) > max && w.length > 1) {
          let n = 1;
          while (n < w.length && lineEms(w.slice(0, n + 1)) <= max) n++;
          out.push(w.slice(0, n));
          w = w.slice(n);
        }
        cur += w;
      }
      out.push(cur.trimEnd());
      return out.join("\n");
    })
    .join("\n");
}

/** Rough text box (Excalidraw re-measures text when it is edited). */
export function measureText(text: string, fontSize: number): { width: number; height: number } {
  const lines = text.split("\n");
  let widest = 0;
  for (const line of lines) widest = Math.max(widest, lineEms(line));
  return {
    width: round(Math.max(widest * fontSize, fontSize * 0.5)),
    height: round(lines.length * fontSize * LINE_HEIGHT),
  };
}

// ---------------------------------------------------------------------------
// Geometry.

interface Transform {
  x: number;
  y: number;
  rotation: number;
}

function rotate(x: number, y: number, r: number): ExPoint {
  if (r === 0) return [x, y];
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function normAngle(r: number): number {
  const t = Math.PI * 2;
  const a = ((r % t) + t) % t;
  return a < 1e-9 || t - a < 1e-9 ? 0 : a;
}

/** Excalidraw box (x, y = unrotated top-left, rotation about the centre) from a tldraw box (rotation about the origin). */
function boxFrom(t: Transform, w: number, h: number): { x: number; y: number; angle: number } {
  const [cx, cy] = rotate(w / 2, h / 2, t.rotation);
  return {
    x: round(t.x + cx - w / 2),
    y: round(t.y + cy - h / 2),
    angle: normAngle(t.rotation),
  };
}

/** Page point of a shape-local point. */
function toPage(t: Transform, x: number, y: number): ExPoint {
  const [rx, ry] = rotate(x, y, t.rotation);
  return [t.x + rx, t.y + ry];
}

/** Excalidraw linear-element placement from absolute points: origin at the first point. */
function linearFrom(abs: ExPoint[]): { x: number; y: number; width: number; height: number; points: ExPoint[] } {
  const pts = abs.length > 0 ? abs : [[0, 0] as ExPoint];
  const [ox, oy] = pts[0];
  const points = pts.map(([x, y]) => [round(x - ox), round(y - oy)] as ExPoint);
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { x: round(ox), y: round(oy), width: round(maxX - minX), height: round(maxY - minY), points };
}

/** Unit-box vertices for the geo kinds Excalidraw draws as closed lines. */
function polygonFor(geo: string): ExPoint[] | null {
  const regular = (n: number, start: number): ExPoint[] =>
    Array.from({ length: n }, (_, i) => {
      const a = start + (i * Math.PI * 2) / n;
      return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)] as ExPoint;
    });
  switch (geo) {
    case "triangle":
      return [[0.5, 0], [1, 1], [0, 1]];
    case "trapezoid":
      return [[0.25, 0], [0.75, 0], [1, 1], [0, 1]];
    case "rhombus":
      return [[0.25, 0], [1, 0], [0.75, 1], [0, 1]];
    case "rhombus-2":
      return [[0, 0], [0.75, 0], [1, 1], [0.25, 1]];
    case "pentagon":
      return regular(5, -Math.PI / 2);
    case "hexagon":
      return [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]];
    case "octagon":
      return regular(8, -Math.PI / 2 + Math.PI / 8);
    case "star":
      return Array.from({ length: 10 }, (_, i) => {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 === 0 ? 0.5 : 0.2;
        return [0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)] as ExPoint;
      });
    case "arrow-right":
      return [[0, 0.25], [0.6, 0.25], [0.6, 0], [1, 0.5], [0.6, 1], [0.6, 0.75], [0, 0.75]];
    case "arrow-left":
      return [[1, 0.25], [0.4, 0.25], [0.4, 0], [0, 0.5], [0.4, 1], [0.4, 0.75], [1, 0.75]];
    case "arrow-up":
      return [[0.25, 1], [0.25, 0.4], [0, 0.4], [0.5, 0], [1, 0.4], [0.75, 0.4], [0.75, 1]];
    case "arrow-down":
      return [[0.25, 0], [0.25, 0.6], [0, 0.6], [0.5, 1], [1, 0.6], [0.75, 0.6], [0.75, 0]];
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Draw-stroke points. Older tldraw stores `segments[].points` as `{x,y,z}`
// arrays; tldraw 4.5 (draw schema v4, highlight v3) stores `segments[].path`.

function decodeBase64(s: string): Uint8Array | null {
  const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = s.replace(/[\s=]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = ABC.indexOf(ch);
    if (v < 0) return null;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function float16(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 0x1f) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

/**
 * Points of a base64 `path` (tldraw 4.5 `b64Vecs`): the first point as three
 * little-endian float32 (x, y, z), then each following point as three
 * float16 deltas from the previous one. Null when the bytes don't fit that
 * layout or decode to non-finite numbers.
 */
export function decodeDrawPath(path: string): { x: number; y: number; z: number }[] | null {
  if (path === "") return [];
  const bytes = decodeBase64(path);
  if (!bytes || bytes.length < 12 || (bytes.length - 12) % 6 !== 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let x = view.getFloat32(0, true);
  let y = view.getFloat32(4, true);
  let z = view.getFloat32(8, true);
  const out = [{ x, y, z }];
  for (let i = 12; i < bytes.length; i += 6) {
    x += float16(view.getUint16(i, true));
    y += float16(view.getUint16(i + 2, true));
    z += float16(view.getUint16(i + 4, true));
    out.push({ x, y, z });
  }
  return out.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) ? out : null;
}

function segmentPoints(seg: unknown): { x: number; y: number; z: number }[] | null {
  if (!isObj(seg)) return null;
  if (Array.isArray(seg.points)) {
    return seg.points.filter(isObj).map((p) => ({ x: num(p.x, 0), y: num(p.y, 0), z: num(p.z, 0.5) }));
  }
  if (typeof seg.path === "string") return decodeDrawPath(seg.path);
  return null;
}

// ---------------------------------------------------------------------------
// Ids and seeds.

/** FNV-1a 32-bit — a deterministic seed from an id. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2147483647 || 1;
}

/** Excalidraw id of a tldraw id: the `shape:` / `asset:` prefix is dropped. */
export function excalidrawIdOf(tldrawId: string): string {
  return tldrawId.replace(/^(shape|asset):/, "");
}

// ---------------------------------------------------------------------------
// The converter.

const BINDABLE = new Set(["rectangle", "ellipse", "diamond", "text", "image", "frame"]);

interface WalkContext {
  t: Transform;
  groupIds: string[];
  frameId: string | null;
}

export function tldrawToExcalidraw(input: unknown, options: ConvertOptions = {}): ConversionResult {
  const records = extractTldrawRecords(input);
  const updated = options.updated ?? 0;
  const warnings: ConversionWarning[] = [];
  const byTldrawType: Record<string, number> = {};

  const byId = new Map<string, TlRecord>();
  const children = new Map<string, TlRecord[]>();
  const pages: TlRecord[] = [];
  const bindingsByArrow = new Map<string, TlRecord[]>();
  let gridSize: number | null = null;

  for (const r of records) byId.set(r.id, r);
  for (const r of records) {
    if (r.typeName === "page") pages.push(r);
    else if (r.typeName === "document") gridSize = num(r.gridSize, 10);
    else if (r.typeName === "shape") {
      const parent = str(r.parentId, "");
      const list = children.get(parent) ?? [];
      list.push(r);
      children.set(parent, list);
      const type = str(r.type, "unknown");
      byTldrawType[type] = (byTldrawType[type] ?? 0) + 1;
    } else if (r.typeName === "binding" && r.type === "arrow") {
      const from = str(r.fromId, "");
      const list = bindingsByArrow.get(from) ?? [];
      list.push(r);
      bindingsByArrow.set(from, list);
    }
  }
  const byIndex = (a: TlRecord, b: TlRecord): number => {
    const ia = str(a.index, "");
    const ib = str(b.index, "");
    if (ia !== ib) return ia < ib ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  pages.sort(byIndex);
  for (const list of children.values()) list.sort(byIndex);

  // Shapes whose parent is neither a page nor a shape (a corrupt store):
  // treat them as being on the first page rather than losing them.
  const orphanRoots: TlRecord[] = [];
  for (const [parent, list] of children) {
    const p = byId.get(parent);
    if (!p || (p.typeName !== "page" && p.typeName !== "shape")) orphanRoots.push(...list);
  }
  orphanRoots.sort(byIndex);

  // Reserve every shape's id first, so derived ids (labels, groups) never collide.
  const used = new Set<string>();
  for (const r of records) if (r.typeName === "shape") used.add(excalidrawIdOf(r.id));
  const derivedId = (base: string): string => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}~${n}`;
    used.add(id);
    return id;
  };

  const elements: ExcalidrawElement[] = [];
  const files: Record<string, ExBinaryFile> = {};
  /** Absolute transform and size per shape — for arrows bound in old-format files. */
  const placed = new Map<string, { t: Transform; w: number; h: number }>();
  /** Arrows are finished after every shape is placed (their bindings may point forward). */
  const pendingArrows: { r: TlRecord; el: ExLinearElement; ctx: WalkContext }[] = [];

  const warn = (code: ConversionWarningCode, r: TlRecord, detail?: string): void => {
    warnings.push({ code, recordId: r.id, recordType: r.typeName === "shape" ? str(r.type, "unknown") : r.typeName, ...(detail ? { detail } : {}) });
  };

  const base = (
    id: string,
    r: TlRecord,
    ctx: WalkContext,
    box: { x: number; y: number; width: number; height: number; angle: number },
  ): ExBase => {
    const p = props(r);
    const dash = strokeStyle(p.dash);
    const f = fill(p.fill, p.color);
    return {
      id,
      x: box.x,
      y: box.y,
      width: round(box.width),
      height: round(box.height),
      angle: box.angle,
      strokeColor: color(p.color),
      backgroundColor: f.backgroundColor,
      fillStyle: f.fillStyle,
      strokeWidth: round(strokeWidth(p.size) * num(p.scale, 1)),
      strokeStyle: dash.strokeStyle,
      roughness: dash.roughness,
      opacity: Math.round(Math.min(1, Math.max(0, num(r.opacity, 1))) * 100),
      groupIds: [...ctx.groupIds],
      frameId: ctx.frameId,
      index: null,
      roundness: null,
      seed: hash32(id),
      version: 1,
      versionNonce: hash32(id + ":nonce"),
      isDeleted: false,
      boundElements: null,
      updated,
      link: typeof p.url === "string" && p.url ? p.url : null,
      locked: r.isLocked === true,
      customData: { tldrawId: r.id, tldrawType: str(r.type, "unknown") },
    };
  };

  const textElement = (
    id: string,
    r: TlRecord,
    ctx: WalkContext,
    text: string,
    fontSize: number,
    opts: {
      center: ExPoint;
      angle: number;
      align: ExTextAlign;
      valign: ExVerticalAlign;
      containerId: string | null;
      strokeColor: string;
      /** Fixed width: the text wraps at it and doesn't auto-resize. */
      width?: number;
      /** Wrap at this width but keep auto-resizing (labels inside a container). */
      wrapAt?: number;
    },
  ): ExTextElement => {
    const wrapWidth = opts.width ?? opts.wrapAt;
    const shown = wrapWidth === undefined ? text : wrapText(text, fontSize, wrapWidth);
    const m = measureText(shown, fontSize);
    const width = opts.width ?? m.width;
    const el: ExTextElement = {
      ...base(id, r, ctx, {
        x: round(opts.center[0] - width / 2),
        y: round(opts.center[1] - m.height / 2),
        width,
        height: m.height,
        angle: opts.angle,
      }),
      type: "text",
      strokeColor: opts.strokeColor,
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeStyle: "solid",
      roughness: 0,
      link: null,
      text: shown,
      originalText: text,
      fontSize,
      fontFamily: fontFamily(props(r).font),
      textAlign: opts.align,
      verticalAlign: opts.valign,
      containerId: opts.containerId,
      autoResize: opts.width === undefined,
      lineHeight: LINE_HEIGHT,
    };
    return el;
  };

  /** A bound label inside a container element. */
  const addLabel = (
    container: ExBase,
    r: TlRecord,
    ctx: WalkContext,
    text: string,
    fontSize: number,
    p: Obj,
  ): void => {
    if (!text) return;
    const id = derivedId(`${container.id}-label`);
    const center: ExPoint = [container.x + container.width / 2, container.y + container.height / 2];
    elements.push(
      textElement(id, r, ctx, text, fontSize, {
        center,
        angle: container.angle,
        align: textAlign(p.align ?? p.textAlign, text),
        valign: verticalAlign(p.verticalAlign),
        containerId: container.id,
        strokeColor: color(p.labelColor ?? p.color),
        // Excalidraw stores bound text wrapped to the container's inner width.
        wrapAt: Math.max(fontSize, container.width - 2 * BOUND_TEXT_PADDING),
      }),
    );
    container.boundElements = [...(container.boundElements ?? []), { id, type: "text" }];
  };

  /** A dashed, labelled rectangle standing in for a shape with no equivalent. */
  const placeholder = (r: TlRecord, ctx: WalkContext, label: string): void => {
    const p = props(r);
    const w = num(p.w, 160);
    const h = num(p.h, 90);
    const el: ExShapeElement = {
      ...base(excalidrawIdOf(r.id), r, ctx, { ...boxFrom(ctx.t, w, h), width: w, height: h }),
      type: "rectangle",
      strokeStyle: "dashed",
      roughness: 0,
      backgroundColor: "transparent",
      strokeColor: color(p.color ?? "grey"),
    };
    elements.push(el);
    addLabel(el, r, ctx, label, 16, { align: "middle", verticalAlign: "middle", labelColor: p.color ?? "grey" });
  };

  const convertShape = (r: TlRecord, ctx: WalkContext): void => {
    const p = props(r);
    const type = str(r.type, "unknown");
    const id = excalidrawIdOf(r.id);
    const scale = num(p.scale, 1);

    switch (type) {
      case "geo": {
        // w / h are already page units; `scale` only sizes the label and stroke
        // (checked against tldraw's own editor in tldrawToExcalidraw.tldraw.test.ts).
        const w = num(p.w, 100);
        const h = num(p.h, 100) + num(p.growY, 0);
        const geo = str(p.geo, "rectangle");
        const text = shapeText(p);
        const fontSize = (LABEL_FONT_SIZES[str(p.size, "m")] ?? 22) * scale;
        const box = { ...boxFrom(ctx.t, w, h), width: w, height: h };
        const poly = polygonFor(geo);
        if (poly) {
          warn("approximated-geo", r, geo);
          const abs = [...poly, poly[0]].map(([u, v]) => toPage(ctx.t, u * w, v * h));
          const groupId = text ? derivedId(`${id}-group`) : null;
          const inner: WalkContext = groupId ? { ...ctx, groupIds: [groupId, ...ctx.groupIds] } : ctx;
          const lin = linearFrom(abs);
          elements.push({
            ...base(id, r, inner, { ...lin, angle: 0 }),
            type: "line",
            points: lin.points,
            lastCommittedPoint: null,
            startBinding: null,
            endBinding: null,
            startArrowhead: null,
            endArrowhead: null,
            polygon: true,
          });
          if (text) {
            const [cx, cy] = toPage(ctx.t, w / 2, h / 2);
            elements.push(
              textElement(derivedId(`${id}-label`), r, inner, text, fontSize, {
                center: [cx, cy],
                angle: box.angle,
                align: textAlign(p.align, text),
                valign: "middle",
                containerId: null,
                strokeColor: color(p.labelColor ?? p.color),
                wrapAt: Math.max(fontSize, w - 2 * BOUND_TEXT_PADDING),
              }),
            );
          }
          placed.set(r.id, { t: ctx.t, w, h });
          return;
        }
        let kind: ExShapeElement["type"] = "rectangle";
        if (geo === "ellipse") kind = "ellipse";
        else if (geo === "oval") {
          kind = "ellipse";
          warn("approximated-geo", r, geo);
        }
        else if (geo === "diamond") kind = "diamond";
        else if (geo === "cloud" || geo === "heart") {
          kind = "ellipse";
          warn("approximated-geo", r, geo);
        } else if (geo !== "rectangle") {
          // check-box / x-box lose their inner mark; an unknown kind is drawn as a box.
          warn("approximated-geo", r, geo);
        }
        const el: ExShapeElement = { ...base(id, r, ctx, box), type: kind };
        elements.push(el);
        addLabel(el, r, ctx, text, fontSize, p);
        placed.set(r.id, { t: ctx.t, w, h });
        return;
      }

      case "note": {
        const size = 200 * scale;
        const h = 200 * scale + num(p.growY, 0) * scale;
        const box = { ...boxFrom(ctx.t, size, h), width: size, height: h };
        const el: ExShapeElement = {
          ...base(id, r, ctx, box),
          type: "rectangle",
          backgroundColor: NOTE_FILLS[str(p.color, "yellow")] ?? NOTE_FILLS.yellow,
          fillStyle: "solid",
          strokeColor: "transparent",
          strokeStyle: "solid",
          roughness: 0,
        };
        elements.push(el);
        // fontSizeAdjustment: 0 = the preset; tldraw stores the shrunk-to-fit size
        // (read as a ratio of the preset when it is at most 1).
        const preset = LABEL_FONT_SIZES[str(p.size, "m")] ?? 22;
        const adj = num(p.fontSizeAdjustment, 0);
        const fontSize = (adj <= 0 ? preset : adj <= 1 ? preset * adj : adj) * scale;
        addLabel(el, r, ctx, shapeText(p), fontSize, {
          ...p,
          labelColor: p.labelColor ?? (p.color === "black" ? "white" : "black"),
        });
        placed.set(r.id, { t: ctx.t, w: size, h });
        return;
      }

      case "text": {
        const text = shapeText(p);
        const fontSize = (TEXT_FONT_SIZES[str(p.size, "m")] ?? 24) * scale;
        const m = measureText(text, fontSize);
        const fixed = p.autoSize === false;
        const w = fixed ? num(p.w, m.width) * scale : m.width;
        const h = fixed ? measureText(wrapText(text, fontSize, w), fontSize).height : m.height;
        const center = toPage(ctx.t, w / 2, h / 2);
        elements.push(
          textElement(id, r, ctx, text, fontSize, {
            center,
            angle: normAngle(ctx.t.rotation),
            align: textAlign(p.textAlign ?? p.align ?? "start", text),
            valign: "top",
            containerId: null,
            strokeColor: color(p.color),
            ...(fixed ? { width: round(w) } : {}),
          }),
        );
        placed.set(r.id, { t: ctx.t, w, h });
        return;
      }

      case "frame": {
        const w = num(p.w, 160);
        const h = num(p.h, 90);
        const el: ExFrameElement = {
          ...base(id, r, ctx, { ...boxFrom(ctx.t, w, h), width: w, height: h }),
          type: "frame",
          name: str(p.name, "") || null,
          strokeColor: "#bbbbbb",
          backgroundColor: "transparent",
          strokeWidth: 2,
          strokeStyle: "solid",
          roughness: 0,
          frameId: null,
          groupIds: [],
        };
        if (ctx.frameId) warn("nested-frame", r, `inside ${ctx.frameId}`);
        elements.push(el);
        placed.set(r.id, { t: ctx.t, w, h });
        return;
      }

      case "image": {
        const w = num(p.w, 100);
        const h = num(p.h, 100);
        const assetId = str(p.assetId, "");
        const asset = assetId ? byId.get(assetId) : undefined;
        const ap = asset ? props(asset) : {};
        const src = str(ap.src, "") || str(p.url, "");
        if (!src.startsWith("data:")) {
          warn("image-not-embedded", r, src ? "remote image (not downloaded)" : "asset missing");
          placeholder(r, ctx, src ? `[image] ${src}` : "[image]");
          if (src) {
            const last = elements.find((e) => e.id === id);
            if (last) last.link = src;
          }
          placed.set(r.id, { t: ctx.t, w, h });
          return;
        }
        const fileId = excalidrawIdOf(assetId || `asset:${id}`);
        const mime = str(ap.mimeType, "") || /^data:([^;,]+)/.exec(src)?.[1] || "image/png";
        files[fileId] = { id: fileId, mimeType: mime, dataURL: src, created: updated, lastRetrieved: updated };
        let crop: ExCrop | null = null;
        const nw = num(ap.w, 0);
        const nh = num(ap.h, 0);
        if (isObj(p.crop) && nw > 0 && nh > 0 && isObj(p.crop.topLeft) && isObj(p.crop.bottomRight)) {
          const tl = p.crop.topLeft;
          const br = p.crop.bottomRight;
          const x0 = num(tl.x, 0);
          const y0 = num(tl.y, 0);
          const x1 = num(br.x, 1);
          const y1 = num(br.y, 1);
          if (x0 > 0 || y0 > 0 || x1 < 1 || y1 < 1) {
            crop = {
              x: round(x0 * nw),
              y: round(y0 * nh),
              width: round((x1 - x0) * nw),
              height: round((y1 - y0) * nh),
              naturalWidth: nw,
              naturalHeight: nh,
            };
          }
        }
        elements.push({
          ...base(id, r, ctx, { ...boxFrom(ctx.t, w, h), width: w, height: h }),
          type: "image",
          strokeColor: "transparent",
          backgroundColor: "transparent",
          fileId,
          status: "saved",
          scale: [p.flipX === true ? -1 : 1, p.flipY === true ? -1 : 1],
          crop,
        });
        placed.set(r.id, { t: ctx.t, w, h });
        return;
      }

      case "draw":
      case "highlight": {
        const segments = Array.isArray(p.segments) ? p.segments : [];
        const sx = num(p.scaleX, 1);
        const sy = num(p.scaleY, 1);
        const pts: { x: number; y: number; z: number }[] = [];
        let unreadable = false;
        for (const seg of segments) {
          const sp = segmentPoints(seg);
          if (!sp) unreadable = true;
          else pts.push(...sp);
        }
        if (pts.length === 0) {
          warn("draw-unreadable", r, unreadable ? "points could not be decoded" : "no points");
          placeholder(r, ctx, `[${type}]`);
          return;
        }
        if (unreadable) warn("draw-unreadable", r, "some segments could not be decoded");
        if (p.isClosed === true && pts.length > 2) pts.push(pts[0]);
        const lin = linearFrom(pts.map((q) => toPage(ctx.t, q.x * sx, q.y * sy)));
        const highlight = type === "highlight";
        const el: ExFreedrawElement = {
          ...base(id, r, ctx, { ...lin, angle: 0 }),
          type: "freedraw",
          points: lin.points,
          pressures: p.isPen === true ? pts.map((q) => round(q.z)) : [],
          simulatePressure: p.isPen !== true,
          lastCommittedPoint: null,
        };
        if (highlight) {
          el.strokeWidth = el.strokeWidth * 4;
          el.opacity = Math.round(el.opacity * 0.5);
          el.backgroundColor = "transparent";
        }
        elements.push(el);
        return;
      }

      case "line": {
        let raw: unknown[] = [];
        if (isObj(p.points)) raw = Object.values(p.points);
        else if (Array.isArray(p.points)) raw = p.points;
        else if (isObj(p.handles)) raw = Object.values(p.handles);
        const pts = raw
          .filter(isObj)
          .sort((a, b) => {
            const ia = str(a.index, "");
            const ib = str(b.index, "");
            return ia < ib ? -1 : ia > ib ? 1 : 0;
          })
          // Stored points are page units already; `scale` only styles the stroke.
          .map((q) => toPage(ctx.t, num(q.x, 0), num(q.y, 0)));
        if (pts.length < 2) {
          placeholder(r, ctx, "[line]");
          warn("draw-unreadable", r, "line with fewer than two points");
          return;
        }
        const lin = linearFrom(pts);
        elements.push({
          ...base(id, r, ctx, { ...lin, angle: 0 }),
          type: "line",
          backgroundColor: "transparent",
          roundness: p.spline === "cubic" ? { type: 2 } : null,
          points: lin.points,
          lastCommittedPoint: null,
          startBinding: null,
          endBinding: null,
          startArrowhead: null,
          endArrowhead: null,
        });
        return;
      }

      case "arrow": {
        const el: ExLinearElement = {
          ...base(id, r, ctx, { x: ctx.t.x, y: ctx.t.y, width: 0, height: 0, angle: 0 }),
          type: "arrow",
          backgroundColor: "transparent",
          points: [[0, 0]],
          lastCommittedPoint: null,
          startBinding: null,
          endBinding: null,
          startArrowhead: arrowhead(p.arrowheadStart, null),
          endArrowhead: arrowhead(p.arrowheadEnd, "arrow"),
          elbowed: false,
        };
        elements.push(el);
        pendingArrows.push({ r, el, ctx });
        return;
      }

      case "group":
        // Handled by the walker: children carry the group id.
        return;

      case "video":
      case "embed":
      case "bookmark": {
        warn("unsupported-shape", r, type);
        // A video's source lives in its asset; an embedded (data:) video is not carried over.
        const asset = typeof p.assetId === "string" ? byId.get(p.assetId) : undefined;
        const assetSrc = asset ? str(props(asset).src, "") : "";
        const url = str(p.url, "") || (/^https?:/i.test(assetSrc) ? assetSrc : "");
        placeholder(r, ctx, url ? `[${type}] ${url}` : `[${type}]`);
        if (url) {
          const el = elements.find((e) => e.id === id);
          if (el) el.link = url;
        }
        placed.set(r.id, { t: ctx.t, w: num(p.w, 160), h: num(p.h, 90) });
        return;
      }

      default: {
        warn("unknown-shape", r, type);
        const text = shapeText(p);
        placeholder(r, ctx, text ? `[${type}] ${text}` : `[${type}]`);
        placed.set(r.id, { t: ctx.t, w: num(p.w, 160), h: num(p.h, 90) });
      }
    }
  };

  const visited = new Set<string>();
  const walk = (list: TlRecord[], parent: WalkContext): void => {
    for (const r of list) {
      if (visited.has(r.id)) continue; // a parentId cycle in a corrupt store
      visited.add(r.id);
      const t: Transform = (() => {
        const [x, y] = toPage(parent.t, num(r.x, 0), num(r.y, 0));
        return { x, y, rotation: parent.t.rotation + num(r.rotation, 0) };
      })();
      const ctx: WalkContext = { ...parent, t };
      convertShape(r, ctx);
      const kids = children.get(r.id);
      if (kids && kids.length) {
        const type = str(r.type, "");
        const inner: WalkContext = { ...ctx };
        if (type === "group") inner.groupIds = [excalidrawIdOf(r.id), ...ctx.groupIds];
        if (type === "frame") inner.frameId = excalidrawIdOf(r.id);
        walk(kids, inner);
      }
    }
  };

  const root: WalkContext = { t: { x: 0, y: 0, rotation: 0 }, groupIds: [], frameId: null };
  let pageOffset = 0;
  let prevMaxX: number | null = null;
  const pageRoots: TlRecord[][] = pages.map((pg) => children.get(pg.id) ?? []);
  if (orphanRoots.length) {
    if (pageRoots.length) pageRoots[0] = [...pageRoots[0], ...orphanRoots];
    else pageRoots.push(orphanRoots);
  }
  pageRoots.forEach((list, i) => {
    const start = elements.length;
    walk(list, root);
    finishArrows();
    if (elements.length === start) return;
    const slice = elements.slice(start);
    const bounds = boundsOf(slice);
    if (i > 0 && prevMaxX !== null) {
      pageOffset = round(prevMaxX + 400 - bounds.minX);
      for (const el of slice) el.x = round(el.x + pageOffset);
      const page = pages[i];
      if (page) warn("extra-page", page, str(page.name, ""));
      prevMaxX = bounds.maxX + pageOffset;
    } else {
      prevMaxX = bounds.maxX;
    }
  });

  // Shapes no page reaches (a parentId cycle in a corrupt store): keep them too.
  const unreached = records.filter((r) => r.typeName === "shape" && !visited.has(r.id)).sort(byIndex);
  if (unreached.length) {
    walk(unreached, root);
    finishArrows();
  }

  function finishArrows(): void {
    if (pendingArrows.length === 0) return;
    const elementById = new Map<string, ExcalidrawElement>(elements.map((x) => [x.id, x]));
    for (const { r, el, ctx } of pendingArrows.splice(0)) {
      const p = props(r);
      const bindings = bindingsByArrow.get(r.id) ?? [];
      // Terminals and bend are page units; `scale` only sizes the label,
      // stroke and heads (checked against tldraw's own editor).
      const terminal = (which: "start" | "end"): ExPoint => {
        const v = p[which];
        if (isObj(v) && typeof v.x === "number" && typeof v.y === "number") return toPage(ctx.t, v.x, v.y);
        // tldraw 2.x stored the binding inside the terminal: { type: "binding", boundShapeId, normalizedAnchor }.
        if (isObj(v) && typeof v.boundShapeId === "string") {
          const target = placed.get(v.boundShapeId);
          const a = isObj(v.normalizedAnchor) ? v.normalizedAnchor : {};
          if (target) return toPage(target.t, num(a.x, 0.5) * target.w, num(a.y, 0.5) * target.h);
        }
        return toPage(ctx.t, which === "start" ? 0 : 100, 0);
      };
      const s = terminal("start");
      const e = terminal("end");
      const abs: ExPoint[] = [s];
      const bend = num(p.bend, 0);
      if (p.kind === "elbow") warn("elbow-arrow", r);
      else if (Math.abs(bend) > 0.5) {
        const dx = e[0] - s[0];
        const dy = e[1] - s[1];
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        // tldraw: middle = med + u.per() * -bend, per(x, y) = (y, -x).
        abs.push([(s[0] + e[0]) / 2 - uy * bend, (s[1] + e[1]) / 2 + ux * bend]);
        el.roundness = { type: 2 };
      }
      abs.push(e);
      const lin = linearFrom(abs);
      el.x = lin.x;
      el.y = lin.y;
      el.width = lin.width;
      el.height = lin.height;
      el.points = lin.points;

      const bindTo = (which: "start" | "end"): ExBinding | null => {
        let targetId: string | null = null;
        let anchor: Obj = {};
        let source: TlRecord = r;
        const b = bindings.find((x) => isObj(x.props) && x.props.terminal === which);
        if (b) {
          targetId = str(b.toId, "") || null;
          anchor = isObj(props(b).normalizedAnchor) ? (props(b).normalizedAnchor as Obj) : {};
          source = b;
        } else {
          const v = p[which];
          if (isObj(v) && typeof v.boundShapeId === "string") {
            targetId = v.boundShapeId;
            anchor = isObj(v.normalizedAnchor) ? v.normalizedAnchor : {};
          }
        }
        if (!targetId) return null;
        const exTarget = excalidrawIdOf(targetId);
        const target = elementById.get(exTarget);
        if (!target || !BINDABLE.has(target.type)) {
          warnings.push({
            code: "binding-dropped",
            recordId: source.id,
            recordType: source === r ? "arrow" : "binding",
            detail: target ? `target is a ${target.type}` : `target ${targetId} missing`,
          });
          return null;
        }
        if (!(target.boundElements ?? []).some((x) => x.id === el.id)) {
          target.boundElements = [...(target.boundElements ?? []), { id: el.id, type: "arrow" }];
        }
        return {
          elementId: exTarget,
          focus: 0,
          gap: 1,
          fixedPoint: [round(num(anchor.x, 0.5)), round(num(anchor.y, 0.5))],
        };
      };
      el.startBinding = bindTo("start");
      el.endBinding = bindTo("end");

      const text = shapeText(p);
      if (text) {
        const fontSize = (ARROW_FONT_SIZES[str(p.size, "m")] ?? 20) * num(p.scale, 1);
        const pos = num(p.labelPosition, 0.5);
        const mid = pointAlong(abs, pos);
        const id = derivedId(`${el.id}-label`);
        const labelEl = textElement(id, r, ctx, text, fontSize, {
          center: mid,
          angle: 0,
          align: "center",
          valign: "middle",
          containerId: el.id,
          strokeColor: color(p.labelColor ?? p.color),
        });
        const at = elements.indexOf(el);
        elements.splice(at + 1, 0, labelEl);
        el.boundElements = [...(el.boundElements ?? []), { id, type: "text" }];
      }
    }
  }

  const byElementType: Record<string, number> = {};
  for (const el of elements) byElementType[el.type] = (byElementType[el.type] ?? 0) + 1;

  return {
    file: {
      type: "excalidraw",
      version: 2,
      source: options.source ?? "lumen-md",
      elements,
      appState: { viewBackgroundColor: "#ffffff", gridSize },
      files,
    },
    warnings,
    stats: {
      shapes: records.filter((r) => r.typeName === "shape").length,
      elements: elements.length,
      byTldrawType,
      byElementType,
    },
  };
}

/** The point at fraction `t` (0..1) of a polyline's length. */
function pointAlong(pts: ExPoint[], t: number): ExPoint {
  const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  let left = Math.min(1, Math.max(0, t)) * lens.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lens.length; i++) {
    if (left <= lens[i] || i === lens.length - 1) {
      const f = lens[i] ? Math.min(1, left / lens[i]) : 0;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
    }
    left -= lens[i];
  }
  return pts[0];
}

function boundsOf(list: ExcalidrawElement[]): { minX: number; maxX: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const el of list) {
    if (el.type === "arrow" || el.type === "line" || el.type === "freedraw") {
      for (const [px] of el.points) {
        minX = Math.min(minX, el.x + px);
        maxX = Math.max(maxX, el.x + px);
      }
    } else {
      // Rotated about the centre: the horizontal half-extent of the rotated box.
      const half = (Math.abs(el.width * Math.cos(el.angle)) + Math.abs(el.height * Math.sin(el.angle))) / 2;
      const cx = el.x + el.width / 2;
      minX = Math.min(minX, cx - half);
      maxX = Math.max(maxX, cx + half);
    }
  }
  return { minX: Number.isFinite(minX) ? minX : 0, maxX: Number.isFinite(maxX) ? maxX : 0 };
}
