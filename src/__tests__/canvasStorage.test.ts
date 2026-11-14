/**
 * Tests for the canvas persistence helpers. Workspace is mocked so the
 * write-back path can be verified without touching OPFS.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../storage/workspace", () => {
  const files = new Map<string, string>();
  return {
    isOPFSAvailable: () => true,
    listWorkspace: async () => {
      return [...files.entries()].map(([path]) => ({
        path,
        name: path.split("/").pop() ?? path,
        size: 0,
        modified: 0,
      }));
    },
    readWorkspaceFile: async (p: string) => {
      const f = files.get(p);
      if (f === undefined) throw new Error(`missing ${p}`);
      return f;
    },
    writeWorkspaceFile: async (p: string, c: string) => {
      files.set(p, c);
    },
    __getFiles: () => Object.fromEntries(files.entries()),
    __setFiles(initial: Record<string, string>) {
      files.clear();
      for (const [k, v] of Object.entries(initial)) files.set(k, v);
    },
  };
});

import * as ws from "../storage/workspace";
import {
  canvasPath,
  listCanvases,
  loadCanvas,
  saveCanvas,
  flushCanvas,
} from "../ui/canvasStorage";

beforeEach(() => {
  (ws as unknown as { __setFiles(d: Record<string, string>): void }).__setFiles({});
});

describe("canvasPath", () => {
  it("namespaces under canvases/ with .canvas.json", () => {
    expect(canvasPath("ideas")).toBe("canvases/ideas.canvas.json");
  });
  it("scrubs unsafe characters", () => {
    expect(canvasPath("with/slash")).toBe("canvases/with_slash.canvas.json");
  });
  it("idempotent — accepts a name that already has the suffix", () => {
    expect(canvasPath("done.canvas.json")).toBe("canvases/done.canvas.json");
  });
  it("falls back to 'untitled' on empty input", () => {
    expect(canvasPath("")).toBe("canvases/untitled.canvas.json");
  });
});

describe("save → load roundtrip", () => {
  it("persists nodes, edges, and viewport and reads them back", async () => {
    await saveCanvas("ideas", {
      nodes: [{ id: "n1", x: 1, y: 2, width: 100, height: 60, content: "hi", color: "#fff" }],
      edges: [{ from: "n1", to: "n2" }],
      viewport: { pan: { x: 5, y: 6 }, zoom: 1.5 },
    });
    const loaded = await loadCanvas("ideas");
    expect(loaded?.version).toBe(1);
    expect(loaded?.nodes).toHaveLength(1);
    expect(loaded?.edges[0]).toEqual({ from: "n1", to: "n2" });
    expect(loaded?.viewport.zoom).toBe(1.5);
    expect(typeof loaded?.modified).toBe("string");
  });
});

describe("listCanvases", () => {
  it("returns basenames sorted alphabetically", async () => {
    await saveCanvas("zeta", { nodes: [], edges: [], viewport: { pan: { x: 0, y: 0 }, zoom: 1 } });
    await saveCanvas("alpha", { nodes: [], edges: [], viewport: { pan: { x: 0, y: 0 }, zoom: 1 } });
    await saveCanvas("mu", { nodes: [], edges: [], viewport: { pan: { x: 0, y: 0 }, zoom: 1 } });
    expect(await listCanvases()).toEqual(["alpha", "mu", "zeta"]);
  });
});

describe("loadCanvas missing", () => {
  it("returns null when the canvas doesn't exist", async () => {
    expect(await loadCanvas("nope")).toBeNull();
  });
});

describe("flushCanvas", () => {
  it("flushCanvas() with no in-flight saves resolves cleanly", async () => {
    await expect(flushCanvas()).resolves.toBeUndefined();
  });
});
