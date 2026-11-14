/**
 * The handwriting pad (plan W5.27): draw with a pen / Apple Pencil (with
 * pressure), a finger or a mouse; erase; undo; choose where the ink sits
 * in the note. Lazy: the palette command loads it on first use.
 *
 * Latency: the stroke being drawn is one `<path>` whose `d` is rewritten
 * inside the pointermove handler itself (no React render, no frame wait),
 * from every coalesced sample of the event (`getCoalescedEvents`), so the
 * line follows the pen in the same frame. Finished strokes are React state.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { createRoot } from "react-dom/client";
import "./inkStrings";
import { t } from "../i18n";
import { useFocusTrap } from "../ui/useFocusTrap";
import { cropInk, newInkId, roundPoint, type Ink, type InkDir, type InkPlacement, type InkStroke } from "./inkModel";
import { strokeOutline } from "./inkPath";
import { PalmGate, isEraser } from "./palmGate";
import { strokesHit } from "./eraser";

const SVG_NS = "http://www.w3.org/2000/svg";
const COLORS = [
  { id: "black", value: "#1f2937" },
  { id: "blue", value: "#1d4ed8" },
  { id: "red", value: "#b91c1c" },
  { id: "green", value: "#15803d" },
] as const;
const SIZES = [
  { id: "thin", value: 3 },
  { id: "medium", value: 5 },
  { id: "thick", value: 9 },
] as const;
const ERASER_RADIUS = 10;
const MIN_HEIGHT = 360;

type Tool = "pen" | "eraser";

interface Active {
  mode: "draw" | "erase";
  stroke?: InkStroke;
  path?: SVGPathElement;
  rect: DOMRect;
  /** This erase gesture has removed a stroke already (one gesture = one undo step). */
  erased?: boolean;
}

export interface InkPadProps {
  /** The ink being edited, or null for a new one. */
  initial: Ink | null;
  /** Direction of the text the ink goes into (a new ink only). */
  dir: InkDir;
  onDone: (ink: Ink | null) => void;
}

const button = (pressed: boolean): CSSProperties => ({
  minWidth: 44,
  minHeight: 44,
  padding: "0 10px",
  borderRadius: 8,
  border: `1px solid hsl(var(--border${pressed ? "-strong" : ""}))`,
  background: pressed ? "hsl(var(--bg-subtle))" : "transparent",
  color: "hsl(var(--fg))",
  fontWeight: pressed ? 600 : 400,
  cursor: "pointer",
});

export function InkPad({ initial, dir, onDone }: InkPadProps) {
  const [strokes, setStrokes] = useState<InkStroke[]>(() => initial?.strokes ?? []);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState<string>(COLORS[0].value);
  const [size, setSize] = useState<number>(SIZES[1].value);
  const [placement, setPlacement] = useState<InkPlacement>(initial?.placement ?? "block");
  const [fingerDraws, setFingerDraws] = useState(false);
  const [penSeen, setPenSeen] = useState(false);
  const [width, setWidth] = useState(() => Math.max(initial?.width ?? 0, 320));
  const height = Math.max(MIN_HEIGHT, initial?.height ?? 0);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const liveRef = useRef<SVGGElement | null>(null);
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const undoRef = useRef<InkStroke[][]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const active = useRef(new Map<number, Active>());
  const gate = useRef(new PalmGate());
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const penRef = useRef({ color, size });
  penRef.current = { color, size };

  useFocusTrap(dialogRef, { onEscape: () => onDone(null) });

  // The surface fills the dialog's width (at least the edited ink's).
  useLayoutEffect(() => {
    const w = wrapRef.current?.clientWidth ?? 0;
    if (w > 0) setWidth((cur) => Math.max(cur, Math.floor(w)));
  }, []);

  useEffect(() => {
    gate.current.fingerDraws = fingerDraws;
  }, [fingerDraws]);

  const commit = (next: InkStroke[]) => {
    undoRef.current.push(strokesRef.current);
    if (undoRef.current.length > 100) undoRef.current.shift();
    setUndoCount(undoRef.current.length);
    strokesRef.current = next;
    setStrokes(next);
  };

  const undo = () => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    setUndoCount(undoRef.current.length);
    strokesRef.current = prev;
    setStrokes(prev);
  };

  const undoKey = useRef(undo);
  undoKey.current = undo;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undoKey.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const drop = (id: number) => {
    const a = active.current.get(id);
    a?.path?.remove();
    active.current.delete(id);
  };

  const sample = (a: Active, ev: PointerEvent) => {
    const x = ((ev.clientX - a.rect.left) * width) / (a.rect.width || width);
    const y = ((ev.clientY - a.rect.top) * height) / (a.rect.height || height);
    return roundPoint(x, y, ev.pointerType === "pen" ? ev.pressure || 0.5 : 0.5);
  };

  const eraseAt = (a: Active, x: number, y: number) => {
    const hit = strokesHit(strokesRef.current, x, y, ERASER_RADIUS);
    if (!hit.length) return;
    const next = strokesRef.current.filter((_, i) => !hit.includes(i));
    if (!a.erased) commit(next);
    else {
      strokesRef.current = next;
      setStrokes(next);
    }
    a.erased = true;
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const ev = e.nativeEvent;
    const decision = gate.current.down(ev, ev.timeStamp);
    for (const id of decision.cancel) drop(id);
    if (ev.pointerType === "pen" && !penSeen) setPenSeen(true);
    if (!decision.draw) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(ev.pointerId);
    } catch {
      // why: a synthetic or already-released pointer cannot be captured; drawing still works
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const a: Active = { mode: toolRef.current === "eraser" || isEraser(ev) ? "erase" : "draw", rect };
    const pt = sample(a, ev);
    if (a.mode === "erase") {
      active.current.set(ev.pointerId, a);
      eraseAt(a, pt.x, pt.y);
      return;
    }
    const { color: c, size: s } = penRef.current;
    a.stroke = { points: [pt], size: s, color: c, simulated: ev.pointerType !== "pen" };
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("fill", c);
    path.setAttribute("data-ink-live", "");
    path.setAttribute("d", strokeOutline(a.stroke, false));
    liveRef.current?.appendChild(path);
    a.path = path;
    active.current.set(ev.pointerId, a);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const ev = e.nativeEvent;
    const a = active.current.get(ev.pointerId);
    if (!a) return;
    const coalesced = typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [];
    const events = coalesced.length ? coalesced : [ev];
    if (a.mode === "erase") {
      for (const c of events) {
        const pt = sample(a, c);
        eraseAt(a, pt.x, pt.y);
      }
      return;
    }
    const stroke = a.stroke!;
    for (const c of events) {
      const pt = sample(a, c);
      const last = stroke.points[stroke.points.length - 1];
      if (last && last.x === pt.x && last.y === pt.y) {
        if (pt.p > last.p) last.p = pt.p;
        continue;
      }
      stroke.points.push(pt);
    }
    a.path!.setAttribute("d", strokeOutline(stroke, false));
  };

  const end = (e: ReactPointerEvent<SVGSVGElement>, keep: boolean) => {
    const ev = e.nativeEvent;
    gate.current.up(ev, ev.timeStamp);
    const a = active.current.get(ev.pointerId);
    if (!a) return;
    if (keep && a.mode === "draw" && a.stroke) commit([...strokesRef.current, a.stroke]);
    drop(ev.pointerId);
  };

  const save = () => {
    const done = strokesRef.current;
    if (!initial && !done.length) return onDone(null);
    const ink: Ink = {
      id: initial?.id ?? newInkId(),
      width: initial?.width ?? width,
      height: initial?.height ?? height,
      dir: initial?.dir ?? dir,
      placement,
      label: initial?.label || t("ink.label"),
      strokes: done,
    };
    onDone(done.length ? cropInk(ink) : ink);
  };

  const isEdit = initial !== null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ink-pad-title"
      data-testid="ink-pad"
      style={{
        position: "fixed",
        inset: 0,
        background: "hsl(0 0% 0% / 0.45)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "4vh",
        zIndex: 9999,
      }}
    >
      <div
        ref={dialogRef}
        style={{
          background: "hsl(var(--bg))",
          color: "hsl(var(--fg))",
          border: "1px solid hsl(var(--border-strong))",
          borderRadius: 12,
          boxShadow: "0 24px 60px -8px hsl(0 0% 0% / 0.5)",
          width: "min(960px, calc(100vw - 16px))",
          maxHeight: "92vh",
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div id="ink-pad-title" style={{ fontSize: 15, fontWeight: 600 }}>
          {t("ink.title")}
        </div>
        <div style={{ fontSize: 12, color: "hsl(var(--fg-muted))" }}>{t("ink.hint")}</div>
        <div role="toolbar" aria-label={t("ink.title")} style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <button type="button" aria-pressed={tool === "pen"} style={button(tool === "pen")} onClick={() => setTool("pen")}>
            {t("ink.pen")}
          </button>
          <button type="button" aria-pressed={tool === "eraser"} style={button(tool === "eraser")} onClick={() => setTool("eraser")}>
            {t("ink.eraser")}
          </button>
          {COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={color === c.value}
              aria-label={t(`ink.color.${c.id}`)}
              title={t(`ink.color.${c.id}`)}
              style={{ ...button(color === c.value), minWidth: 44, padding: 0 }}
              onClick={() => {
                setColor(c.value);
                setTool("pen");
              }}
            >
              <span aria-hidden="true" style={{ display: "inline-block", width: 18, height: 18, borderRadius: 9, background: c.value }} />
            </button>
          ))}
          {SIZES.map((s) => (
            <button key={s.id} type="button" aria-pressed={size === s.value} style={button(size === s.value)} onClick={() => setSize(s.value)}>
              {t(`ink.size.${s.id}`)}
            </button>
          ))}
          <button type="button" style={button(false)} disabled={undoCount === 0} onClick={undo}>
            {t("ink.undo")}
          </button>
          <button type="button" style={button(false)} disabled={strokes.length === 0} onClick={() => commit([])}>
            {t("ink.clear")}
          </button>
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            {t("ink.place")}
            <select
              name="ink-place"
              value={placement}
              onChange={(e) => setPlacement(e.target.value === "side" ? "side" : "block")}
              style={{ minHeight: 36 }}
            >
              <option value="block">{t("ink.place.block")}</option>
              <option value="side">{t("ink.place.side")}</option>
            </select>
          </label>
          {penSeen && (
            <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" name="ink-fingers" checked={fingerDraws} onChange={(e) => setFingerDraws(e.target.checked)} />
              {t("ink.fingers")}
            </label>
          )}
        </div>
        <div ref={wrapRef} style={{ overflow: "auto", border: "1px solid hsl(var(--border))", borderRadius: 8, background: "#fff" }}>
          <svg
            ref={svgRef}
            xmlns={SVG_NS}
            role="img"
            aria-label={t("ink.surface")}
            data-testid="ink-surface"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            style={{ display: "block", touchAction: "none", cursor: tool === "eraser" ? "cell" : "crosshair", userSelect: "none" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => end(e, true)}
            onPointerCancel={(e) => end(e, false)}
            onContextMenu={(e) => e.preventDefault()}
          >
            <g>
              {strokes.map((s, i) => (
                <path key={i} fill={s.color} d={s.d ?? strokeOutline(s)} data-ink-stroke={i} />
              ))}
            </g>
            <g ref={liveRef} />
          </svg>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" style={button(false)} onClick={() => onDone(null)}>
            {t("ink.cancel")}
          </button>
          <button type="button" data-autofocus style={button(true)} onClick={save}>
            {isEdit ? t("ink.saveEdit") : t("ink.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Open the pad over the app; resolves with the ink to write, or null (cancelled / nothing drawn). */
export function openInkPad(initial: Ink | null, dir: InkDir): Promise<Ink | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const cleanup = () => {
      try {
        root.unmount();
      } catch {
        // why: double-unmount in StrictMode is harmless
      }
      host.remove();
    };
    root.render(
      <InkPad
        initial={initial}
        dir={dir}
        onDone={(ink) => {
          cleanup();
          resolve(ink);
        }}
      />,
    );
  });
}
