/**
 * The local graph (plan W1.10): the open note and the notes within 1–3
 * links of it, in the sidebar, with the full graph's filters and colour
 * groups. The subgraph is a BFS over the vault graph's arrays and is small,
 * so it is laid out on the spot — the panel opens in well under 200 ms.
 */

import { useMemo, useState } from "react";
import { groupsOf, localGraph, type GraphFilter } from "../graph/graphModel";
import { layoutGraph } from "../graph/layout";
import { t } from "../i18n";
import { GraphCanvas } from "./graph/GraphCanvas";
import { nodeStyle, resolveColor, useVaultGraph } from "./graph/graphData";
import { HelpButton } from "./HelpButton";

const field = { fontSize: 11, paddingInline: 4, paddingBlock: 2, borderRadius: 4, border: "1px solid hsl(var(--border))", background: "hsl(var(--bg))", color: "hsl(var(--fg))", minInlineSize: 0, flex: 1 } as const;

/** Starting positions in rings by depth, so the small layout settles in a few steps. */
function ringStart(depth: Uint8Array): Float32Array {
  const n = depth.length;
  const p = new Float32Array(2 * n);
  const perRing = new Map<number, number>();
  for (let i = 0; i < n; i++) perRing.set(depth[i], (perRing.get(depth[i]) ?? 0) + 1);
  const seen = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const d = depth[i];
    const k = seen.get(d) ?? 0;
    seen.set(d, k + 1);
    const a = (2 * Math.PI * k) / (perRing.get(d) ?? 1);
    p[2 * i] = d * 60 * Math.cos(a);
    p[2 * i + 1] = d * 60 * Math.sin(a);
  }
  return p;
}

export function LocalGraphPanel({ filePath, onOpen }: { filePath: string | null; onOpen: (path: string) => void }) {
  const { graph } = useVaultGraph();
  const [depth, setDepth] = useState(1);
  const [filter, setFilter] = useState<GraphFilter>({});
  const center = graph && filePath ? graph.indexOf.get(filePath) : undefined;

  const local = useMemo(() => {
    if (!graph || center === undefined) return null;
    const sub = localGraph(graph, center, depth, filter);
    const positions = layoutGraph(sub.nodes.length, sub.edges, { iterations: Math.min(150, 40 + sub.nodes.length) }, ringStart(sub.depth));
    const adj: number[][] = Array.from({ length: sub.nodes.length }, () => []);
    for (let e = 0; e < sub.edges.length; e += 2) {
      adj[sub.edges[e]].push(sub.edges[e + 1]);
      adj[sub.edges[e + 1]].push(sub.edges[e]);
    }
    const { group } = groupsOf(graph, "folder");
    return { sub, positions, adj, style: nodeStyle(graph, sub.nodes, group), labels: Array.from(sub.nodes, (i: number) => graph.labels[i]) };
  }, [graph, center, depth, filter]);

  const edgeColor = useMemo(() => resolveColor("hsl(var(--fg-muted))", 0.35), []);
  const ring = useMemo(() => resolveColor("hsl(var(--accent))"), []);
  const set = (k: keyof GraphFilter) => (e: { target: { value: string } }) => setFilter((f) => ({ ...f, [k]: e.target.value.trim() || undefined }));

  return (
    <aside aria-label={t("graph.local.title")} data-testid="local-graph" style={{ inlineSize: 280, flexShrink: 0, borderInlineStart: "1px solid hsl(var(--border))", display: "flex", flexDirection: "column", fontSize: 12 }}>
      <div style={{ padding: "6px 8px", display: "flex", gap: 6, alignItems: "center", borderBlockEnd: "1px solid hsl(var(--border))" }}>
        <strong style={{ flex: 1 }}>{t("graph.local.title")}</strong>
        <HelpButton topic="workspace/graph#the-local-graph" />
        <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          {t("graph.local.depth")}
          <select value={depth} onChange={(e) => setDepth(Number(e.target.value))} data-testid="local-graph-depth" style={{ fontSize: 11 }}>
            {[1, 2, 3].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ display: "flex", gap: 4, padding: "4px 8px" }}>
        <input dir="auto" placeholder={t("graph.filter.tag")} aria-label={t("graph.filter.tag")} onChange={set("tag")} style={field} />
        <input dir="auto" placeholder={t("graph.filter.folder")} aria-label={t("graph.filter.folder")} onChange={set("folder")} style={field} />
      </div>
      <div style={{ flex: 1, minBlockSize: 200, position: "relative" }}>
        {!local ? (
          <p style={{ padding: 12, color: "hsl(var(--fg-muted))" }}>{t("graph.local.noNote")}</p>
        ) : (
          <GraphCanvas
            compact
            labels={local.labels}
            edges={local.sub.edges}
            neighbors={(i) => local.adj[i] ?? []}
            positions={local.positions}
            colors={local.style.colors}
            sizes={local.style.sizes}
            edgeColor={edgeColor}
            ring={ring}
            labelColor="hsl(var(--fg))"
            initialFocus={0}
            onOpen={(k) => graph && onOpen(graph.paths[local.sub.nodes[k]])}
            ariaLabel={t("graph.local.ariaLabel", { name: local.labels[0], nodes: local.sub.nodes.length })}
            fitKey={`${filePath}:${depth}:${JSON.stringify(filter)}:${local.sub.nodes.length}`}
          />
        )}
      </div>
    </aside>
  );
}
