/**
 * tldraw → Excalidraw converter (plan 4.19).
 *
 * Acceptance: "20 tldraw canvases converted without losing a shape". The
 * twenty canvases (fixtures/tldrawCanvases.ts) cover every tldraw shape
 * type, Hebrew text, arrows bound to shapes, nested frames and groups,
 * images, several pages and the older stored formats.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import {
  decodeDrawPath,
  excalidrawIdOf,
  extractTldrawRecords,
  isRtlText,
  richTextToPlain,
  tldrawToExcalidraw,
  TldrawFormatError,
  type ExcalidrawElement,
  type ExLinearElement,
  type ExTextElement,
  type ExFreedrawElement,
  type ExImageElement,
} from "../canvas/tldrawToExcalidraw";
import { buildFixtureCanvases, richText, type Rec } from "./fixtures/tldrawCanvases";

const canvases = buildFixtureCanvases();

type Props = Record<string, unknown>;
const propsOf = (r: Rec): Props => (r.props ?? {}) as Props;

function plainText(r: Rec): string {
  const p = propsOf(r);
  if (p.richText && typeof p.richText === "object") return richTextToPlain(p.richText);
  return typeof p.text === "string" ? p.text : "";
}

const POLYGON_GEOS = new Set([
  "triangle", "trapezoid", "rhombus", "rhombus-2", "pentagon", "hexagon", "octagon", "star",
  "arrow-right", "arrow-left", "arrow-up", "arrow-down",
]);

/** The Excalidraw element type each tldraw shape should become. */
function expectedType(r: Rec, records: Rec[]): string {
  const p = propsOf(r);
  switch (r.type) {
    case "geo": {
      const geo = String(p.geo);
      if (POLYGON_GEOS.has(geo)) return "line";
      if (geo === "ellipse" || geo === "oval" || geo === "cloud" || geo === "heart") return "ellipse";
      if (geo === "diamond") return "diamond";
      return "rectangle";
    }
    case "note":
      return "rectangle";
    case "text":
      return "text";
    case "frame":
      return "frame";
    case "arrow":
      return "arrow";
    case "line":
      return "line";
    case "draw":
    case "highlight":
      return "freedraw";
    case "image": {
      const asset = records.find((a) => a.id === p.assetId);
      const src = asset ? String(propsOf(asset).src) : "";
      return src.startsWith("data:") ? "image" : "rectangle";
    }
    default:
      return "rectangle";
  }
}

/** Does a shape's text end up in a bound label (rather than being the element itself)? */
function hasBoundLabel(r: Rec): boolean {
  if (r.type === "text" || r.type === "group") return false;
  if (r.type === "geo" && POLYGON_GEOS.has(String(propsOf(r).geo))) return false;
  return true;
}

function parentChain(r: Rec, byId: Map<string, Rec>): Rec[] {
  const out: Rec[] = [];
  let cur = byId.get(String(r.parentId));
  while (cur && cur.typeName === "shape") {
    out.push(cur);
    cur = byId.get(String(cur.parentId));
  }
  return out;
}

function el(elements: ExcalidrawElement[], id: string): ExcalidrawElement {
  const found = elements.find((e) => e.id === id);
  if (!found) throw new Error(`no element ${id}`);
  return found;
}

const close = (a: number, b: number, tol = 0.05): void => {
  expect(Math.abs(a - b), `${a} ≈ ${b}`).toBeLessThanOrEqual(tol);
};

describe("tldraw → Excalidraw: 20 canvases without losing a shape (4.19)", () => {
  it("has twenty fixture canvases covering every tldraw shape type", () => {
    expect(canvases).toHaveLength(20);
    expect(new Set(canvases.map((c) => c.name)).size).toBe(20);
    const types = new Set(canvases.flatMap((c) => c.records.filter((r) => r.typeName === "shape").map((r) => String(r.type))));
    for (const t of ["geo", "text", "note", "arrow", "frame", "group", "image", "draw", "highlight", "line", "video", "embed", "bookmark"]) {
      expect(types, t).toContain(t);
    }
    const shapes = canvases.reduce((n, c) => n + c.records.filter((r) => r.typeName === "shape").length, 0);
    expect(shapes).toBeGreaterThan(150);
  });

  describe.each(canvases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const result = tldrawToExcalidraw(c.data);
    const { elements } = result.file;
    const byId = new Map(c.records.map((r) => [r.id, r]));
    const shapes = c.records.filter((r) => r.typeName === "shape");

    it("is a valid Excalidraw scene envelope", () => {
      expect(result.file.type).toBe("excalidraw");
      expect(result.file.version).toBe(2);
      expect(Array.isArray(elements)).toBe(true);
      expect(new Set(elements.map((e) => e.id)).size).toBe(elements.length);
      expect(result.stats.shapes).toBe(shapes.length);
      expect(result.stats.elements).toBe(elements.length);
      for (const e of elements) {
        expect(Number.isFinite(e.x) && Number.isFinite(e.y), e.id).toBe(true);
        expect(e.width >= 0 && e.height >= 0, e.id).toBe(true);
        expect(e.isDeleted).toBe(false);
      }
    });

    it("keeps every shape, with a stable id and the right element type", () => {
      for (const r of shapes) {
        if (r.type === "group") {
          const gid = excalidrawIdOf(r.id);
          const hasKids = shapes.some((s) => s.parentId === r.id);
          if (hasKids) expect(elements.some((e) => e.groupIds.includes(gid)), r.id).toBe(true);
          continue;
        }
        const e = el(elements, excalidrawIdOf(r.id));
        expect(e.type, `${r.id} (${String(r.type)})`).toBe(expectedType(r, c.records));
        expect(e.customData?.tldrawId).toBe(r.id);
      }
      // Counts per element type match the shapes (plus one text per label).
      const want: Record<string, number> = {};
      for (const r of shapes) {
        if (r.type === "group") continue;
        const t = expectedType(r, c.records);
        want[t] = (want[t] ?? 0) + 1;
        const placeholder = t === "rectangle" && !["geo", "note"].includes(String(r.type));
        if (placeholder || (plainText(r) && r.type !== "text")) want.text = (want.text ?? 0) + 1;
      }
      expect(result.stats.byElementType).toEqual(want);
    });

    it("keeps every text exactly (Hebrew included)", () => {
      for (const r of shapes) {
        const text = plainText(r);
        if (!text) continue;
        if (r.type === "text") {
          const t = el(elements, excalidrawIdOf(r.id)) as ExTextElement;
          expect(t.originalText).toBe(text);
          // A fixed-width text is stored wrapped: only line breaks are added.
          expect(t.text.replace(/\n/g, " ")).toBe(text.replace(/\n/g, " "));
          continue;
        }
        const label = elements.find(
          (e): e is ExTextElement =>
            e.type === "text" && e.customData?.tldrawId === r.id && e.id !== excalidrawIdOf(r.id),
        );
        expect(label, r.id).toBeDefined();
        expect(label!.originalText.endsWith(text), `${label!.originalText} ⊇ ${text}`).toBe(true);
        // Labels are stored wrapped to their container: only line breaks are added.
        expect(label!.text.replace(/\s+/g, "")).toBe(label!.originalText.replace(/\s+/g, ""));
        if (hasBoundLabel(r)) expect(label!.containerId).toBe(excalidrawIdOf(r.id));
      }
    });

    it("keeps arrow bindings, both directions", () => {
      for (const b of c.records.filter((r) => r.typeName === "binding")) {
        const p = propsOf(b);
        const arrowEl = el(elements, excalidrawIdOf(String(b.fromId))) as ExLinearElement;
        const binding = p.terminal === "start" ? arrowEl.startBinding : arrowEl.endBinding;
        const target = elements.find((e) => e.id === excalidrawIdOf(String(b.toId)));
        if (!target) {
          expect(binding).toBeNull();
          expect(result.warnings.some((w) => w.code === "binding-dropped" && w.recordId === b.id)).toBe(true);
          continue;
        }
        expect(binding?.elementId).toBe(target.id);
        expect(target.boundElements?.some((x) => x.id === arrowEl.id && x.type === "arrow")).toBe(true);
      }
    });

    it("keeps references consistent (labels, frames, bound elements)", () => {
      const ids = new Map(elements.map((e) => [e.id, e]));
      for (const e of elements) {
        if (e.type === "text" && e.containerId) {
          const container = ids.get(e.containerId);
          expect(container, e.id).toBeDefined();
          expect(container!.boundElements?.some((x) => x.id === e.id && x.type === "text")).toBe(true);
        }
        if (e.frameId) expect(ids.get(e.frameId)?.type, e.id).toBe("frame");
        for (const be of e.boundElements ?? []) expect(ids.has(be.id), `${e.id} → ${be.id}`).toBe(true);
      }
    });

    it("keeps positions and sizes of unrotated boxes", () => {
      const firstPage = c.records.filter((r) => r.typeName === "page").sort((a, b) => String(a.index).localeCompare(String(b.index)))[0];
      for (const r of shapes) {
        if (!["geo", "frame", "image", "note"].includes(String(r.type))) continue;
        if (r.type === "geo" && POLYGON_GEOS.has(String(propsOf(r).geo))) continue;
        const chain = [r, ...parentChain(r, byId)];
        if (chain.some((s) => s.rotation !== 0)) continue;
        const pageId = String(chain[chain.length - 1].parentId);
        if (firstPage && pageId !== firstPage.id) continue;
        const e = el(elements, excalidrawIdOf(r.id));
        close(e.x, chain.reduce((n, s) => n + Number(s.x), 0));
        close(e.y, chain.reduce((n, s) => n + Number(s.y), 0));
        const p = propsOf(r);
        if (r.type !== "note") {
          close(e.width, Number(p.w));
          close(e.height, Number(p.h) + Number(p.growY ?? 0));
        }
      }
    });

    it("reports warnings only for records that exist", () => {
      for (const w of result.warnings) expect(byId.has(w.recordId), w.recordId).toBe(true);
    });

    it("is deterministic, from an object or from the stored JSON text", () => {
      const a = JSON.stringify(tldrawToExcalidraw(c.data));
      const b = JSON.stringify(tldrawToExcalidraw(JSON.parse(JSON.stringify(c.data))));
      const t = JSON.stringify(tldrawToExcalidraw(JSON.stringify(c.data)));
      expect(b).toBe(a);
      expect(t).toBe(a);
    });
  });
});

describe("tldraw → Excalidraw: details", () => {
  const conv = (name: string) => {
    const c = canvases.find((x) => x.name === name)!;
    return tldrawToExcalidraw(c.data);
  };

  it("keeps Hebrew multi-line labels exactly and resolves RTL alignment", () => {
    const { elements } = conv("01-geo-basic").file;
    expect((el(elements, "d1-label") as ExTextElement).originalText).toBe("החלטה?\nכן / לא");
    expect(el(elements, "r2").link).toBe("https://example.com");
    // tldraw's crossed fill names: "solid" = the colour's pale tint, "semi" = near-white.
    expect(el(elements, "r1")).toMatchObject({ backgroundColor: "#dce1f8", fillStyle: "solid" });
    expect(el(elements, "e1").backgroundColor).toBe("#fcfffe");
    expect(el(elements, "r2").strokeStyle).toBe("dotted");
    expect(el(elements, "d1").strokeStyle).toBe("dashed");
    const t = conv("03-text").file.elements as ExTextElement[];
    expect(el(t, "t1")).toMatchObject({ text: "כותרת בעברית", textAlign: "right" });
    expect(el(t, "t2")).toMatchObject({ text: "English heading", textAlign: "left" });
    expect(el(t, "t3")).toMatchObject({ textAlign: "center" });
    expect(el(t, "t4")).toMatchObject({ text: "שורה ראשונה\nשורה שנייה\nשורה שלישית", textAlign: "left" });
    expect(el(t, "t5")).toMatchObject({ autoResize: false, width: 200, fontFamily: 6, originalText: "Fixed width paragraph that wraps" });
    const t5 = el(t, "t5") as ExTextElement;
    expect(t5.text.split("\n").length).toBeGreaterThan(1);
    expect(t5.height).toBe(t5.text.split("\n").length * 36 * 1.25);
    expect(el(t, "t6")).toMatchObject({ fontFamily: 3, fontSize: 44 });
    expect(isRtlText("123 שלום")).toBe(true);
    expect(isRtlText("Hello שלום")).toBe(false);
  });

  it("draws bent arrows through their midpoint and labels arrows", () => {
    const { elements } = conv("05-arrows-bound").file;
    const ca = el(elements, "ca") as ExLinearElement;
    expect(ca.points).toHaveLength(3);
    expect(ca.roundness).toEqual({ type: 2 });
    const ab = el(elements, "ab") as ExLinearElement;
    expect(ab.points).toEqual([[0, 0], [240, 0]]);
    expect((el(elements, "ab-label") as ExTextElement).containerId).toBe("ab");
    expect(ab.endBinding?.fixedPoint).toEqual([0.5, 0.5]);
    expect((el(elements, "bc") as ExLinearElement).endBinding?.fixedPoint).toEqual([0.5, 0]);
  });

  it("maps arrowheads", () => {
    const heads = (conv("06-arrows-free").file.elements as ExLinearElement[]).map((a) => a.endArrowhead);
    expect(heads).toEqual(["arrow", "triangle", "diamond", "circle", "bar", "diamond", "triangle_outline", "bar", null]);
  });

  it("reports elbow arrows and dangling bindings", () => {
    const codes = conv("07-arrows-edge").warnings.map((w) => w.code).sort();
    expect(codes).toEqual(["binding-dropped", "elbow-arrow"]);
  });

  it("puts frame children in their frame; nested frames are flattened with a warning", () => {
    const f = conv("08-frames").file.elements;
    expect(el(f, "in1").frameId).toBe("f1");
    expect(el(f, "in1-label").frameId).toBe("f1");
    expect(el(f, "fa").frameId).toBeNull();
    expect((el(f, "f1") as { name: string | null }).name).toBe("מסגרת א");
    const n = conv("09-nested-frames");
    expect(el(n.file.elements, "inner").frameId).toBeNull();
    expect(el(n.file.elements, "deep").frameId).toBe("inner");
    expect(el(n.file.elements, "shallow").frameId).toBe("outer");
    close(el(n.file.elements, "deep").x, 70);
    expect(n.warnings.map((w) => w.code)).toEqual(["nested-frame"]);
  });

  it("turns tldraw groups into Excalidraw groupIds, innermost first", () => {
    const g = conv("10-groups").file.elements;
    expect(el(g, "g1a").groupIds).toEqual(["g1"]);
    expect(el(g, "g2a").groupIds).toEqual(["g2", "g1"]);
    expect(el(g, "g2b").groupIds).toEqual(["g2", "g1"]);
  });

  it("embeds images as files, with crop and flip; shared assets are stored once", () => {
    const { elements, files } = conv("11-images").file;
    expect(Object.keys(files).sort()).toEqual(["png1", "png2"]);
    expect(files.png1.dataURL.startsWith("data:image/png;base64,")).toBe(true);
    const [i1, i2, i3] = ["i1", "i2", "i3"].map((id) => el(elements, id) as ExImageElement);
    expect(i1.fileId).toBe("png1");
    expect(i3.fileId).toBe("png1");
    expect(i3.scale).toEqual([-1, 1]);
    expect(i2.crop).toEqual({ x: 100, y: 0, width: 300, height: 100, naturalWidth: 400, naturalHeight: 200 });
  });

  it("never downloads a remote image: placeholder with the link and a warning", () => {
    const r = conv("12-images-missing");
    expect(r.warnings.filter((w) => w.code === "image-not-embedded")).toHaveLength(3);
    expect(el(r.file.elements, "remote").link).toBe("https://example.com/picture.png");
    expect(Object.keys(r.file.files)).toEqual([]);
  });

  it("converts freehand strokes: pressure, closed shapes, scale, highlighter", () => {
    const d = conv("13-draw").file.elements as ExFreedrawElement[];
    expect(el(d, "d1")).toMatchObject({ simulatePressure: true, pressures: [] });
    expect(el(d, "d2")).toMatchObject({ simulatePressure: false, pressures: [0.2, 0.6, 0.9] });
    const d3 = el(d, "d3") as ExFreedrawElement;
    expect(d3.points[d3.points.length - 1]).toEqual(d3.points[0]);
    expect(d3.backgroundColor).not.toBe("transparent");
    expect((el(d, "d4") as ExFreedrawElement).points).toEqual([[0, 0], [60, 0], [60, 0], [60, 15]]);
    expect(el(d, "hl").opacity).toBe(50);
  });

  it("converts lines with their points in order; cubic splines are rounded", () => {
    const l = conv("14-lines").file.elements as ExLinearElement[];
    expect(el(l, "l1")).toMatchObject({ x: 0, y: 0, points: [[0, 0], [100, 0], [100, 100]], roundness: null });
    expect(el(l, "l2").roundness).toEqual({ type: 2 });
  });

  it("keeps the centre and angle of rotated shapes, including children of rotated frames", () => {
    const r = conv("15-rotation").file.elements;
    const rot = el(r, "rot");
    const a = Math.PI / 4;
    close(rot.angle, a, 1e-9);
    close(rot.x + rot.width / 2, 100 + 80 * Math.cos(a) - 45 * Math.sin(a));
    close(rot.y + rot.height / 2, 100 + 80 * Math.sin(a) + 45 * Math.cos(a));
    const child = el(r, "rfc");
    const b = Math.PI / 6;
    const ox = 0 + 50 * Math.cos(b) - 50 * Math.sin(b);
    const oy = 400 + 50 * Math.sin(b) + 50 * Math.cos(b);
    close(child.angle, b, 1e-9);
    close(child.x + 50, ox + 50 * Math.cos(b) - 25 * Math.sin(b));
    close(child.y + 25, oy + 50 * Math.sin(b) + 25 * Math.cos(b));
    expect(el(r, "faded")).toMatchObject({ opacity: 40, locked: true });
    const ra = el(r, "ra") as ExLinearElement;
    close(ra.points[1][0], 0);
    close(ra.points[1][1], 100);
    // Scaled shapes: w / h, arrow terminals and bend are page units; scale sizes the label.
    expect(el(r, "big")).toMatchObject({ x: 900, y: 0, width: 100, height: 60 });
    expect((el(r, "big-label") as ExTextElement).fontSize).toBe(44);
    expect(el(r, "big").strokeWidth).toBe(4); // size m (2) × scale 2
    expect((el(r, "sline") as ExLinearElement).points).toEqual([[0, 0], [100, 50]]);
    // A dragged label on a bent arrow stays at its labelPosition along the arc.
    const lab = el(r, "lbent-label");
    const lx = lab.x + lab.width / 2;
    expect(lx).toBeGreaterThan(900 + 15);
    expect(lx).toBeLessThan(900 + 40);
    expect((el(r, "sarr") as ExLinearElement).points).toEqual([[0, 0], [100, 50]]);
    const bent = el(r, "sbent") as ExLinearElement;
    expect(bent.points[2]).toEqual([100, 0]);
    close(Math.abs(bent.points[1][1]), 20);
  });

  it("places a second page to the right of the first, with a warning", () => {
    const r = conv("16-pages");
    const p1 = el(r.file.elements, "p1a");
    const p2 = el(r.file.elements, "p2a");
    expect(p2.x).toBeGreaterThanOrEqual(p1.x + p1.width + 400);
    expect(r.warnings).toEqual([{ code: "extra-page", recordId: "page:two", recordType: "page", detail: "עמוד שני" }]);
  });

  it("wraps labels to their container and honours a note's shrunk font size", () => {
    const geoShape = (id: string, type: string, props: Record<string, unknown>) => ({
      id: `shape:${id}`, typeName: "shape", type, x: 0, y: 0, rotation: 0, index: "a1", parentId: "page:p", props,
    });
    const long = "מילה ".repeat(30).trim();
    const data = {
      store: {
        "page:p": { id: "page:p", typeName: "page", index: "a1", name: "P" },
        "shape:g": geoShape("g", "geo", { w: 120, h: 80, geo: "rectangle", richText: richText(long) }),
        "shape:n": geoShape("n", "note", { size: "m", fontSizeAdjustment: 14, richText: richText("x") }),
        "shape:r": geoShape("r", "note", { size: "m", fontSizeAdjustment: 0.5, richText: richText("x") }),
      },
    };
    const els = tldrawToExcalidraw(data).file.elements as ExTextElement[];
    const label = el(els, "g-label") as ExTextElement;
    expect(label.originalText).toBe(long);
    expect(label.text.split("\n").length).toBeGreaterThan(3);
    expect(label.width).toBeLessThanOrEqual(110);
    expect((el(els, "n-label") as ExTextElement).fontSize).toBe(14);
    expect((el(els, "r-label") as ExTextElement).fontSize).toBe(11);
  });

  it("separates pages by their rotated extent", () => {
    const shape = (id: string, page: string, rotation: number) => ({
      id: `shape:${id}`, typeName: "shape", type: "geo", x: 0, y: 0, rotation, index: "a1", parentId: page,
      props: { w: 400, h: 10, geo: "rectangle" },
    });
    const data = {
      store: {
        "page:a": { id: "page:a", typeName: "page", index: "a1", name: "A" },
        "page:b": { id: "page:b", typeName: "page", index: "a2", name: "B" },
        "shape:p1": shape("p1", "page:a", Math.PI / 2),
        "shape:p2": shape("p2", "page:b", 0),
      },
    };
    const els = tldrawToExcalidraw(data).file.elements;
    // p1 stands upright: centre (-5, 200), visible right edge at x = 0.
    close(el(els, "p2").x, 0 + 400);
  });

  it("reads the legacy store snapshot and the .tldr records file (tldraw 2.x arrows)", () => {
    const legacy = conv("17-legacy-store").file.elements as ExTextElement[];
    expect((el(legacy, "legacy-2-label") as ExTextElement).originalText).toBe("פתק ישן");
    const old = conv("18-tldr-v2").file.elements;
    const arrowEl = el(old, "oldarrow") as ExLinearElement;
    expect([arrowEl.x, arrowEl.y]).toEqual([160, 45]);
    expect(arrowEl.points).toEqual([[0, 0], [240, 0]]);
    expect(arrowEl.startBinding?.elementId).toBe("old1");
    expect(arrowEl.endBinding?.elementId).toBe("old2");
    expect((el(old, "old1-label") as ExTextElement).originalText).toBe("ישן");
    expect((el(old, "pointarrow") as ExLinearElement).points).toEqual([[0, 0], [150, 50]]);
  });

  it("keeps shapes with no Excalidraw element as labelled placeholders, never silently", () => {
    const r = conv("19-unsupported");
    expect(r.warnings.map((w) => `${w.code}:${w.recordId}`)).toEqual([
      "unsupported-shape:shape:vid",
      "unsupported-shape:shape:emb",
      "unsupported-shape:shape:bm",
      "unknown-shape:shape:custom",
    ]);
    for (const id of ["vid", "emb", "bm", "custom"]) {
      expect(el(r.file.elements, id)).toMatchObject({ type: "rectangle", strokeStyle: "dashed" });
    }
    expect((el(r.file.elements, "custom-label") as ExTextElement).originalText).toBe("[lumen-card] כרטיס");
    expect(el(r.file.elements, "emb").link).toBe("https://example.com/embed");
    expect(el(r.file.elements, "vid").link).toBe("https://example.com/clip.mp4");
  });

  it("gives derived ids a suffix instead of colliding with a real shape id", () => {
    const data = {
      store: {
        "page:p": { id: "page:p", typeName: "page", index: "a1", name: "P" },
        "shape:x": { id: "shape:x", typeName: "shape", type: "geo", x: 0, y: 0, rotation: 0, index: "a1", parentId: "page:p", props: { w: 10, h: 10, geo: "rectangle", richText: richText("a") } },
        "shape:x-label": { id: "shape:x-label", typeName: "shape", type: "geo", x: 0, y: 0, rotation: 0, index: "a2", parentId: "page:p", props: { w: 10, h: 10, geo: "rectangle", richText: richText("") } },
      },
    };
    const ids = tldrawToExcalidraw(data).file.elements.map((e) => e.id);
    expect(ids).toEqual(["x", "x-label~2", "x-label"]);
  });

  it("survives a parentId cycle and orphaned shapes", () => {
    const data = {
      store: {
        "page:p": { id: "page:p", typeName: "page", index: "a1", name: "P" },
        "shape:a": { id: "shape:a", typeName: "shape", type: "geo", x: 0, y: 0, index: "a1", parentId: "shape:b", props: { w: 10, h: 10 } },
        "shape:b": { id: "shape:b", typeName: "shape", type: "geo", x: 0, y: 0, index: "a2", parentId: "shape:a", props: { w: 10, h: 10 } },
        "shape:o": { id: "shape:o", typeName: "shape", type: "geo", x: 5, y: 5, index: "a3", parentId: "page:gone", props: { w: 10, h: 10 } },
      },
    };
    const ids = tldrawToExcalidraw(data).file.elements.map((e) => e.id);
    expect(ids.sort()).toEqual(["a", "b", "o"]);
  });

  it("decodes tldraw 4.5 base64 draw paths (float32 first point, float16 deltas)", () => {
    // `b64Vecs.encodePoints([{0,0,.5},{10,4,.5},{-3,7.5,.25},{1000.25,-2000.5,1}])`
    // as printed by tldraw 4.5.10 in CI.
    const sample = "AAAAAAAAAAAAAAA/AEkARAAAgMoAQwC012PY5wA6";
    expect(decodeDrawPath(sample)).toEqual([
      { x: 0, y: 0, z: 0.5 },
      { x: 10, y: 4, z: 0.5 },
      { x: -3, y: 7.5, z: 0.25 },
      // float16 deltas round: tldraw's own decoder gives the same numbers.
      { x: 1000.5, y: -2000.5, z: 1 },
    ]);
    // Fixture 13's pen stroke `d2` after tldraw 4.5's own migration (printed in CI).
    const migrated = decodeDrawPath("AAAAAAAAAADNzEw+AEUASWY2AEUATc00")!;
    const want = [[0, 0, 0.2], [5, 10, 0.6], [10, 30, 0.9]];
    expect(migrated).toHaveLength(3);
    migrated.forEach((p, i) => {
      close(p.x, want[i][0], 0.01);
      close(p.y, want[i][1], 0.01);
      close(p.z, want[i][2], 0.01);
    });
    expect(decodeDrawPath("")).toEqual([]);
    expect(decodeDrawPath("not base64!")).toBeNull();
    expect(decodeDrawPath("AAAA")).toBeNull();
    const data = {
      store: {
        "page:p": { id: "page:p", typeName: "page", index: "a1", name: "P" },
        "shape:d": { id: "shape:d", typeName: "shape", type: "draw", x: 1, y: 2, index: "a1", parentId: "page:p", props: { segments: [{ type: "free", path: sample }] } },
      },
    };
    const d = tldrawToExcalidraw(data).file.elements[0] as ExFreedrawElement;
    expect(d).toMatchObject({ x: 1, y: 2, points: [[0, 0], [10, 4], [-3, 7.5], [1000.5, -2000.5]] });
  });

  it("rejects input that isn't a tldraw canvas; an empty canvas is an empty scene", () => {
    expect(() => extractTldrawRecords("{not json")).toThrow(TldrawFormatError);
    expect(() => extractTldrawRecords({ hello: 1 })).toThrow(TldrawFormatError);
    expect(() => tldrawToExcalidraw([])).toThrow(TldrawFormatError);
    const empty = tldrawToExcalidraw({ store: { "document:document": { id: "document:document", typeName: "document", gridSize: 10 } } });
    expect(empty.file.elements).toEqual([]);
    expect(empty.file.appState.gridSize).toBe(10);
    expect(empty.warnings).toEqual([]);
  });
});

describe("tldraw → Excalidraw: no network, no outside imports", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("converts all twenty canvases without fetch, XHR, WebSocket or beacons", () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network");
    });
    const ctor = vi.fn(function () {
      throw new Error("network");
    });
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("XMLHttpRequest", ctor);
    vi.stubGlobal("WebSocket", ctor);
    vi.stubGlobal("EventSource", ctor);
    vi.stubGlobal("Image", ctor);
    const beacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: beacon });
    for (const c of canvases) tldrawToExcalidraw(c.data);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ctor).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
  });

  const canvasDir = resolve(__dirname, "..", "canvas");
  const srcDir = resolve(__dirname, "..");
  const importsOf = (code: string): string[] =>
    [...code.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/gm)].map(
      (m) => m[1] ?? m[2] ?? m[3],
    );

  it("the converter imports nothing and names no network API", () => {
    const code = readFileSync(join(canvasDir, "tldrawToExcalidraw.ts"), "utf8");
    expect(importsOf(code)).toEqual([]);
    const body = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const api of ["fetch(", "XMLHttpRequest", "WebSocket", "sendBeacon", "EventSource", "new Image", "importScripts"]) {
      expect(body.includes(api), api).toBe(false);
    }
  });

  it("every src/canvas module imports only from inside src/", () => {
    const files = readdirSync(canvasDir).filter((f) => f.endsWith(".ts"));
    expect(files).toContain("tldrawToExcalidraw.ts");
    for (const f of files) {
      const code = readFileSync(join(canvasDir, f), "utf8");
      for (const spec of importsOf(code)) {
        expect(spec.startsWith("."), `${f}: ${spec}`).toBe(true);
        expect(resolve(dirname(join(canvasDir, f)), spec).startsWith(srcDir), `${f}: ${spec}`).toBe(true);
      }
    }
  });
});
