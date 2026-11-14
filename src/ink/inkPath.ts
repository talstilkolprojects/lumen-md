/**
 * A stroke's outline as an SVG path (plan W5.27), from perfect-freehand
 * (MIT): the samples' pressure widens and thins the line.
 */
import { getStroke, type StrokeOptions } from "perfect-freehand";
import type { InkPoint } from "./inkModel";

interface StrokeLike {
  points: InkPoint[];
  size: number;
  simulated: boolean;
}

export function strokeOptions(s: Pick<StrokeLike, "size" | "simulated">, last = true): StrokeOptions {
  return {
    size: s.size,
    thinning: s.simulated ? 0.5 : 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: s.simulated,
    last,
  };
}

function n(v: number): string {
  const s = v.toFixed(1).replace(/\.0$/, "");
  return s === "-0" ? "0" : s;
}

/** A filled polygon (outline points) as a quadratic-smoothed path (perfect-freehand's README recipe). */
export function outlineToPath(outline: number[][]): string {
  const len = outline.length;
  if (len < 4) return "";
  let a = outline[0];
  let b = outline[1];
  const c = outline[2];
  let d = `M${n(a[0])},${n(a[1])} Q${n(b[0])},${n(b[1])} ${n((b[0] + c[0]) / 2)},${n((b[1] + c[1]) / 2)} T`;
  for (let i = 2; i < len - 1; i++) {
    a = outline[i];
    b = outline[i + 1];
    d += `${n((a[0] + b[0]) / 2)},${n((a[1] + b[1]) / 2)} `;
  }
  return d + "Z";
}

/** A dot, for a tap too short to have an outline. */
function dot(p: InkPoint, size: number): string {
  const r = Math.max(0.5, (size * (0.5 + p.p * 0.5)) / 2);
  return `M${n(p.x - r)},${n(p.y)} a${n(r)},${n(r)} 0 1,0 ${n(2 * r)},0 a${n(r)},${n(r)} 0 1,0 ${n(-2 * r)},0Z`;
}

/** The SVG `d` of a stroke. `last` = the stroke is finished (its end is capped). */
export function strokeOutline(s: StrokeLike, last = true): string {
  if (!s.points.length) return "";
  const outline = getStroke(
    s.points.map((p) => [p.x, p.y, p.p]),
    strokeOptions(s, last),
  );
  return outlineToPath(outline) || dot(s.points[0], s.size);
}
