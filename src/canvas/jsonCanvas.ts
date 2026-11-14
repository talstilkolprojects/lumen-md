/**
 * JSON Canvas ↔ Excalidraw (plan 4.17). JSON Canvas is the open canvas
 * format Obsidian writes (`.canvas`, spec 1.0 at jsoncanvas.org, MIT):
 * nodes (text, file, link, group) and edges between them.
 *
 * Import: each node becomes an Excalidraw element — text / file / link
 * nodes a rectangle with its text bound inside (file and link nodes also
 * carry the path or URL as the element's link), a group a frame — and each
 * edge an arrow bound to its two nodes, with its label bound to it.
 *
 * Export: the reverse. An element that came from a JSON Canvas keeps the
 * original node or edge in `customData.jsonCanvas`, so what Excalidraw
 * cannot hold (a file's subpath, a group's background, fields of other
 * apps) comes back unchanged, and a canvas that is imported and exported
 * without edits is the same canvas. Elements drawn in Excalidraw are
 * exported as best they map: shapes and free text → text nodes, frames →
 * groups, bound arrows → edges; what has no JSON Canvas form (images,
 * free-hand strokes, unbound arrows, lines) is reported, not silently lost.
 *
 * Pure: no DOM, no Excalidraw import.
 */

import { wrapText, type ExBase, type ExFrameElement, type ExLinearElement, type ExShapeElement, type ExTextElement, type ExcalidrawElement, type ExcalidrawFile, type ExPoint } from "./tldrawToExcalidraw";
import { SCENE_SOURCE } from "./excalidrawScene";

export const JSON_CANVAS_EXT = ".canvas";

export type JcSide = "top" | "right" | "bottom" | "left";
export type JcEnd = "none" | "arrow";

interface JcNodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  [key: string]: unknown;
}
export interface JcTextNode extends JcNodeBase { type: "text"; text: string }
export interface JcFileNode extends JcNodeBase { type: "file"; file: string; subpath?: string }
export interface JcLinkNode extends JcNodeBase { type: "link"; url: string }
export interface JcGroupNode extends JcNodeBase { type: "group"; label?: string; background?: string; backgroundStyle?: "cover" | "ratio" | "repeat" }
export type JcNode = JcTextNode | JcFileNode | JcLinkNode | JcGroupNode;

export interface JcEdge {
  id: string;
  fromNode: string;
  fromSide?: JcSide;
  fromEnd?: JcEnd;
  toNode: string;
  toSide?: JcSide;
  toEnd?: JcEnd;
  color?: string;
  label?: string;
  [key: string]: unknown;
}

export interface JsonCanvas {
  nodes: JcNode[];
  edges: JcEdge[];
  [key: string]: unknown;
}

export type JsonCanvasWarningCode =
  /** A node or edge the file has but the spec does not allow (missing id, bad type, no geometry). */
  | "invalid-record"
  /** An edge whose node is not in the canvas. */
  | "dangling-edge"
  /** An Excalidraw element with no JSON Canvas form (image, free-hand, line). */
  | "unsupported-element"
  /** An arrow not bound to a node at both ends. */
  | "unbound-arrow";

export interface JsonCanvasWarning {
  code: JsonCanvasWarningCode;
  id: string;
  detail?: string;
}

export class JsonCanvasFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonCanvasFormatError";
  }
}

/** What an element keeps of the canvas it came from. */
interface JcCustom {
  node?: JcNode;
  edge?: JcEdge;
  /** Set on a node's or edge's bound label. */
  labelOf?: string;
}

// ---------------------------------------------------------------------------
// Colours: the spec's six presets ↔ hex.

/** The presets as Obsidian draws them (spec: "1" red … "6" purple). */
export const PRESET_COLORS: Record<string, string> = {
  "1": "#e03131",
  "2": "#f08c00",
  "3": "#e8b400",
  "4": "#2f9e44",
  "5": "#0c8599",
  "6": "#9c36b5",
};
const DEFAULT_STROKE = "#1e1e1e";

function strokeOf(color: string | undefined): string {
  if (!color) return DEFAULT_STROKE;
  return PRESET_COLORS[color] ?? (/^#[0-9a-f]{3,8}$/i.test(color) ? color : DEFAULT_STROKE);
}

/** A stroke colour back to the spec's form: a preset number when it is one, else hex; none for the default. */
function colorOf(stroke: string): string | undefined {
  if (!stroke || stroke.toLowerCase() === DEFAULT_STROKE) return undefined;
  for (const [n, hex] of Object.entries(PRESET_COLORS)) if (hex === stroke.toLowerCase()) return n;
  return /^#[0-9a-f]{3,8}$/i.test(stroke) ? stroke : undefined;
}

// ---------------------------------------------------------------------------
// Parsing.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const SIDES = new Set(["top", "right", "bottom", "left"]);
const ENDS = new Set(["none", "arrow"]);

/** Read a `.canvas` file (text or parsed JSON). Invalid nodes and edges are dropped and reported. */
export function parseJsonCanvas(input: string | unknown): { canvas: JsonCanvas; warnings: JsonCanvasWarning[] } {
  let data: unknown = input;
  if (typeof input === "string") {
    try {
      data = input.trim() ? JSON.parse(input) : {};
    } catch (e) {
      throw new JsonCanvasFormatError(`not JSON: ${(e as Error).message}`);
    }
  }
  if (!isObj(data)) throw new JsonCanvasFormatError("a JSON Canvas is an object with nodes and edges");
  if (data.nodes !== undefined && !Array.isArray(data.nodes)) throw new JsonCanvasFormatError("`nodes` must be an array");
  if (data.edges !== undefined && !Array.isArray(data.edges)) throw new JsonCanvasFormatError("`edges` must be an array");
  const warnings: JsonCanvasWarning[] = [];
  const nodes: JcNode[] = [];
  const ids = new Set<string>();
  for (const n of (data.nodes as unknown[] | undefined) ?? []) {
    const ok =
      isObj(n) && typeof n.id === "string" && n.id && !ids.has(n.id) && isNum(n.x) && isNum(n.y) && isNum(n.width) && isNum(n.height) &&
      ((n.type === "text" && typeof n.text === "string") || (n.type === "file" && typeof n.file === "string") || (n.type === "link" && typeof n.url === "string") || n.type === "group");
    if (!ok) {
      warnings.push({ code: "invalid-record", id: isObj(n) && typeof n.id === "string" ? n.id : "?", detail: "node" });
      continue;
    }
    ids.add(n.id as string);
    nodes.push(n as unknown as JcNode);
  }
  const edges: JcEdge[] = [];
  const edgeIds = new Set<string>();
  for (const e of (data.edges as unknown[] | undefined) ?? []) {
    const ok =
      isObj(e) && typeof e.id === "string" && e.id && !edgeIds.has(e.id) && typeof e.fromNode === "string" && typeof e.toNode === "string" &&
      (e.fromSide === undefined || SIDES.has(e.fromSide as string)) && (e.toSide === undefined || SIDES.has(e.toSide as string)) &&
      (e.fromEnd === undefined || ENDS.has(e.fromEnd as string)) && (e.toEnd === undefined || ENDS.has(e.toEnd as string));
    if (!ok) {
      warnings.push({ code: "invalid-record", id: isObj(e) && typeof e.id === "string" ? e.id : "?", detail: "edge" });
      continue;
    }
    if (!ids.has(e.fromNode as string) || !ids.has(e.toNode as string)) {
      warnings.push({ code: "dangling-edge", id: e.id as string });
      continue;
    }
    edgeIds.add(e.id as string);
    edges.push(e as unknown as JcEdge);
  }
  const { nodes: _n, edges: _e, ...rest } = data;
  return { canvas: { ...rest, nodes, edges }, warnings };
}

/** Write a `.canvas` file the way Obsidian does (tab-indented JSON). */
export function serializeJsonCanvas(canvas: JsonCanvas): string {
  return JSON.stringify(canvas, null, "\t");
}

// ---------------------------------------------------------------------------
// Geometry.

type Box = { x: number; y: number; width: number; height: number };

/** The middle of a box's side. */
function sidePoint(b: Box, side: JcSide): ExPoint {
  if (side === "top") return [b.x + b.width / 2, b.y];
  if (side === "bottom") return [b.x + b.width / 2, b.y + b.height];
  if (side === "left") return [b.x, b.y + b.height / 2];
  return [b.x + b.width, b.y + b.height / 2];
}
const FIXED: Record<JcSide, ExPoint> = { top: [0.5, 0], right: [1, 0.5], bottom: [0.5, 1], left: [0, 0.5] };

/** The side of `b` that faces `p` (for edges without sides, and arrows drawn in Excalidraw). */
function facingSide(b: Box, p: ExPoint): JcSide {
  const dx = (p[0] - (b.x + b.width / 2)) / Math.max(b.width, 1);
  const dy = (p[1] - (b.y + b.height / 2)) / Math.max(b.height, 1);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}
const center = (b: Box): ExPoint => [b.x + b.width / 2, b.y + b.height / 2];
const inside = (inner: Box, outer: Box): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

// ---------------------------------------------------------------------------
// JSON Canvas → Excalidraw.

const FONT_SIZE = 16;
const FONT_FAMILY = 6; // Nunito, Excalidraw's "normal" sans
const LINE_HEIGHT = 1.25;
const PADDING = 10;

function seedOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2147483647 || 1;
}

function baseOf(id: string, box: Box, stroke: string, custom: JcCustom, updated: number): ExBase {
  return {
    id,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    angle: 0,
    strokeColor: stroke,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed: seedOf(id),
    version: 1,
    versionNonce: seedOf(`${id}:nonce`),
    isDeleted: false,
    boundElements: null,
    updated,
    link: null,
    locked: false,
    customData: { jsonCanvas: custom as Record<string, unknown> },
  };
}

function labelText(id: string, text: string, container: ExBase, align: "left" | "center", updated: number, labelOf: string): ExTextElement {
  const width = Math.max(container.width - 2 * PADDING, FONT_SIZE);
  const shown = wrapText(text, FONT_SIZE, width);
  const height = shown.split("\n").length * FONT_SIZE * LINE_HEIGHT;
  return {
    ...baseOf(id, { x: container.x + PADDING, y: container.y + PADDING, width, height }, container.strokeColor, { labelOf }, updated),
    type: "text",
    strokeWidth: 1,
    text: shown,
    originalText: text,
    fontSize: FONT_SIZE,
    fontFamily: FONT_FAMILY,
    textAlign: align,
    verticalAlign: align === "left" ? "top" : "middle",
    containerId: container.id,
    autoResize: false,
    lineHeight: LINE_HEIGHT,
  };
}

/** What a file or link node's rectangle shows: its target. */
function nodeLabel(n: JcNode): string {
  if (n.type === "text") return n.text;
  if (n.type === "file") return n.file + (n.subpath ?? "");
  if (n.type === "link") return n.url;
  return "";
}

export interface JsonCanvasToExcalidrawResult {
  file: ExcalidrawFile;
  warnings: JsonCanvasWarning[];
}

/** A JSON Canvas (parsed, or the `.canvas` text) as an Excalidraw scene. */
export function jsonCanvasToExcalidraw(input: JsonCanvas | string, options: { updated?: number } = {}): JsonCanvasToExcalidrawResult {
  const { canvas, warnings } = parseJsonCanvas(input);
  const updated = options.updated ?? 0;
  const used = new Set<string>([...canvas.nodes.map((n) => n.id), ...canvas.edges.map((e) => e.id)]);
  const freshId = (base: string): string => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}~${n}`;
    used.add(id);
    return id;
  };

  const elements: ExcalidrawElement[] = [];
  const byNode = new Map<string, ExBase>();
  const groups = canvas.nodes.filter((n): n is JcGroupNode => n.type === "group");

  for (const n of canvas.nodes) {
    const box: Box = { x: n.x, y: n.y, width: n.width, height: n.height };
    if (n.type === "group") {
      const frame: ExFrameElement = { ...baseOf(n.id, box, strokeOf(n.color), { node: n }, updated), type: "frame", name: n.label ?? null };
      elements.push(frame);
      byNode.set(n.id, frame);
      continue;
    }
    const rect: ExShapeElement = { ...baseOf(n.id, box, strokeOf(n.color), { node: n }, updated), type: "rectangle", roundness: { type: 3 } };
    if (n.type === "file") rect.link = n.file + (n.subpath ?? "");
    if (n.type === "link") rect.link = n.url;
    // Excalidraw frames don't nest: a node belongs to the smallest group around it.
    const owner = groups.filter((g) => g.id !== n.id && inside(box, g)).sort((a, b) => a.width * a.height - b.width * b.height)[0];
    if (owner) rect.frameId = owner.id;
    elements.push(rect);
    byNode.set(n.id, rect);
    const text = nodeLabel(n);
    if (text) {
      const label = labelText(freshId(`${n.id}-label`), text, rect, n.type === "text" ? "left" : "center", updated, n.id);
      label.frameId = rect.frameId;
      rect.boundElements = [{ id: label.id, type: "text" }];
      elements.push(label);
    }
  }

  for (const e of canvas.edges) {
    const from = byNode.get(e.fromNode)!;
    const to = byNode.get(e.toNode)!;
    const fromSide = e.fromSide ?? facingSide(from, center(to));
    const toSide = e.toSide ?? facingSide(to, center(from));
    const a = sidePoint(from, fromSide);
    const b = sidePoint(to, toSide);
    const arrow: ExLinearElement = {
      ...baseOf(e.id, { x: a[0], y: a[1], width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]) }, strokeOf(e.color), { edge: e }, updated),
      type: "arrow",
      roundness: { type: 2 },
      points: [[0, 0], [b[0] - a[0], b[1] - a[1]]],
      lastCommittedPoint: null,
      startBinding: { elementId: from.id, focus: 0, gap: 4, fixedPoint: FIXED[fromSide] },
      endBinding: { elementId: to.id, focus: 0, gap: 4, fixedPoint: FIXED[toSide] },
      startArrowhead: (e.fromEnd ?? "none") === "arrow" ? "arrow" : null,
      endArrowhead: (e.toEnd ?? "arrow") === "arrow" ? "arrow" : null,
    };
    elements.push(arrow);
    for (const end of [from, to]) end.boundElements = [...(end.boundElements ?? []), { id: arrow.id, type: "arrow" }];
    if (e.label) {
      const mid: Box = { x: (a[0] + b[0]) / 2 - 60, y: (a[1] + b[1]) / 2 - 12, width: 120 + 2 * PADDING, height: 24 };
      const label = labelText(freshId(`${e.id}-label`), e.label, { ...arrow, ...mid }, "center", updated, e.id);
      arrow.boundElements = [{ id: label.id, type: "text" }];
      elements.push(label);
    }
  }

  const { nodes: _n, edges: _e, ...extra } = canvas;
  const file: ExcalidrawFile = {
    type: "excalidraw",
    version: 2,
    source: SCENE_SOURCE,
    elements,
    appState: { viewBackgroundColor: "#ffffff", gridSize: null, ...(Object.keys(extra).length ? { jsonCanvas: extra } : {}) },
    files: {},
  };
  return { file, warnings };
}

// ---------------------------------------------------------------------------
// Excalidraw → JSON Canvas.

const custom = (el: ExcalidrawElement): JcCustom => {
  const c = (el.customData as { jsonCanvas?: unknown } | undefined)?.jsonCanvas;
  return isObj(c) ? (c as JcCustom) : {};
};
const SHAPES = new Set(["rectangle", "ellipse", "diamond"]);

export interface ExcalidrawToJsonCanvasResult {
  canvas: JsonCanvas;
  warnings: JsonCanvasWarning[];
}

/** An Excalidraw scene as a JSON Canvas. */
export function excalidrawToJsonCanvas(file: Pick<ExcalidrawFile, "elements" | "appState">): ExcalidrawToJsonCanvasResult {
  const warnings: JsonCanvasWarning[] = [];
  const live = file.elements.filter((e) => !(e as { isDeleted?: boolean }).isDeleted);
  const labelOf = new Map<string, ExTextElement>();
  for (const el of live) if (el.type === "text" && el.containerId) labelOf.set(el.containerId, el);
  const boxOf = new Map<string, Box>();
  const nodes: JcNode[] = [];

  const geometry = (el: ExBase, orig: JcNode | undefined): Box => {
    // Unedited numbers stay exactly as the canvas had them; edited ones are whole pixels.
    const same = orig && orig.x === el.x && orig.y === el.y && orig.width === el.width && orig.height === el.height;
    return same ? { x: orig.x, y: orig.y, width: orig.width, height: orig.height } : { x: Math.round(el.x), y: Math.round(el.y), width: Math.round(el.width), height: Math.round(el.height) };
  };
  const withColor = <T extends { color?: string }>(out: T, el: ExBase, origColor: string | undefined): T => {
    // The colour as the file had it, unless the stroke was changed.
    const color = strokeOf(origColor) === el.strokeColor ? origColor : colorOf(el.strokeColor);
    if (color === undefined) delete out.color;
    else out.color = color;
    return out;
  };

  for (const el of live) {
    const orig = custom(el).node;
    if (el.type === "frame") {
      const g = { ...(orig?.type === "group" ? orig : {}), id: el.id, type: "group", ...geometry(el, orig) } as JcGroupNode;
      if (el.name != null) g.label = el.name;
      else delete g.label;
      nodes.push(withColor(g, el, orig?.color));
      boxOf.set(el.id, g);
    } else if (SHAPES.has(el.type) || (el.type === "text" && !el.containerId)) {
      const text = el.type === "text" ? el.originalText ?? el.text : (labelOf.get(el.id)?.originalText ?? labelOf.get(el.id)?.text ?? "");
      const box = geometry(el, orig);
      let n: JcNode;
      if (orig && orig.type !== "group" && orig.type !== "text" && el.type !== "text") {
        // A file or link node: its target lives in the element's link (and the label shows it).
        n = { ...orig, id: el.id, ...box };
        if (n.type === "link") n.url = el.link ?? n.url;
        if (n.type === "file") {
          const target = el.link ?? n.file + (n.subpath ?? "");
          if (target !== n.file + (n.subpath ?? "")) {
            const hash = target.indexOf("#");
            n.file = hash < 0 ? target : target.slice(0, hash);
            if (hash < 0) delete n.subpath;
            else n.subpath = target.slice(hash);
          }
        }
      } else if (el.link && el.type !== "text" && !orig) {
        n = /^[a-z][a-z0-9+.-]*:/i.test(el.link) ? { id: el.id, type: "link", url: el.link, ...box } : { id: el.id, type: "file", file: el.link, ...box };
      } else {
        n = { ...(orig?.type === "text" ? orig : {}), id: el.id, type: "text", text, ...box } as JcTextNode;
      }
      nodes.push(withColor(n, el, orig?.color));
      boxOf.set(el.id, n);
    } else if (el.type === "text") {
      // A bound label: part of its container.
    } else if (el.type === "arrow") {
      // Edges below, once every node is known.
    } else {
      warnings.push({ code: "unsupported-element", id: el.id, detail: el.type });
    }
  }

  const edges: JcEdge[] = [];
  for (const el of live) {
    if (el.type !== "arrow") continue;
    const fromId = el.startBinding?.elementId;
    const toId = el.endBinding?.elementId;
    const from = fromId ? boxOf.get(fromId) : undefined;
    const to = toId ? boxOf.get(toId) : undefined;
    if (!from || !to || !fromId || !toId) {
      warnings.push({ code: "unbound-arrow", id: el.id });
      continue;
    }
    const orig = custom(el).edge;
    const sameEnds = orig?.fromNode === fromId && orig?.toNode === toId;
    const e: JcEdge = { ...(orig ?? {}), id: el.id, fromNode: fromId, toNode: toId };
    const pts = el.points;
    const start: ExPoint = [el.x + (pts[0]?.[0] ?? 0), el.y + (pts[0]?.[1] ?? 0)];
    const last = pts[pts.length - 1] ?? [0, 0];
    const end: ExPoint = [el.x + last[0], el.y + last[1]];
    // Sides: as the file had them (or left to the reader, when it had none) while the
    // arrow joins the same nodes; else the side each end of the arrow faces.
    if (!sameEnds) {
      e.fromSide = facingSide(from, start);
      e.toSide = facingSide(to, end);
    }
    const fromEnd: JcEnd = el.startArrowhead ? "arrow" : "none";
    const toEnd: JcEnd = el.endArrowhead ? "arrow" : "none";
    // The spec's defaults (fromEnd none, toEnd arrow) are written only if the file wrote them.
    if (fromEnd !== "none" || orig?.fromEnd !== undefined) e.fromEnd = fromEnd;
    else delete e.fromEnd;
    if (toEnd !== "arrow" || orig?.toEnd !== undefined) e.toEnd = toEnd;
    else delete e.toEnd;
    const label = labelOf.get(el.id);
    const text = label ? (label.originalText ?? label.text) : "";
    if (text) e.label = text;
    else delete e.label;
    edges.push(withColor(e, el, orig?.color));
  }

  const extra = isObj(file.appState.jsonCanvas) ? (file.appState.jsonCanvas as Obj) : {};
  return { canvas: { ...extra, nodes, edges }, warnings };
}
