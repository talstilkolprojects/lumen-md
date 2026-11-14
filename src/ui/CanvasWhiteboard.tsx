import { useCallback, useEffect, useRef, useState } from "react";
import {
  autoSaveCanvas,
  flushCanvas,
  listCanvases,
  loadCanvas,
  type CanvasNode,
  type CanvasEdge,
} from "./canvasStorage";
import { uiPrompt } from "./PromptDialog";
import { randomId } from "../lib/cryptoRandom";
import { t } from "../i18n";

/**
 * Canvas / Whiteboard mode — an infinite canvas for visual note-taking.
 *
 * Each canvas is persisted to OPFS at `canvases/<name>.canvas.json` and
 * auto-saved 250ms after the user stops dragging / typing. The toolbar
 * surfaces the current canvas name and lets the user pick / rename / new.
 *
 * Supports:
 * - Drag to create sticky notes with markdown content
 * - Pan and zoom the canvas
 * - Connect notes with arrows
 * - Color picker for notes
 * - Persistent canvases via OPFS
 */

interface Props {
  open: boolean;
  onClose: () => void;
}

const COLORS = [
  "#7c5cfc", "#22c55e", "#f97316", "#ef4444", "#3b82f6",
  "#eab308", "#ec4899", "#14b8a6", "#8b5cf6",
];

const DEFAULT_CANVAS_NAME = "untitled";

const SEED_NODES: CanvasNode[] = [
  { id: "1", x: 200, y: 200, width: 200, height: 120, content: "# Welcome\n\nDrag to move notes.", color: "#7c5cfc" },
  { id: "2", x: 500, y: 150, width: 200, height: 120, content: "## Ideas\n\n- Note 1\n- Note 2", color: "#22c55e" },
  { id: "3", x: 350, y: 400, width: 200, height: 120, content: "Click **+ Add** to create more notes", color: "#f97316" },
];
const SEED_EDGES: CanvasEdge[] = [
  { from: "1", to: "2" },
  { from: "1", to: "3" },
];

export function CanvasWhiteboard({ open, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasName, setCanvasName] = useState<string>(DEFAULT_CANVAS_NAME);
  const [savedList, setSavedList] = useState<string[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [nodes, setNodes] = useState<CanvasNode[]>(SEED_NODES);
  const [edges, setEdges] = useState<CanvasEdge[]>(SEED_EDGES);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [selectedColor, setSelectedColor] = useState(COLORS[0]);
  const [editingId, setEditingId] = useState<string | null>(null);

  // On open: refresh the canvas list and load whichever was active last.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const list = await listCanvases();
      if (cancelled) return;
      setSavedList(list);
      const last = localStorage.getItem("lumen.canvas.last") || DEFAULT_CANVAS_NAME;
      const target = list.includes(last) ? last : list[0] ?? DEFAULT_CANVAS_NAME;
      setCanvasName(target);
      const doc = await loadCanvas(target);
      if (cancelled) return;
      if (doc) {
        setNodes(doc.nodes);
        setEdges(doc.edges);
        setPan(doc.viewport.pan);
        setZoom(doc.viewport.zoom);
      } else {
        setNodes(SEED_NODES);
        setEdges(SEED_EDGES);
        setPan({ x: 0, y: 0 });
        setZoom(1);
      }
      setHasLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Auto-save after every meaningful change (debounced inside the helper).
  // We skip the very first render after load so we don't write the seed
  // doc back to a freshly-loaded canvas.
  useEffect(() => {
    if (!open || !hasLoaded) return;
    autoSaveCanvas(canvasName, { nodes, edges, viewport: { pan, zoom } });
    localStorage.setItem("lumen.canvas.last", canvasName);
  }, [open, hasLoaded, canvasName, nodes, edges, pan, zoom]);

  // Flush on close so a quick edit-then-close doesn't lose the last 250ms.
  useEffect(() => {
    if (open) return;
    void flushCanvas();
  }, [open]);

  async function switchCanvas(name: string) {
    await flushCanvas(canvasName);
    const doc = await loadCanvas(name);
    setCanvasName(name);
    setNodes(doc?.nodes ?? SEED_NODES);
    setEdges(doc?.edges ?? SEED_EDGES);
    setPan(doc?.viewport.pan ?? { x: 0, y: 0 });
    setZoom(doc?.viewport.zoom ?? 1);
    setSavedList(await listCanvases());
  }

  async function newCanvas() {
    const name = await uiPrompt({ message: t("canvas.new.prompt"), placeholder: t("canvas.new.placeholder") });
    if (!name?.trim()) return;
    await flushCanvas(canvasName);
    setCanvasName(name.trim());
    setNodes([]);
    setEdges([]);
    setPan({ x: 0, y: 0 });
    setZoom(1);
    // Force a save so it shows up in the list.
    await autoSaveCanvas(name.trim(), { nodes: [], edges: [], viewport: { pan: { x: 0, y: 0 }, zoom: 1 } }, 0);
    setSavedList(await listCanvases());
  }

  // Draw canvas
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = canvas.offsetWidth * 2;
    canvas.height = canvas.offsetHeight * 2;
    ctx.scale(2, 2);

    // Clear
    ctx.fillStyle = "#0d0d18";
    ctx.fillRect(0, 0, canvas.offsetWidth, canvas.offsetHeight);

    // Grid dots
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    const gridSize = 40 * zoom;
    const offsetX = pan.x % gridSize;
    const offsetY = pan.y % gridSize;
    for (let x = offsetX; x < canvas.offsetWidth; x += gridSize) {
      for (let y = offsetY; y < canvas.offsetHeight; y += gridSize) {
        ctx.beginPath();
        ctx.arc(x, y, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Draw edges
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1.5;
    for (const edge of edges) {
      const from = nodes.find((n) => n.id === edge.from);
      const to = nodes.find((n) => n.id === edge.to);
      if (!from || !to) continue;
      const fx = (from.x + from.width / 2) * zoom + pan.x;
      const fy = (from.y + from.height / 2) * zoom + pan.y;
      const tx = (to.x + to.width / 2) * zoom + pan.x;
      const ty = (to.y + to.height / 2) * zoom + pan.y;
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(tx, ty);
      ctx.stroke();

      // Arrow head
      const angle = Math.atan2(ty - fy, tx - fx);
      const headLen = 10;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - headLen * Math.cos(angle - 0.5), ty - headLen * Math.sin(angle - 0.5));
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - headLen * Math.cos(angle + 0.5), ty - headLen * Math.sin(angle + 0.5));
      ctx.stroke();
    }

    // Draw nodes
    for (const node of nodes) {
      const nx = node.x * zoom + pan.x;
      const ny = node.y * zoom + pan.y;
      const nw = node.width * zoom;
      const nh = node.height * zoom;

      // Shadow
      ctx.shadowColor = node.color + "40";
      ctx.shadowBlur = 16;
      ctx.shadowOffsetY = 4;

      // Card background
      ctx.fillStyle = "#1a1a2e";
      ctx.beginPath();
      ctx.roundRect(nx, ny, nw, nh, 8);
      ctx.fill();

      // Reset shadow
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      // Color accent bar
      ctx.fillStyle = node.color;
      ctx.beginPath();
      ctx.roundRect(nx, ny, nw, 3, [8, 8, 0, 0]);
      ctx.fill();

      // Text
      ctx.fillStyle = "#e8e8f0";
      ctx.font = `${11 * zoom}px Inter, sans-serif`;
      const lines = node.content.split("\n");
      let textY = ny + 20 * zoom;
      for (const line of lines) {
        const clean = line.replace(/[#*_~`]/g, "").trim();
        if (!clean) { textY += 14 * zoom; continue; }
        if (line.startsWith("#")) {
          ctx.font = `bold ${13 * zoom}px Inter, sans-serif`;
        } else {
          ctx.font = `${11 * zoom}px Inter, sans-serif`;
        }
        ctx.fillText(clean, nx + 12 * zoom, textY, nw - 24 * zoom);
        textY += 16 * zoom;
      }
    }
  }, [nodes, edges, pan, zoom]);

  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [open, draw]);

  // Redraw on any state change
  useEffect(() => { draw(); }, [draw]);

  const addNode = () => {
    const id = randomId(6);
    setNodes([...nodes, {
      id,
      x: (-pan.x + 300) / zoom,
      y: (-pan.y + 300) / zoom,
      width: 200,
      height: 120,
      content: "# New Note\n\nType here...",
      color: selectedColor,
    }]);
  };

  if (!open) return null;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 200,
      background: "#0d0d18",
      display: "flex", flexDirection: "column",
    }}>
      {/* Toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "8px 16px",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        background: "#12121e",
      }}>
        <button
          onClick={async () => {
            await flushCanvas();
            onClose();
          }}
          style={{
            background: "none", border: "1px solid rgba(255,255,255,0.1)",
            color: "#e8e8f0", borderRadius: 6, padding: "4px 12px",
            cursor: "pointer", fontSize: 12,
          }}
        >
          {t("canvas.back")}
        </button>
        <select
          value={canvasName}
          onChange={(e) => void switchCanvas(e.target.value)}
          aria-label={t("canvas.switch")}
          style={{
            background: "#12121e",
            color: "#e8e8f0",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          {!savedList.includes(canvasName) && (
            <option value={canvasName}>{t("canvas.unsaved", { name: canvasName })}</option>
          )}
          {savedList.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button
          onClick={() => void newCanvas()}
          style={{
            background: "none",
            border: "1px solid rgba(255,255,255,0.1)",
            color: "#e8e8f0",
            borderRadius: 6,
            padding: "4px 10px",
            cursor: "pointer",
            fontSize: 12,
          }}
          title={t("canvas.new.title")}
        >
          + {t("canvas.new")}
        </button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: "#8888a8" }}>{t("canvas.autoSaved")}</span>
        <div style={{ display: "flex", gap: 4 }}>
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setSelectedColor(c)}
              style={{
                width: 18, height: 18, borderRadius: 4,
                background: c, border: selectedColor === c ? "2px solid white" : "2px solid transparent",
                cursor: "pointer",
              }}
            />
          ))}
        </div>
        <button
          onClick={addNode}
          style={{
            background: "linear-gradient(135deg, #7c5cfc, #c084fc)",
            color: "white", border: "none", borderRadius: 6,
            padding: "6px 16px", cursor: "pointer", fontSize: 12,
            fontWeight: 600,
          }}
        >
          {t("canvas.addNote")}
        </button>
        <span style={{ fontSize: 11, color: "#8888a8" }}>
          {t("canvas.zoom", { pct: Math.round(zoom * 100) })}
        </span>
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        style={{ flex: 1, cursor: dragging ? "grabbing" : "grab" }}
        onWheel={(e) => {
          e.preventDefault();
          const delta = e.deltaY > 0 ? 0.95 : 1.05;
          setZoom((z) => Math.max(0.3, Math.min(3, z * delta)));
        }}
        onMouseDown={(e) => {
          const rect = canvasRef.current!.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;

          // Check if clicking on a node
          for (const node of [...nodes].reverse()) {
            const nx = node.x * zoom + pan.x;
            const ny = node.y * zoom + pan.y;
            const nw = node.width * zoom;
            const nh = node.height * zoom;
            if (mx >= nx && mx <= nx + nw && my >= ny && my <= ny + nh) {
              setDragging(node.id);
              setDragOffset({ x: mx - nx, y: my - ny });
              return;
            }
          }
          // Pan the canvas
          setDragging("__pan__");
          setDragOffset({ x: mx - pan.x, y: my - pan.y });
        }}
        onMouseMove={(e) => {
          if (!dragging) return;
          const rect = canvasRef.current!.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;

          if (dragging === "__pan__") {
            setPan({ x: mx - dragOffset.x, y: my - dragOffset.y });
          } else {
            setNodes((prev) =>
              prev.map((n) =>
                n.id === dragging
                  ? { ...n, x: (mx - dragOffset.x - pan.x) / zoom, y: (my - dragOffset.y - pan.y) / zoom }
                  : n,
              ),
            );
          }
        }}
        onMouseUp={() => setDragging(null)}
        onDoubleClick={(e) => {
          const rect = canvasRef.current!.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          for (const node of [...nodes].reverse()) {
            const nx = node.x * zoom + pan.x;
            const ny = node.y * zoom + pan.y;
            const nw = node.width * zoom;
            const nh = node.height * zoom;
            if (mx >= nx && mx <= nx + nw && my >= ny && my <= ny + nh) {
              setEditingId(node.id);
              return;
            }
          }
        }}
      />

      {/* Edit overlay */}
      {editingId && (() => {
        const node = nodes.find((n) => n.id === editingId);
        if (!node) return null;
        return (
          <div style={{
            position: "fixed", inset: 0, zIndex: 300,
            background: "rgba(0,0,0,0.7)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }} onClick={() => setEditingId(null)}>
            <div onClick={(e) => e.stopPropagation()} style={{
              background: "#1a1a2e",
              border: `2px solid ${node.color}`,
              borderRadius: 12, padding: 20,
              width: 400, maxHeight: "80vh",
            }}>
              <textarea
                autoFocus
                value={node.content}
                onChange={(e) => {
                  const val = e.target.value;
                  setNodes((prev) => prev.map((n) => n.id === editingId ? { ...n, content: val } : n));
                }}
                style={{
                  width: "100%", minHeight: 200,
                  background: "transparent", color: "#e8e8f0",
                  border: "none", outline: "none", resize: "vertical",
                  fontFamily: "JetBrains Mono, monospace", fontSize: 13,
                  lineHeight: 1.6,
                }}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button
                  onClick={() => setEditingId(null)}
                  style={{
                    background: node.color, color: "white", border: "none",
                    borderRadius: 6, padding: "6px 16px", cursor: "pointer",
                    fontSize: 12, fontWeight: 600,
                  }}
                >
                  {t("canvas.done")}
                </button>
                <button
                  onClick={() => {
                    setNodes((prev) => prev.filter((n) => n.id !== editingId));
                    setEdges((prev) => prev.filter((e) => e.from !== editingId && e.to !== editingId));
                    setEditingId(null);
                  }}
                  style={{
                    background: "#ef4444", color: "white", border: "none",
                    borderRadius: 6, padding: "6px 16px", cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
