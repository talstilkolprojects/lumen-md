import { useEffect, useMemo, useRef, useState } from "react";
import { listWorkspace, readWorkspaceFile } from "../storage/workspace";
import { log } from "../lib/logger";
import { t } from "../i18n";
import { louvain, communityPalette } from "../views/louvain";

interface Node {
  id: string;
  label: string;
  x: number;
  y: number;
  links: string[];
  /** Louvain community label (0-indexed). */
  community?: number;
}

export function GraphView({ onOpenFile }: { onOpenFile: (path: string, content: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  // Load workspace files and build graph
  useEffect(() => {
    buildGraph();
  }, []);

  async function buildGraph() {
    try {
      const entries = await listWorkspace();
      const mdFiles = entries.filter((e) => e.name.endsWith(".md")).map((e) => e.path);
      const wikiRe = /\[\[([^\]]+)\]\]/g;

      const nodeMap = new Map<string, Node>();

      // Parse all files for wiki-links
      for (const path of mdFiles) {
        const content = await readWorkspaceFile(path);
        const links: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = wikiRe.exec(content)) !== null) {
          links.push(m[1]);
        }
        nodeMap.set(path, {
          id: path,
          label: path.split("/").pop()?.replace(/\.md$/, "") ?? path,
          x: 0,
          y: 0,
          links,
        });
      }

      // Resolve link targets to actual file IDs
      for (const node of nodeMap.values()) {
        node.links = node.links
          .map((link) => {
            // Try exact match
            const exact = mdFiles.find((f) => f === link || f === `${link}.md`);
            if (exact) return exact;
            // Try basename match
            const base = mdFiles.find((f) => {
              const name = f.split("/").pop()?.replace(/\.md$/, "");
              return name === link;
            });
            return base ?? "";
          })
          .filter(Boolean);
      }

      // Force-directed layout (simple)
      const arr = [...nodeMap.values()];
      const cx = dimensions.width / 2;
      const cy = dimensions.height / 2;
      const radius = Math.min(cx, cy) * 0.7;

      arr.forEach((n, i) => {
        const angle = (2 * Math.PI * i) / arr.length;
        n.x = cx + radius * Math.cos(angle);
        n.y = cy + radius * Math.sin(angle);
      });

      // Simple force-directed iterations
      for (let iter = 0; iter < 100; iter++) {
        for (let i = 0; i < arr.length; i++) {
          for (let j = i + 1; j < arr.length; j++) {
            const dx = arr[j].x - arr[i].x;
            const dy = arr[j].y - arr[i].y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const repulsion = 5000 / (dist * dist);
            arr[i].x -= (dx / dist) * repulsion;
            arr[i].y -= (dy / dist) * repulsion;
            arr[j].x += (dx / dist) * repulsion;
            arr[j].y += (dy / dist) * repulsion;
          }
        }

        // Attraction along edges
        for (const node of arr) {
          for (const linkId of node.links) {
            const target = nodeMap.get(linkId);
            if (!target) continue;
            const dx = target.x - node.x;
            const dy = target.y - node.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const attraction = dist * 0.001;
            node.x += dx * attraction;
            node.y += dy * attraction;
            target.x -= dx * attraction;
            target.y -= dy * attraction;
          }
        }

        // Center gravity
        for (const n of arr) {
          n.x += (cx - n.x) * 0.01;
          n.y += (cy - n.y) * 0.01;
        }
      }

      // Louvain community detection — colour related notes together so the
      // graph shows topic clusters at a glance.
      try {
        const edges: { source: string; target: string }[] = [];
        for (const n of arr) {
          for (const link of n.links) edges.push({ source: n.id, target: link });
        }
        const { communities } = louvain({ nodes: arr.map((n) => n.id), edges });
        for (const n of arr) n.community = communities.get(n.id) ?? 0;
      } catch (err) {
        log.warn("louvain clustering failed", err);
      }

      setNodes(arr);
    } catch {
      // Workspace unavailable
      setNodes([]);
    }
  }

  // Per-community colour palette derived once whenever the cluster set
  // changes. Falls back to the accent when no community data is set.
  const palette = useMemo(() => {
    const max = nodes.reduce((m, n) => Math.max(m, n.community ?? 0), 0);
    return communityPalette(max + 1);
  }, [nodes]);

  // Draw canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || nodes.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const isDark = document.documentElement.classList.contains("dark");
    const bg = isDark ? "#1a1b26" : "#ffffff";
    const fg = isDark ? "#c0caf5" : "#333333";
    const accent = "#7c5cff";
    const edge = isDark ? "rgba(192,202,245,0.15)" : "rgba(50,50,50,0.15)";

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw edges — same-cluster edges are drawn in the community colour at
    // 35% alpha so clusters visually "cohere" while cross-cluster links
    // stay subtle.
    for (const node of nodes) {
      for (const linkId of node.links) {
        const target = nodes.find((n) => n.id === linkId);
        if (!target) continue;
        const sameCluster =
          node.community !== undefined && node.community === target.community;
        ctx.strokeStyle = sameCluster
          ? palette[node.community ?? 0]
              .replace("hsl(", "hsla(")
              .replace(")", " / 0.35)")
          : edge;
        ctx.lineWidth = sameCluster ? 1.4 : 1;
        ctx.beginPath();
        ctx.moveTo(node.x, node.y);
        ctx.lineTo(target.x, target.y);
        ctx.stroke();
      }
    }

    // Draw nodes — fill colour comes from the community palette so the
    // graph is readable as a topic map at a glance.
    for (const node of nodes) {
      const isHovered = hoveredNode === node.id;
      const r = isHovered ? 8 : Math.min(10, 4 + node.links.length * 0.6);
      const colour =
        node.community !== undefined
          ? palette[node.community]
          : node.links.length > 0
            ? accent
            : fg;

      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();

      // Label
      ctx.font = `${isHovered ? 12 : 10}px -apple-system, sans-serif`;
      ctx.fillStyle = fg;
      ctx.textAlign = "center";
      ctx.fillText(node.label, node.x, node.y - r - 4);
    }
  }, [nodes, hoveredNode, palette]);

  // The node under a screen point. A finger is wider than a cursor (plan
  // 10.2.1): touch and pen hit within 22 px, the mouse within 10 px.
  function nodeAt(clientX: number, clientY: number, coarse: boolean): string | null {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const r2 = coarse ? 22 * 22 : 100;
    const found = nodes.find((n) => {
      const dx = n.x - x;
      const dy = n.y - y;
      return dx * dx + dy * dy < r2;
    });
    return found?.id ?? null;
  }

  // Hover detection (mouse); a touch has no hover, so pointerdown sets it too.
  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.pointerType !== "mouse") return;
    setHoveredNode(nodeAt(e.clientX, e.clientY, false));
  }
  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    setHoveredNode(nodeAt(e.clientX, e.clientY, e.pointerType !== "mouse"));
  }

  // Click (or tap) to open file: the node at the click point, not only the
  // last hovered one — on touch nothing was hovered before the tap.
  async function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const coarse = (e.nativeEvent as PointerEvent).pointerType ? (e.nativeEvent as PointerEvent).pointerType !== "mouse" : false;
    const id = nodeAt(e.clientX, e.clientY, coarse) ?? hoveredNode;
    if (!id) return;
    try {
      const content = await readWorkspaceFile(id);
      onOpenFile(id, content);
    } catch (err) {
      log.warn("graph view: failed to open file", id, err);
    }
  }

  useEffect(() => {
    const el = canvasRef.current?.parentElement;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      {nodes.length === 0 ? (
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "hsl(var(--fg-muted))",
          fontSize: 13,
        }}>
          {t("graphView.empty")}
        </div>
      ) : (
        <canvas
          ref={canvasRef}
          width={dimensions.width}
          height={dimensions.height}
          style={{ cursor: hoveredNode ? "pointer" : "default" }}
          data-testid="graph-canvas"
          onPointerMove={handlePointerMove}
          onPointerDown={handlePointerDown}
          onClick={handleClick}
        />
      )}
      <div style={{
        position: "absolute",
        top: 12,
        insetInlineStart: 12,
        fontSize: 11,
        color: "hsl(var(--fg-muted))",
        background: "hsl(var(--bg) / 0.8)",
        padding: "4px 8px",
        borderRadius: 6,
      }}>
        {t("graphView.stats", { nodes: String(nodes.length), edges: String(nodes.reduce((s, n) => s + n.links.length, 0)) })}
      </div>
    </div>
  );
}
