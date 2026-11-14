/**
 * The vault as a graph, for the graph views (plan W1.10): built from the
 * vault index (perf 8.4) — no second read of the notes — and kept until the
 * index changes. Colours come from the theme's CSS variables.
 */
import { useEffect, useState } from "react";
import { buildGraph, degreeOf, type GraphData } from "../../graph/graphModel";
import { ensureIndex, indexedFiles } from "../../storage/workspaceIndex";
import { onWorkspaceChanged } from "../../storage/workspaceEvents";
import { log } from "../../lib/logger";
import { explainError } from "../../lib/userError";

let cached: { key: string; graph: GraphData } | null = null;

function signature(files: ReturnType<typeof indexedFiles>): string {
  let h = files.length;
  for (const f of files) h = (h * 31 + f.modified + f.path.length) % 2_147_483_647;
  return `${files.length}:${h}`;
}

/** The current vault graph (built at most once per index state). */
export async function loadVaultGraph(): Promise<GraphData> {
  await ensureIndex();
  const files = indexedFiles();
  const key = signature(files);
  if (cached?.key === key) return cached.graph;
  // W2.22: the index's summary carries the tags and frontmatter values; no note text on this thread.
  const graph = buildGraph(files.map((f) => ({ path: f.path, wikiTargets: f.wikiTargets, meta: f.meta })));
  cached = { key, graph };
  return graph;
}

export function useVaultGraph(): { graph: GraphData | null; error: string | null } {
  const [graph, setGraph] = useState<GraphData | null>(cached?.graph ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      loadVaultGraph()
        .then((g) => !cancelled && setGraph(g))
        .catch((e: unknown) => {
          log.warn("graph: load failed", e);
          if (!cancelled) setError(explainError(e));
        });
    void load();
    const off = onWorkspaceChanged(() => void load(), { debounceMs: 800 });
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return { graph, error };
}

/** A CSS colour (any syntax, CSS variables included) as r, g, b, a in 0–1. */
export function resolveColor(css: string, alpha = 1): [number, number, number, number] {
  if (typeof document === "undefined") return [0.5, 0.5, 0.5, alpha];
  const el = document.createElement("span");
  el.style.color = css;
  el.style.display = "none";
  document.body.appendChild(el);
  const out = getComputedStyle(el).color;
  el.remove();
  const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(out);
  if (!m) return [0.5, 0.5, 0.5, alpha];
  return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, (m[4] === undefined ? 1 : Number(m[4])) * alpha];
}

/** Group colours: evenly spaced hues at the theme's lightness, as CSS. */
// design-allow: generated category hues for graph groups (data colours, not interface colours)
export const groupColor = (k: number) => `hsl(${(k * 137.508 + 250) % 360} 62% 56%)`;

/** Node colours (by group, else the accent) and sizes (by number of links) for nodes `ids` of the graph. */
export function nodeStyle(graph: GraphData, ids: ArrayLike<number>, group: Int16Array | null): { colors: Float32Array; sizes: Float32Array } {
  const accent = resolveColor("hsl(var(--accent))");
  const muted = resolveColor("hsl(var(--fg-muted))");
  const palette = new Map<number, [number, number, number, number]>();
  const colors = new Float32Array(ids.length * 4);
  const sizes = new Float32Array(ids.length);
  for (let k = 0; k < ids.length; k++) {
    const i = ids[k];
    const g = group ? group[i] : -1;
    let c: [number, number, number, number];
    if (g >= 0) {
      if (!palette.has(g)) palette.set(g, resolveColor(groupColor(g)));
      c = palette.get(g)!;
    } else c = degreeOf(graph, i) ? accent : muted;
    colors.set(c, 4 * k);
    sizes[k] = 3 + Math.min(9, Math.sqrt(degreeOf(graph, i)) * 1.4);
  }
  return { colors, sizes };
}
