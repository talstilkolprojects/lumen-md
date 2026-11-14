/**
 * W1.10 — the graph for 10,000 notes: the model (links, CSR, filters,
 * groups, local graph), the Barnes–Hut layout (time and shape), keyboard
 * steps, and the timings of the acceptance criteria that run outside a browser.
 */
import { describe, expect, it } from "vitest";
import { buildGraph, degreeOf, filteredGraph, groupsOf, localGraph, neighborsOf, noteMeta, passes, stepFrom, type GraphNoteInput } from "../graph/graphModel";
import { initialPositions, layoutGraph, PointGrid } from "../graph/layout";
import { fitView, toScreen, toWorld } from "../graph/renderer";

/** A deterministic PRNG (mulberry32). */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n notes in clusters (folders), about 5 links each, 90% inside the cluster. */
function vault(n: number, clusters = Math.max(4, Math.round(n / 250)), seed = 7): GraphNoteInput[] {
  const rnd = prng(seed);
  const notes = Array.from({ length: n }, (_, i) => ({ path: `c${i % clusters}/n${i}.md`, wikiTargets: [] as string[] }));
  for (let e = 0; e < n * 5; e++) {
    const a = Math.floor(rnd() * n);
    const b = rnd() < 0.9 ? (Math.floor(rnd() * (n / clusters)) * clusters + (a % clusters)) % n : Math.floor(rnd() * n);
    notes[a].wikiTargets.push(`n${b}`);
  }
  return notes;
}

describe("the graph model", () => {
  const g = buildGraph([
    { path: "Home.md", wikiTargets: ["Projects/Alpha", "beta", "Missing", "Home"], content: "---\ntags: [hub, index]\nstatus: open\n---\n# Home #start" },
    { path: "Projects/Alpha.md", wikiTargets: ["Home", "Home#Top", "Beta|the beta"], content: "---\ntags:\n  - project/active\n---\n" },
    { path: "Notes/Beta.md", wikiTargets: ["Home"] },
    { path: "Notes/בית.md", wikiTargets: ["Projects/Alpha.md", "Notes/בית"], content: "שלום #עברית" },
  ]);
  it("resolves links by path, path without .md and name; drops self-links, duplicates and missing targets", () => {
    expect(g.edges.length / 2).toBe(4); // Home–Alpha, Home–Beta, Alpha–Beta, בית–Alpha
  });
  it("keeps neighbours in CSR form", () => {
    const home = g.indexOf.get("Home.md")!;
    const alpha = g.indexOf.get("Projects/Alpha.md")!;
    expect([...neighborsOf(g, home)].map((i) => g.labels[i]).sort()).toEqual(["Alpha", "Beta"]);
    expect([...neighborsOf(g, alpha)].map((i) => g.labels[i]).sort()).toEqual(["Beta", "Home", "בית"]);
    expect(degreeOf(g, g.indexOf.get("Notes/בית.md")!)).toBe(1);
  });
  it("reads tags and properties", () => {
    expect(noteMeta("---\ntags: [a, \"b\"]\nkey: 'v'\nlist: [1, 2]\n---\nText #c and `#notatag`").tags.sort()).toEqual(["a", "b", "c"]);
    expect(noteMeta("---\nkey: 'v'\n---\n").props).toEqual({ key: "v" });
    expect(g.tags[g.indexOf.get("Notes/בית.md")!]).toEqual(["עברית"]);
  });
  it("filters by tag (nested too), folder and property", () => {
    const alpha = g.indexOf.get("Projects/Alpha.md")!;
    const home = g.indexOf.get("Home.md")!;
    expect(passes(g, alpha, { tag: "project" })).toBe(true);
    expect(passes(g, home, { tag: "project" })).toBe(false);
    expect(passes(g, alpha, { folder: "Projects" })).toBe(true);
    expect(passes(g, home, { property: "status=open" })).toBe(true);
    expect(passes(g, home, { property: "status=done" })).toBe(false);
    expect(filteredGraph(g, { folder: "Notes" }).nodes.length).toBe(2);
  });
  it("groups by top folder, biggest group first", () => {
    const { group, names } = groupsOf(g, "folder");
    expect(names[0]).toBe("Notes");
    expect(group[g.indexOf.get("Home.md")!]).toBe(-1);
  });
});

describe("10,000 notes and 50,000 links", () => {
  const notes = vault(10_000);
  it("builds the graph quickly", () => {
    const t0 = performance.now();
    const g = buildGraph(notes);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(g.edges.length / 2).toBeGreaterThan(45_000);
  });

  it("lays out in under 3 seconds, with linked notes close together", () => {
    const g = buildGraph(notes);
    const t0 = performance.now();
    const pos = layoutGraph(g.paths.length, g.edges);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(3000);
    for (const v of pos) expect(Number.isFinite(v)).toBe(true);
    let edge = 0;
    for (let e = 0; e < g.edges.length; e += 2) edge += Math.hypot(pos[2 * g.edges[e]] - pos[2 * g.edges[e + 1]], pos[2 * g.edges[e] + 1] - pos[2 * g.edges[e + 1] + 1]);
    edge /= g.edges.length / 2;
    let random = 0;
    for (let k = 0; k < 20_000; k++) {
      const a = (k * 7919) % g.paths.length;
      const b = (k * 104_729 + 13) % g.paths.length;
      random += Math.hypot(pos[2 * a] - pos[2 * b], pos[2 * a + 1] - pos[2 * b + 1]);
    }
    random /= 20_000;
    // A link is less than half as long as the distance between two notes at random.
    expect(edge / random).toBeLessThan(0.5);
  });

  it("opens a local graph of depth 1–3 in under 200 ms, layout included", () => {
    const g = buildGraph(notes);
    for (const depth of [1, 2, 3]) {
      const t0 = performance.now();
      const sub = localGraph(g, 42, depth);
      layoutGraph(sub.nodes.length, sub.edges, { iterations: Math.min(150, 40 + sub.nodes.length) });
      const ms = performance.now() - t0;
      expect(ms, `depth ${depth}: ${sub.nodes.length} notes`).toBeLessThan(200);
      expect(sub.nodes[0]).toBe(42);
      expect(Math.max(...sub.depth)).toBeLessThanOrEqual(depth);
    }
  });
});

describe("the local graph", () => {
  // A chain 0–1–2–3–4, with 2 tagged.
  const g = buildGraph(Array.from({ length: 5 }, (_, i) => ({ path: `n${i}.md`, wikiTargets: i < 4 ? [`n${i + 1}`] : [], content: i === 2 ? "#x" : "" })));
  it("takes the notes within the depth, the centre first", () => {
    expect([...localGraph(g, 0, 1).nodes]).toEqual([0, 1]);
    expect([...localGraph(g, 0, 3).nodes]).toEqual([0, 1, 2, 3]);
    expect([...localGraph(g, 2, 1).depth]).toEqual([0, 1, 1]);
    // Depth is 1–3.
    expect(localGraph(g, 0, 9).nodes.length).toBe(4);
    expect(localGraph(g, 0, 3).edges.length / 2).toBe(3);
  });
  it("applies the filter to the notes around the centre", () => {
    expect([...localGraph(g, 1, 1, { tag: "x" }).nodes]).toEqual([1, 2]);
  });
});

describe("keyboard and view", () => {
  const pos = Float32Array.from([0, 0, 10, 0, -10, 0, 0, 10, 0, -10, 30, 1]);
  it("steps to the linked note in the arrow's direction, else the nearest that way", () => {
    expect(stepFrom(pos, 6, 0, 1, 0, [1, 5])).toBe(1);
    expect(stepFrom(pos, 6, 0, -1, 0, [1])).toBe(2); // no link to the left: the nearest note there
    expect(stepFrom(pos, 6, 0, 0, 1)).toBe(3);
    expect(stepFrom(pos, 6, 5, 1, 0)).toBe(-1);
  });
  it("finds the node under the pointer", () => {
    const grid = new PointGrid(pos, 8);
    expect(grid.nearest(9, 1, 4)).toBe(1);
    expect(grid.nearest(50, 50, 4)).toBe(-1);
  });
  it("fits and maps between screen and world", () => {
    const v = fitView(initialPositions(100), 800, 600);
    const p = toScreen(v, 800, 600, 3, 4);
    const w = toWorld(v, 800, 600, p.x, p.y);
    expect(Math.abs(w.x - 3)).toBeLessThan(1e-4);
    expect(Math.abs(w.y - 4)).toBeLessThan(1e-4);
  });
  it("is deterministic", () => {
    const g = buildGraph(vault(300, 6, 1));
    expect(layoutGraph(300, g.edges)).toEqual(layoutGraph(300, g.edges));
  });
});
