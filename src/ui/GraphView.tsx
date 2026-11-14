/**
 * The knowledge graph (plan W1.10): every note of the vault, sized for
 * 10,000 notes and 50,000 links. The graph comes from the vault index, the
 * layout runs in a worker and draws as it settles, nodes and links are drawn
 * with WebGL (./graph/GraphCanvas.tsx). Filters by tag, folder or property,
 * colour groups by folder or tag; the keyboard reaches every note.
 */

import { useEffect, useMemo, useState } from "react";
import { filteredGraph, groupsOf, type GraphFilter, type GroupBy } from "../graph/graphModel";
import { runLayout } from "../graph/layoutClient";
import { readWorkspaceFile } from "../storage/workspace";
import { log } from "../lib/logger";
import { t } from "../i18n";
import { GraphCanvas } from "./graph/GraphCanvas";
import { EmptyState, runCommand } from "./EmptyState";
import { groupColor, nodeStyle, resolveColor, useVaultGraph } from "./graph/graphData";
import "./graphViewStrings";

const field = { fontSize: 12, paddingInline: 6, paddingBlock: 3, borderRadius: 4, border: "1px solid hsl(var(--border))", background: "hsl(var(--bg))", color: "hsl(var(--fg))", inlineSize: 120 } as const;

export function GraphView({ onOpenFile }: { onOpenFile: (path: string, content: string) => void }) {
  const { graph } = useVaultGraph();
  const [filter, setFilter] = useState<GraphFilter>({});
  const [groupBy, setGroupBy] = useState<GroupBy>("folder");
  const [positions, setPositions] = useState<Float32Array | null>(null);
  const [laying, setLaying] = useState(false);

  const sub = useMemo(() => (graph ? filteredGraph(graph, filter) : null), [graph, filter]);
  const groups = useMemo(() => (graph ? groupsOf(graph, groupBy) : null), [graph, groupBy]);
  const style = useMemo(() => (graph && sub ? nodeStyle(graph, sub.nodes, groupBy === "none" ? null : groups!.group) : null), [graph, sub, groups, groupBy]);
  const labels = useMemo(() => (graph && sub ? Array.from(sub.nodes, (i: number) => graph.labels[i]) : []), [graph, sub]);
  const adjacency = useMemo(() => {
    if (!sub) return [] as number[][];
    const adj: number[][] = Array.from({ length: sub.nodes.length }, () => []);
    for (let e = 0; e < sub.edges.length; e += 2) {
      adj[sub.edges[e]].push(sub.edges[e + 1]);
      adj[sub.edges[e + 1]].push(sub.edges[e]);
    }
    return adj;
  }, [sub]);

  // Lay out in the worker; draw every few steps while it settles.
  useEffect(() => {
    if (!sub) return;
    let cancelled = false;
    setLaying(true);
    setPositions(null);
    runLayout(sub.nodes.length, sub.edges, (p) => !cancelled && setPositions(p))
      .then((p) => !cancelled && setPositions(p))
      .catch((e: unknown) => log.warn("graph: layout failed", e))
      .finally(() => !cancelled && setLaying(false));
    return () => {
      cancelled = true;
    };
  }, [sub]);

  const edgeColor = useMemo(() => resolveColor("hsl(var(--fg-muted))", 0.18), []);
  const ring = useMemo(() => resolveColor("hsl(var(--fg))"), []);
  const labelColor = "hsl(var(--fg))";

  const open = async (k: number) => {
    if (!graph || !sub) return;
    const path = graph.paths[sub.nodes[k]];
    try {
      onOpenFile(path, await readWorkspaceFile(path));
    } catch (err) {
      log.warn("graph view: failed to open file", path, err);
    }
  };

  if (graph && graph.paths.length === 0) {
    return (
      <EmptyState
        style={{ blockSize: "100%", alignItems: "center", justifyContent: "center", fontSize: 13 }}
        message={t("graphView.empty")}
        action={{ label: t("graphView.openWorkspace"), onClick: () => runCommand("view.workspace") }}
      />
    );
  }

  const set = (k: keyof GraphFilter) => (e: { target: { value: string } }) => setFilter((f) => ({ ...f, [k]: e.target.value.trim() || undefined }));
  return (
    <div style={{ inlineSize: "100%", blockSize: "100%", position: "relative", display: "flex", flexDirection: "column" }} data-testid="graph-view">
      <div role="toolbar" aria-label={t("graph.filters")} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "6px 12px", borderBlockEnd: "1px solid hsl(var(--border))", fontSize: 12 }}>
        <span data-testid="graph-stats" style={{ color: "hsl(var(--fg-muted))" }}>
          {t("graphView.stats", { nodes: String(sub?.nodes.length ?? 0), edges: String((sub?.edges.length ?? 0) / 2) })}
          {laying && ` · ${t("graph.layingOut")}`}
        </span>
        <input dir="auto" placeholder={t("graph.filter.tag")} aria-label={t("graph.filter.tag")} onChange={set("tag")} style={field} />
        <input dir="auto" placeholder={t("graph.filter.folder")} aria-label={t("graph.filter.folder")} onChange={set("folder")} style={field} />
        <input dir="auto" placeholder={t("graph.filter.property")} aria-label={t("graph.filter.property")} onChange={set("property")} style={field} />
        <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          {t("graph.groupBy")}
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} style={{ ...field, inlineSize: "auto" }}>
            <option value="folder">{t("graph.groupBy.folder")}</option>
            <option value="tag">{t("graph.groupBy.tag")}</option>
            {/* empty-allow: a "group by: none" option */}
            <option value="none">{t("graph.groupBy.none")}</option>
          </select>
        </label>
        {groups && groupBy !== "none" && (
          <ul aria-label={t("graph.groups")} style={{ display: "flex", flexWrap: "wrap", gap: 8, listStyle: "none", margin: 0, padding: 0 }}>
            {groups.names.map((name, k) => (
              <li key={name} style={{ display: "inline-flex", gap: 4, alignItems: "center" }} dir="auto">
                <span aria-hidden style={{ inlineSize: 8, blockSize: 8, borderRadius: 4, background: groupColor(k) }} />
                {name}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div style={{ flex: 1, minBlockSize: 0, position: "relative" }}>
        {sub && style && (
          <GraphCanvas
            labels={labels}
            edges={sub.edges}
            neighbors={(i) => adjacency[i] ?? []}
            positions={positions}
            colors={style.colors}
            sizes={style.sizes}
            edgeColor={edgeColor}
            ring={ring}
            labelColor={labelColor}
            onOpen={(k) => void open(k)}
            ariaLabel={t("graph.ariaLabel", { nodes: sub.nodes.length })}
            fitKey={`${sub.nodes.length}:${sub.edges.length}:${JSON.stringify(filter)}`}
          />
        )}
      </div>
    </div>
  );
}
