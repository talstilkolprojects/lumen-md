/**
 * The Excalidraw canvas (plan 4.19, part 2): the file it saves and opens,
 * when a change is saved, its language, the two legacy formats, the
 * debounced save, and that tldraw is gone from the code and the manifest.
 * Driving Excalidraw itself in jsdom isn't feasible (canvas, layout, fonts);
 * e2e/canvas-excalidraw.spec.ts does that in Chromium.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { emptyScene, excalidrawLangOf, fileToInitialData, legacyCanvasToExcalidraw, legacyCanvasToTldrawSnapshot, sceneStamp, sceneToFile, tldrCanvasToExcalidraw, SCENE_SOURCE } from "../canvas/excalidrawScene";
import { parseExcalidrawFile, serializeExcalidrawFile } from "../canvas/excalidrawFile";
import { buildFixtureCanvases } from "./fixtures/tldrawCanvases";
import { debouncedSave } from "../ui/CanvasExcalidraw";

vi.mock("@excalidraw/excalidraw", () => ({ Excalidraw: () => null }));
vi.mock("@excalidraw/excalidraw/index.css", () => ({}));

const rect = (id: string, version = 1, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", version, isDeleted: false, x: 0, y: 0, width: 10, height: 10, ...extra });
const image = (id: string, fileId: string) => ({ id, type: "image", version: 3, isDeleted: false, x: 5, y: 5, width: 20, height: 20, fileId });

describe("the file the canvas saves", () => {
  it("keeps live elements, the files an image still uses and the drawing's appState — nothing of the session", () => {
    const files = { f1: { id: "f1", mimeType: "image/png", dataURL: "data:image/png;base64,AA==", created: 1, lastRetrieved: 1 }, f2: { id: "f2", mimeType: "image/png", dataURL: "data:,", created: 1, lastRetrieved: 1 } };
    const elements = [rect("a"), { ...rect("b"), isDeleted: true }, image("img", "f1")];
    const file = sceneToFile(elements, { viewBackgroundColor: "#fafafa", gridSize: 20, selectedElementIds: { a: true }, zoom: { value: 2 } }, files);
    expect(file.elements.map((e) => e.id)).toEqual(["a", "img"]);
    expect(Object.keys(file.files)).toEqual(["f1"]);
    expect(file.appState).toEqual({ viewBackgroundColor: "#fafafa", gridSize: 20 });
    expect(file).toMatchObject({ type: "excalidraw", version: 2, source: SCENE_SOURCE });
    // It is a valid .excalidraw file as src/canvas/excalidrawFile.ts reads it, unchanged by a round trip.
    expect(parseExcalidrawFile(serializeExcalidrawFile(file))).toEqual(file);
  });

  it("opens with the file's elements, files and appState, scrolled to the drawing; an empty canvas otherwise", () => {
    const file = sceneToFile([rect("a")], { viewBackgroundColor: "#000000", gridSize: null }, {});
    expect(fileToInitialData(file)).toEqual({ elements: file.elements, appState: { viewBackgroundColor: "#000000", gridSize: null }, files: {}, scrollToContent: true });
    expect(fileToInitialData(null)).toMatchObject({ elements: [], scrollToContent: false, appState: { viewBackgroundColor: "#ffffff" } });
    expect(emptyScene().elements).toEqual([]);
  });

  it("the stamp changes with the drawing, not with a selection, a pan or a zoom", () => {
    const base = sceneStamp([rect("a", 1), rect("b", 4)], { viewBackgroundColor: "#fff", gridSize: null });
    expect(sceneStamp([rect("a", 1), rect("b", 4)], { viewBackgroundColor: "#fff", gridSize: null, selectedElementIds: { a: true }, scrollX: 40, zoom: { value: 1.5 } })).toBe(base);
    expect(sceneStamp([rect("a", 2), rect("b", 4)], { viewBackgroundColor: "#fff", gridSize: null })).not.toBe(base);
    expect(sceneStamp([rect("a", 1), rect("b", 4)], { viewBackgroundColor: "#eee", gridSize: null })).not.toBe(base);
    expect(sceneStamp([rect("a", 1), rect("b", 4)], { viewBackgroundColor: "#fff", gridSize: 20 })).not.toBe(base);
  });
});

describe("the editor's language", () => {
  it("is Excalidraw's code for each of the 8 locales, English for anything else", () => {
    expect(["he", "ar", "ru", "fr", "de", "ja", "zh-CN", "en"].map(excalidrawLangOf)).toEqual(["he-IL", "ar-SA", "ru-RU", "fr-FR", "de-DE", "ja-JP", "zh-CN", "en"]);
    expect(excalidrawLangOf("xx")).toBe("en");
  });

  it("every code it names ships as an Excalidraw locale", () => {
    const dir = resolve(__dirname, "../../node_modules/@excalidraw/excalidraw/dist/prod/locales");
    const files = readdirSync(dir);
    for (const loc of ["he", "ar", "ru", "fr", "de", "ja", "zh-CN"]) expect(files.some((f) => f.startsWith(`${excalidrawLangOf(loc)}-`)), loc).toBe(true);
  });
});

describe("legacy formats", () => {
  it("a .tldr becomes an Excalidraw scene with the same shapes (every converter fixture)", () => {
    for (const c of buildFixtureCanvases()) {
      const r = tldrCanvasToExcalidraw(JSON.stringify(c.data), 5);
      expect(r.file.type).toBe("excalidraw");
      expect(r.file.elements.length, c.name).toBeGreaterThan(0);
      for (const e of r.file.elements) expect(e.updated).toBe(5);
    }
  });

  it("a pre-tldraw .canvas.json becomes notes at their positions, through the same converter", () => {
    const legacy = { nodes: [{ id: "n1", x: 10, y: 20, width: 200, height: 100, content: "# שלום\n\nעולם" }, { id: "n2", x: 400, y: 20, width: 200, height: 100, content: "two" }], edges: [{ from: "n1", to: "n2" }] };
    const snap = legacyCanvasToTldrawSnapshot(legacy);
    expect(Object.keys(snap.store).filter((k) => k.startsWith("shape:"))).toEqual(["shape:legacy-n1", "shape:legacy-n2"]);
    const r = legacyCanvasToExcalidraw(JSON.stringify(legacy));
    const texts = r.file.elements.filter((e) => e.type === "text").map((e) => (e as { text: string }).text);
    expect(texts).toEqual(expect.arrayContaining([expect.stringContaining("שלום"), "two"]));
    const containers = r.file.elements.filter((e) => e.type !== "text");
    expect(containers.map((e) => [e.x, e.y])).toEqual(expect.arrayContaining([[10, 20], [400, 20]]));
    expect(() => legacyCanvasToExcalidraw('{"foo":1}')).toThrow(/not a legacy canvas/);
  });
});

describe("the debounced save", () => {
  it("closing within the debounce flushes the pending save instead of dropping it", () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn();
      const s = debouncedSave(save, 500);
      s.schedule();
      s.schedule();
      vi.advanceTimersByTime(200);
      s.flush(); // unmount 200 ms after the last stroke
      expect(save).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
      expect(save).toHaveBeenCalledTimes(1);
      s.flush(); // nothing pending: no extra write
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("tldraw is gone (plan 4.19 acceptance)", () => {
  const root = resolve(__dirname, "../..");

  it("not a dependency, not in the lockfile", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((n) => /tldraw/i.test(n))).toEqual([]);
    expect(pkg.dependencies["@excalidraw/excalidraw"]).toMatch(/^\^?0\.18\./);
    const lock = readFileSync(join(root, "package-lock.json"), "utf8");
    expect(lock).not.toMatch(/"node_modules\/(@tldraw\/|tldraw")/);
  });

  it("no source file imports it; the converter's fixtures are data, not imports", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|css)$/.test(name) && /from\s+["']tldraw|import\s+["']tldraw|require\(["']tldraw/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk(join(root, "src"));
    expect(hits).toEqual([]);
    expect(readFileSync(join(root, "index.html"), "utf8")).not.toContain("tldraw");
    // The CSP's font and connect lists no longer name tldraw's CDN; no app module does either.
    const appHits: string[] = [];
    const scan = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) scan(p);
        else if (/\.(ts|tsx|css)$/.test(name) && !/__tests__/.test(p) && readFileSync(p, "utf8").includes("cdn.tldraw.com")) appHits.push(p);
      }
    };
    scan(join(root, "src"));
    expect(appHits).toEqual([]);
  });
});
