/**
 * The interactive graph surface shared by the full graph and the local graph
 * (plan W1.10): WebGL nodes and links (../../graph/renderer.ts), a 2D label
 * overlay where Hebrew is shaped and drawn right to left, pan and zoom, and a
 * keyboard model — the surface is one focusable "application": arrow keys
 * walk to the linked note in that direction (or the nearest note that way),
 * Enter opens it, + / − zoom, 0 fits, and a search box jumps to any note. The
 * focused note is announced in a live region, so every node is reachable
 * without a mouse.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { stepFrom } from "../../graph/graphModel";
import { PointGrid } from "../../graph/layout";
import { createRenderer, fitView, toScreen, toWorld, type GraphRenderer, type GraphView } from "../../graph/renderer";
import { t } from "../../i18n";

export interface GraphCanvasProps {
  labels: readonly string[];
  edges: Uint32Array;
  neighbors: (i: number) => ArrayLike<number>;
  positions: Float32Array | null;
  colors: Float32Array;
  sizes: Float32Array;
  edgeColor: [number, number, number, number];
  ring: [number, number, number, number];
  labelColor: string;
  /** The node to start the keyboard focus on (the local graph's centre). */
  initialFocus?: number;
  onOpen: (i: number) => void;
  ariaLabel: string;
  /** Small surface (the sidebar): fewer labels, no search box. */
  compact?: boolean;
  /** Re-fit the view when this changes (a new graph, not a layout frame). */
  fitKey: string | number;
}

/** While zooming or panning a graph with more links than this, frames draw a sample of them. */
const MOTION_EDGES = 8000;
const RTL = /[֐-׿؀-ۿݐ-ݿ]/;
const MAX_LABELS = 400;

export function GraphCanvas(props: GraphCanvasProps) {
  const { labels, edges, neighbors, positions, colors, sizes, edgeColor, ring, labelColor, onOpen, ariaLabel, compact, fitKey } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const glCanvas = useRef<HTMLCanvasElement>(null);
  const labelCanvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<GraphRenderer | null>(null);
  const view = useRef<GraphView>({ x: 0, y: 0, scale: 1 });
  const size = useRef({ w: 300, h: 200, dpr: 1 });
  const frame = useRef(0);
  /** Set by a zoom / pan, cleared 200 ms after the last one: frames meanwhile are "in motion". */
  const moving = useRef(0);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [focus, setFocus] = useState<number>(props.initialFocus ?? -1);
  const [hover, setHover] = useState(-1);
  const [query, setQuery] = useState("");
  const n = labels.length;
  const grid = useMemo(() => (positions ? new PointGrid(positions, 24) : null), [positions]);
  const fitted = useRef<string | number | null>(null);

  // One renderer per canvas.
  useEffect(() => {
    if (!glCanvas.current) return;
    renderer.current = createRenderer(glCanvas.current);
    return () => {
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, []);

  const drawLabels = useCallback(() => {
    const c = labelCanvas.current;
    if (!c || !positions) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const { w, h, dpr } = size.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const v = view.current;
    const tl = toWorld(v, w, h, 0, 0);
    const br = toWorld(v, w, h, w, h);
    // Visible nodes, biggest first; plus the focused / hovered note and its neighbours.
    const must = new Set<number>();
    for (const i of [focus, hover]) {
      if (i < 0 || i >= n) continue;
      must.add(i);
      for (const j of Array.from(neighbors(i)).slice(0, 30)) must.add(j);
    }
    const visible: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = positions[2 * i];
      const y = positions[2 * i + 1];
      if (x < tl.x || x > br.x || y < tl.y || y > br.y) continue;
      if (must.has(i) || sizes[i] * v.scale >= (compact ? 3 : 4.5)) visible.push(i);
    }
    visible.sort((a, b) => sizes[b] - sizes[a]);
    const list = [...must, ...visible.filter((i) => !must.has(i)).slice(0, compact ? 60 : MAX_LABELS)];
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = labelColor;
    for (const i of list) {
      const p = toScreen(v, w, h, positions[2 * i], positions[2 * i + 1]);
      const label = labels[i];
      const strong = i === focus || i === hover;
      ctx.font = `${strong ? 600 : 400} ${strong ? 13 : 11}px system-ui, -apple-system, "Segoe UI", "Noto Sans Hebrew", sans-serif`;
      // Hebrew (and Arabic) labels run right to left: the canvas shapes and orders them itself.
      ctx.direction = RTL.test(label) ? "rtl" : "ltr";
      ctx.fillText(label.length > 40 ? `${label.slice(0, 38)}…` : label, p.x, p.y - Math.max(3, sizes[i] * v.scale) - 2);
    }
  }, [positions, labels, sizes, neighbors, focus, hover, n, compact, labelColor]);

  const schedule = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const r = renderer.current;
      if (!r || !positions) return;
      const hl = [focus, hover].filter((i) => i >= 0 && i < n);
      const inMotion = moving.current > 0 && edges.length / 2 > MOTION_EDGES;
      r.draw(view.current, hl.length ? { nodes: hl, ring } : undefined, inMotion ? MOTION_EDGES : undefined);
      drawLabels();
    });
  }, [positions, focus, hover, n, ring, drawLabels, edges]);

  /** A zoom / pan frame: fast (sampled links) now, the full picture once the motion stops. */
  const scheduleMotion = useCallback(() => {
    moving.current = performance.now();
    schedule();
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      moving.current = 0;
      schedule();
    }, 200);
  }, [schedule]);

  // New data → upload; a new graph → fit the view.
  useEffect(() => {
    const r = renderer.current;
    if (!r || !positions) return;
    r.setData({ positions, edges, colors, sizes, edgeColor });
    if (fitted.current !== fitKey) {
      fitted.current = fitKey;
      view.current = fitView(positions, size.current.w, size.current.h);
    }
    schedule();
  }, [positions, edges, colors, sizes, edgeColor, fitKey, schedule]);

  useEffect(() => schedule(), [focus, hover, schedule]);

  // Size the canvases to their box, at device resolution.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const apply = () => {
      const rect = el.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      size.current = { w, h, dpr };
      for (const c of [glCanvas.current, labelCanvas.current]) {
        if (!c) continue;
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      renderer.current?.resize(w, h, dpr);
      schedule();
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const obs = new ResizeObserver(apply);
    obs.observe(el);
    return () => obs.disconnect();
  }, [schedule]);

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      if (settle.current) clearTimeout(settle.current);
    },
    [],
  );

  const zoomAt = (factor: number, sx: number, sy: number) => {
    const { w, h } = size.current;
    const before = toWorld(view.current, w, h, sx, sy);
    const scale = Math.min(40, Math.max(0.005, view.current.scale * factor));
    view.current = { ...view.current, scale };
    const after = toWorld(view.current, w, h, sx, sy);
    view.current = { x: view.current.x + before.x - after.x, y: view.current.y + before.y - after.y, scale };
    scheduleMotion();
  };

  const centreOn = (i: number) => {
    if (!positions || i < 0) return;
    view.current = { x: positions[2 * i], y: positions[2 * i + 1], scale: Math.max(view.current.scale, 1.2) };
    schedule();
  };

  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pick = (sx: number, sy: number) => {
    if (!grid) return -1;
    const { w, h } = size.current;
    const p = toWorld(view.current, w, h, sx, sy);
    return grid.nearest(p.x, p.y, Math.max(6, 10 / view.current.scale));
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!positions || !n) return;
    const dir: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (dir[e.key]) {
      e.preventDefault();
      if (e.shiftKey) {
        // Shift + arrows pan.
        const step = 60 / view.current.scale;
        view.current = { ...view.current, x: view.current.x + dir[e.key][0] * step, y: view.current.y + dir[e.key][1] * step };
        return schedule();
      }
      const from = focus >= 0 ? focus : biggest(sizes);
      const next = focus < 0 ? from : stepFrom(positions, n, from, dir[e.key][0], dir[e.key][1], neighbors(from));
      if (next >= 0) {
        setFocus(next);
        centreOn(next);
      }
    } else if (e.key === "Enter" && focus >= 0) {
      e.preventDefault();
      onOpen(focus);
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomAt(1.25, size.current.w / 2, size.current.h / 2);
    } else if (e.key === "-") {
      e.preventDefault();
      zoomAt(0.8, size.current.w / 2, size.current.h / 2);
    } else if (e.key === "0") {
      e.preventDefault();
      view.current = fitView(positions, size.current.w, size.current.h);
      schedule();
    } else if (e.key === "Home") {
      e.preventDefault();
      const i = props.initialFocus ?? biggest(sizes);
      setFocus(i);
      centreOn(i);
    }
  };

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: number[] = [];
    for (let i = 0; i < n && out.length < 8; i++) if (labels[i].toLowerCase().includes(q)) out.push(i);
    return out;
  }, [query, labels, n]);

  const focusedText = focus >= 0 && focus < n ? t("graph.focused", { name: labels[focus], links: Array.from(neighbors(focus)).length, index: focus + 1, total: n }) : "";

  return (
    <div style={{ position: "relative", inlineSize: "100%", blockSize: "100%" }} data-testid={compact ? "local-graph-canvas" : "graph-canvas"}>
      {!compact && (
        <div style={{ position: "absolute", insetBlockStart: 8, insetInlineEnd: 8, zIndex: 2 }}>
          <input
            type="search"
            dir="auto"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches[0] !== undefined) {
                setFocus(matches[0]);
                centreOn(matches[0]);
                wrap.current?.focus();
              }
            }}
            placeholder={t("graph.search")}
            aria-label={t("graph.search")}
            data-testid="graph-search"
            style={{ fontSize: 12, paddingInline: 6, paddingBlock: 3, borderRadius: 4, border: "1px solid hsl(var(--border))", background: "hsl(var(--bg))", color: "hsl(var(--fg))" }}
          />
          {matches.length > 0 && (
            <ul style={{ listStyle: "none", margin: 0, padding: 4, background: "hsl(var(--bg))", border: "1px solid hsl(var(--border))", borderRadius: 4, fontSize: 12 }}>
              {matches.map((i) => (
                <li key={i}>
                  <button
                    type="button"
                    dir="auto"
                    onClick={() => {
                      setFocus(i);
                      centreOn(i);
                      wrap.current?.focus();
                    }}
                    style={{ all: "unset", cursor: "pointer", display: "block", paddingBlock: 2 }}
                  >
                    {labels[i]}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div
        ref={wrap}
        tabIndex={0}
        role="application"
        aria-roledescription={t("graph.roleDescription")}
        aria-label={ariaLabel}
        aria-describedby={compact ? undefined : "graph-keys"}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (focus < 0 && n) setFocus(props.initialFocus ?? biggest(sizes));
        }}
        onWheel={(e) => {
          e.preventDefault();
          const p = local(e);
          zoomAt(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
        }}
        onPointerDown={(e) => {
          drag.current = { ...local(e), moved: false };
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const p = local(e);
          if (drag.current) {
            const dx = p.x - drag.current.x;
            const dy = p.y - drag.current.y;
            if (Math.abs(dx) + Math.abs(dy) > 2) drag.current.moved = true;
            if (drag.current.moved) {
              view.current = { ...view.current, x: view.current.x - dx / view.current.scale, y: view.current.y - dy / view.current.scale };
              drag.current.x = p.x;
              drag.current.y = p.y;
              scheduleMotion();
            }
            return;
          }
          const i = pick(p.x, p.y);
          if (i !== hover) setHover(i);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) {
            const p = local(e);
            const i = pick(p.x, p.y);
            if (i >= 0) {
              setFocus(i);
              onOpen(i);
            }
          }
        }}
        onPointerLeave={() => setHover(-1)}
        style={{ position: "absolute", inset: 0, outline: "none", cursor: hover >= 0 ? "pointer" : "grab", touchAction: "none" }}
        className="lumen-graph-surface"
        data-focus={focus >= 0 ? focus : undefined}
      >
        <canvas ref={glCanvas} aria-hidden style={{ position: "absolute", inset: 0, inlineSize: "100%", blockSize: "100%" }} />
        <canvas ref={labelCanvas} aria-hidden style={{ position: "absolute", inset: 0, inlineSize: "100%", blockSize: "100%", pointerEvents: "none" }} />
      </div>
      <div role="status" aria-live="polite" data-testid="graph-focused" style={{ position: "absolute", insetBlockEnd: 6, insetInlineStart: 8, fontSize: 11, color: "hsl(var(--fg-muted))", background: "hsl(var(--bg) / 0.8)", paddingInline: 6, borderRadius: 4, pointerEvents: "none" }}>
        {focusedText}
      </div>
      {!compact && (
        <p id="graph-keys" style={{ position: "absolute", insetBlockEnd: 6, insetInlineEnd: 8, margin: 0, fontSize: 10, color: "hsl(var(--fg-muted))", pointerEvents: "none" }}>
          {t("graph.keys")}
        </p>
      )}
    </div>
  );
}

function biggest(sizes: Float32Array): number {
  let best = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;
  return sizes.length ? best : -1;
}
