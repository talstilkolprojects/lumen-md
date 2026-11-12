/** Stroke eraser (plan W5.27): which strokes a pass of the eraser touches. */
import type { InkStroke } from "./inkModel";

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Indices of the strokes within `radius` of (x, y). Strokes without samples are never hit. */
export function strokesHit(strokes: readonly InkStroke[], x: number, y: number, radius: number): number[] {
  const out: number[] = [];
  strokes.forEach((s, i) => {
    const reach = radius + s.size / 2;
    const pts = s.points;
    if (!pts.length) return;
    if (pts.length === 1) {
      if (Math.hypot(x - pts[0].x, y - pts[0].y) <= reach) out.push(i);
      return;
    }
    for (let k = 1; k < pts.length; k++) {
      if (segDist(x, y, pts[k - 1].x, pts[k - 1].y, pts[k].x, pts[k].y) <= reach) {
        out.push(i);
        return;
      }
    }
  });
  return out;
}
