/**
 * 4.17 — JSON Canvas (jsoncanvas.org 1.0, Obsidian's `.canvas`) ↔ Excalidraw.
 * Acceptance: ten canvases round-trip unchanged.
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import {
  JsonCanvasFormatError,
  excalidrawToJsonCanvas,
  jsonCanvasToExcalidraw,
  parseJsonCanvas,
  serializeJsonCanvas,
  type JsonCanvas,
} from "../canvas/jsonCanvas";
import { sceneToFile, type SceneElement } from "../canvas/excalidrawScene";
import type { ExcalidrawElement, ExLinearElement, ExTextElement } from "../canvas/tldrawToExcalidraw";

const t = (id: string, x: number, y: number, text: string, extra: Record<string, unknown> = {}) => ({ id, type: "text" as const, x, y, width: 250, height: 60, text, ...extra });

/** Ten canvases covering every node type, edge option and colour form of the spec. */
const CANVASES: Record<string, JsonCanvas> = {
  empty: { nodes: [], edges: [] },
  "one text node": { nodes: [t("a1", 0, 0, "Hello")], edges: [] },
  markdown: { nodes: [t("md", -120, 40, "# Title\n\n- one\n- **two**\n\n```js\nx()\n```", { width: 400, height: 300 })], edges: [] },
  hebrew: { nodes: [t("he1", 0, 0, "שלום עולם — טקסט עברי ארוך שנשבר לכמה שורות בתוך הצומת"), t("he2", 400, 0, "English and עברית mixed")], edges: [{ id: "e1", fromNode: "he1", toNode: "he2" }] },
  "file nodes": {
    nodes: [
      { id: "f1", type: "file", file: "Notes/Plan.md", x: 0, y: 0, width: 400, height: 400 },
      { id: "f2", type: "file", file: "Notes/Plan.md", subpath: "#Goals", x: 500, y: 0, width: 300, height: 200 },
      { id: "f3", type: "file", file: "assets/diagram.png", x: 0, y: 500, width: 320, height: 240, color: "4" },
    ],
    edges: [{ id: "e1", fromNode: "f2", fromSide: "left", toNode: "f1", toSide: "right" }],
  },
  "link nodes": {
    nodes: [{ id: "l1", type: "link", url: "https://example.com/docs?x=1#top", x: 10.5, y: 20.25, width: 400, height: 300 }],
    edges: [],
  },
  groups: {
    nodes: [
      { id: "g1", type: "group", label: "Research", x: -50, y: -50, width: 700, height: 400, color: "6" },
      { id: "g2", type: "group", x: 800, y: 0, width: 300, height: 300, background: "assets/bg.png", backgroundStyle: "cover" },
      t("in1", 0, 0, "inside one"),
      t("in2", 300, 200, "inside two"),
      t("in3", 820, 20, "in the unlabelled group"),
    ],
    edges: [{ id: "e1", fromNode: "in1", toNode: "in2", label: "leads to" }],
  },
  "edge options": {
    nodes: [t("a", 0, 0, "A"), t("b", 400, 0, "B"), t("c", 0, 300, "C"), t("d", 400, 300, "D")],
    edges: [
      { id: "e1", fromNode: "a", fromSide: "right", toNode: "b", toSide: "left" },
      { id: "e2", fromNode: "a", fromSide: "bottom", fromEnd: "arrow", toNode: "c", toSide: "top", toEnd: "arrow" },
      { id: "e3", fromNode: "b", toNode: "d", toEnd: "none", label: "no arrow" },
      { id: "e4", fromNode: "d", fromSide: "left", fromEnd: "none", toNode: "c", toSide: "right", color: "#FF8800" },
      { id: "e5", fromNode: "c", toNode: "a", color: "2", label: "back" },
    ],
  },
  colours: {
    nodes: ["1", "2", "3", "4", "5", "6", "#123abc", "#FFFFFF"].map((color, i) => t(`c${i}`, i * 300, 0, `colour ${color}`, { color })),
    edges: [],
  },
  "other apps' fields": {
    nodes: [t("x1", 0, 0, "kept", { styleAttributes: { shape: "pill" }, "x-app": 3 })],
    edges: [{ id: "e1", fromNode: "x1", toNode: "x1", fromSide: "top", toSide: "bottom", "x-weight": 2 }],
    metadata: { version: "1.0-1.0", frontmatter: {} },
  },
};

describe("JSON Canvas ↔ Excalidraw (4.17)", () => {
  it("has ten canvases to round-trip", () => {
    expect(Object.keys(CANVASES)).toHaveLength(10);
  });

  for (const [name, canvas] of Object.entries(CANVASES)) {
    it(`round-trips: ${name}`, () => {
      const { file, warnings } = jsonCanvasToExcalidraw(JSON.parse(JSON.stringify(canvas)) as JsonCanvas);
      expect(warnings).toEqual([]);
      // Through the file on disk too (JSON) …
      const back = excalidrawToJsonCanvas(JSON.parse(JSON.stringify(file)));
      expect(back.warnings).toEqual([]);
      expect(back.canvas).toEqual(canvas);
      // … and through the `.canvas` text.
      expect(parseJsonCanvas(serializeJsonCanvas(back.canvas)).canvas).toEqual(canvas);
    });
  }

  it("the editor's save path keeps what export needs (customData, links, bindings)", () => {
    const canvas = CANVASES["file nodes"];
    const { file } = jsonCanvasToExcalidraw(canvas);
    const saved = sceneToFile(file.elements as unknown as SceneElement[], file.appState, file.files);
    expect(excalidrawToJsonCanvas(saved).canvas).toEqual(canvas);
  });

  it("imports text nodes as rectangles with their text bound inside, edges as bound arrows", () => {
    const { file } = jsonCanvasToExcalidraw(CANVASES.groups);
    const byId = new Map(file.elements.map((e) => [e.id, e]));
    const rect = byId.get("in1")!;
    expect(rect.type).toBe("rectangle");
    expect(rect.frameId).toBe("g1");
    const label = file.elements.find((e): e is ExTextElement => e.type === "text" && e.containerId === "in1")!;
    expect(label.originalText).toBe("inside one");
    expect(rect.boundElements).toEqual(expect.arrayContaining([{ id: label.id, type: "text" }, { id: "e1", type: "arrow" }]));
    const arrow = byId.get("e1") as ExLinearElement;
    expect(arrow.type).toBe("arrow");
    expect(arrow.startBinding?.elementId).toBe("in1");
    expect(arrow.endBinding?.elementId).toBe("in2");
    expect(arrow.endArrowhead).toBe("arrow");
    expect(arrow.startArrowhead).toBeNull();
    expect(byId.get("g1")).toMatchObject({ type: "frame", name: "Research", strokeColor: "#9c36b5" });
    expect(byId.get("in3")!.frameId).toBe("g2");
  });

  it("file and link nodes carry their target as the element's link", () => {
    const { file } = jsonCanvasToExcalidraw({ nodes: [...CANVASES["file nodes"].nodes, ...CANVASES["link nodes"].nodes], edges: [] });
    const link = (id: string) => file.elements.find((e) => e.id === id)!.link;
    expect(link("f2")).toBe("Notes/Plan.md#Goals");
    expect(link("l1")).toBe("https://example.com/docs?x=1#top");
  });

  it("edits made in Excalidraw are exported: moved node, new text, retargeted file, recoloured edge", () => {
    const canvas = CANVASES["edge options"];
    const { file } = jsonCanvasToExcalidraw(canvas);
    const els = JSON.parse(JSON.stringify(file.elements)) as ExcalidrawElement[];
    const a = els.find((e) => e.id === "a")!;
    a.x = 12.6;
    const label = els.find((e): e is ExTextElement => e.type === "text" && e.containerId === "b")!;
    label.originalText = "B, renamed";
    label.text = "B, renamed";
    const e5 = els.find((e) => e.id === "e5")!;
    e5.strokeColor = "#0c8599";
    const out = excalidrawToJsonCanvas({ elements: els, appState: file.appState }).canvas;
    expect(out.nodes.find((n) => n.id === "a")).toMatchObject({ x: 13, y: 0 });
    expect(out.nodes.find((n) => n.id === "b")).toMatchObject({ type: "text", text: "B, renamed" });
    expect(out.edges.find((e) => e.id === "e5")).toMatchObject({ color: "5", label: "back" });

    const f = jsonCanvasToExcalidraw(CANVASES["file nodes"]).file;
    const fEls = JSON.parse(JSON.stringify(f.elements)) as ExcalidrawElement[];
    fEls.find((e) => e.id === "f2")!.link = "Notes/Other.md#Intro";
    fEls.find((e) => e.id === "f1")!.link = "Notes/Moved.md";
    const fOut = excalidrawToJsonCanvas({ elements: fEls, appState: f.appState }).canvas;
    expect(fOut.nodes.find((n) => n.id === "f2")).toMatchObject({ type: "file", file: "Notes/Other.md", subpath: "#Intro" });
    expect(fOut.nodes.find((n) => n.id === "f1")).toMatchObject({ type: "file", file: "Notes/Moved.md" });
    expect(fOut.nodes.find((n) => n.id === "f1")).not.toHaveProperty("subpath");
  });

  it("exports a drawing made in Excalidraw, and reports what has no JSON Canvas form", () => {
    const base = { angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: null, roundness: null, seed: 1, version: 3, versionNonce: 2, isDeleted: false, boundElements: null, updated: 0, link: null, locked: false };
    const elements = [
      { ...base, id: "r", type: "rectangle", x: 0, y: 0, width: 200, height: 100, boundElements: [{ id: "rt", type: "text" }, { id: "ar", type: "arrow" }] },
      { ...base, id: "rt", type: "text", x: 10, y: 10, width: 100, height: 20, text: "Box", originalText: "Box", fontSize: 20, fontFamily: 5, textAlign: "center", verticalAlign: "middle", containerId: "r", autoResize: true, lineHeight: 1.25 },
      { ...base, id: "el", type: "ellipse", x: 400, y: 0, width: 120, height: 120, strokeColor: "#e03131", boundElements: [{ id: "ar", type: "arrow" }] },
      { ...base, id: "w", type: "rectangle", x: 0, y: 300, width: 100, height: 50, link: "https://example.com" },
      { ...base, id: "free", type: "text", x: 0, y: 500, width: 80, height: 20, text: "loose", originalText: "loose", fontSize: 20, fontFamily: 5, textAlign: "left", verticalAlign: "top", containerId: null, autoResize: true, lineHeight: 1.25 },
      { ...base, id: "fr", type: "frame", x: -20, y: -20, width: 600, height: 200, name: "Area" },
      { ...base, id: "ar", type: "arrow", x: 200, y: 50, width: 200, height: 10, points: [[0, 0], [200, 10]], lastCommittedPoint: null, startBinding: { elementId: "r", focus: 0, gap: 4, fixedPoint: null }, endBinding: { elementId: "el", focus: 0, gap: 4, fixedPoint: null }, startArrowhead: null, endArrowhead: "triangle" },
      { ...base, id: "loose", type: "arrow", x: 0, y: 700, width: 50, height: 0, points: [[0, 0], [50, 0]], lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: "arrow" },
      { ...base, id: "pen", type: "freedraw", x: 0, y: 800, width: 10, height: 10, points: [[0, 0], [10, 10]], pressures: [], simulatePressure: true, lastCommittedPoint: null },
      { ...base, id: "gone", type: "rectangle", x: 0, y: 0, width: 1, height: 1, isDeleted: true },
    ] as unknown as ExcalidrawElement[];
    const { canvas, warnings } = excalidrawToJsonCanvas({ elements, appState: { viewBackgroundColor: "#ffffff", gridSize: null } });
    expect(canvas.nodes).toEqual([
      { id: "r", type: "text", text: "Box", x: 0, y: 0, width: 200, height: 100 },
      { id: "el", type: "text", text: "", x: 400, y: 0, width: 120, height: 120, color: "1" },
      { id: "w", type: "link", url: "https://example.com", x: 0, y: 300, width: 100, height: 50 },
      { id: "free", type: "text", text: "loose", x: 0, y: 500, width: 80, height: 20 },
      { id: "fr", type: "group", label: "Area", x: -20, y: -20, width: 600, height: 200 },
    ]);
    expect(canvas.edges).toEqual([{ id: "ar", fromNode: "r", toNode: "el", fromSide: "right", toSide: "left" }]);
    expect(warnings).toEqual([
      { code: "unsupported-element", id: "pen", detail: "freedraw" },
      { code: "unbound-arrow", id: "loose" },
    ]);
  });

  it("drops invalid nodes and dangling edges with a warning, refuses what is not a canvas", () => {
    const { canvas, warnings } = parseJsonCanvas(
      JSON.stringify({
        nodes: [t("ok", 0, 0, "fine"), { id: "bad", type: "text", x: 0, y: 0 }, { id: "ok", type: "group", x: 0, y: 0, width: 1, height: 1 }, { type: "link" }],
        edges: [{ id: "e1", fromNode: "ok", toNode: "missing" }, { id: "e2", fromNode: "ok", toNode: "ok", fromSide: "middle" }],
      }),
    );
    expect(canvas.nodes.map((n) => n.id)).toEqual(["ok"]);
    expect(canvas.edges).toEqual([]);
    expect(warnings.map((w) => `${w.code}:${w.id}`)).toEqual(["invalid-record:bad", "invalid-record:ok", "invalid-record:?", "dangling-edge:e1", "invalid-record:e2"]);
    expect(() => parseJsonCanvas("{not json")).toThrow(JsonCanvasFormatError);
    expect(() => parseJsonCanvas("[]")).toThrow(JsonCanvasFormatError);
    expect(() => parseJsonCanvas('{"nodes": {}}')).toThrow(JsonCanvasFormatError);
    expect(parseJsonCanvas("").canvas).toEqual({ nodes: [], edges: [] });
  });

  it("writes tab-indented JSON like Obsidian", () => {
    expect(serializeJsonCanvas(CANVASES["one text node"])).toBe('{\n\t"nodes": [\n\t\t{\n\t\t\t"id": "a1",\n\t\t\t"type": "text",\n\t\t\t"x": 0,\n\t\t\t"y": 0,\n\t\t\t"width": 250,\n\t\t\t"height": 60,\n\t\t\t"text": "Hello"\n\t\t}\n\t],\n\t"edges": []\n}');
  });
});
