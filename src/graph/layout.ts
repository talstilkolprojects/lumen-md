/**
 * Force-directed layout for big graphs (plan W1.10): Barnes–Hut repulsion
 * over a quadtree (O(n log n) per step instead of O(n²)), springs along the
 * links, a pull to the centre, and cooling. Typed arrays throughout, so it
 * runs the same in a worker (./layout.worker.ts) and in tests.
 *
 * Deterministic: the same graph gives the same picture (a sunflower spiral
 * to start from, no randomness).
 */

export interface LayoutOptions {
  /** Steps; default by size (fewer for bigger graphs, which start well spread). */
  iterations?: number;
  /** Barnes–Hut accuracy: bigger is faster and coarser. */
  theta?: number;
  /** Called every `every` steps with the positions so far (for a progressive picture). */
  onProgress?: (positions: Float32Array, step: number, steps: number) => void;
  every?: number;
  /** Force constants (tuned for notes; exposed for tests). */
  repulsion?: number;
  spring?: number;
  gravity?: number;
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Starting positions: a sunflower spiral, so no two nodes coincide. */
export function initialPositions(n: number, spacing = 10): Float32Array {
  const p = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    const r = spacing * Math.sqrt(i + 0.5);
    const a = i * GOLDEN;
    p[2 * i] = r * Math.cos(a);
    p[2 * i + 1] = r * Math.sin(a);
  }
  return p;
}

export const defaultIterations = (n: number) => (n > 5000 ? 60 : n > 1000 ? 120 : 250);

/**
 * Lay out `n` nodes joined by `edges` (pairs of indices). Returns the
 * positions (x, y per node), centred on 0, 0.
 */
export function layoutGraph(n: number, edges: Uint32Array, opts: LayoutOptions = {}, start?: Float32Array): Float32Array {
  const pos = start && start.length === 2 * n ? Float32Array.from(start) : initialPositions(n);
  if (n < 2) return pos;
  const steps = opts.iterations ?? defaultIterations(n);
  const theta2 = (opts.theta ?? 1.0) ** 2;
  const every = opts.every ?? 10;
  const degree = new Float32Array(n);
  for (let e = 0; e < edges.length; e++) degree[edges[e]]++;
  const fx = new Float32Array(n);
  const fy = new Float32Array(n);
  // Quadtree in flat arrays: up to 2n + 1 cells for n points.
  const cap = 4 * n + 8;
  const child = new Int32Array(4 * cap);
  const mass = new Float32Array(cap);
  const mx = new Float32Array(cap);
  const my = new Float32Array(cap);
  const half = new Float32Array(cap);
  const ccx = new Float32Array(cap);
  const ccy = new Float32Array(cap);
  /** -1: empty; ≥ 0: a leaf holding that point; -2: an inner cell. */
  const point = new Int32Array(cap);
  const stack = new Int32Array(cap);
  const repulsion = opts.repulsion ?? 5;
  const spring = opts.spring ?? 2;
  const gravity = opts.gravity ?? 0.03;
  let temperature = 40;

  for (let step = 0; step < steps; step++) {
    // Bounds.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos[2 * i];
      const y = pos[2 * i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    // Build the tree.
    let cells = 1;
    const reset = (c: number, x: number, y: number, h: number) => {
      child[4 * c] = child[4 * c + 1] = child[4 * c + 2] = child[4 * c + 3] = -1;
      point[c] = -1;
      mass[c] = 0;
      mx[c] = my[c] = 0;
      ccx[c] = x;
      ccy[c] = y;
      half[c] = h;
    };
    reset(0, (minX + maxX) / 2, (minY + maxY) / 2, Math.max(maxX - minX, maxY - minY) / 2 + 1);
    for (let i = 0; i < n; i++) {
      const x = pos[2 * i];
      const y = pos[2 * i + 1];
      let c = 0;
      for (let depth = 0; ; depth++) {
        mass[c] += 1;
        mx[c] += x;
        my[c] += y;
        if (point[c] === -1 && child[4 * c] === -1 && mass[c] === 1) {
          point[c] = i;
          break;
        }
        if (point[c] >= 0) {
          // Split a leaf: push its point one level down.
          const j = point[c];
          point[c] = -2;
          if (depth > 40 || cells + 4 > cap) break; // coincident points: keep them together
          const q = (pos[2 * j] >= ccx[c] ? 1 : 0) + (pos[2 * j + 1] >= ccy[c] ? 2 : 0);
          const nc = cells++;
          const h = half[c] / 2;
          reset(nc, ccx[c] + (q & 1 ? h : -h), ccy[c] + (q & 2 ? h : -h), h);
          child[4 * c + q] = nc;
          point[nc] = j;
          mass[nc] = 1;
          mx[nc] = pos[2 * j];
          my[nc] = pos[2 * j + 1];
        } else point[c] = -2;
        const q = (x >= ccx[c] ? 1 : 0) + (y >= ccy[c] ? 2 : 0);
        let nc = child[4 * c + q];
        if (nc === -1) {
          if (cells >= cap) break;
          nc = cells++;
          const h = half[c] / 2;
          reset(nc, ccx[c] + (q & 1 ? h : -h), ccy[c] + (q & 2 ? h : -h), h);
          child[4 * c + q] = nc;
        }
        c = nc;
      }
    }
    // Repulsion (Barnes–Hut), plus gravity.
    for (let i = 0; i < n; i++) {
      const x = pos[2 * i];
      const y = pos[2 * i + 1];
      let ax = -x * gravity * (degree[i] + 1);
      let ay = -y * gravity * (degree[i] + 1);
      let sp = 0;
      stack[sp++] = 0;
      while (sp) {
        const c = stack[--sp];
        const m = mass[c];
        if (!m) continue;
        const cx = mx[c] / m;
        const cy = my[c] / m;
        let dx = x - cx;
        let dy = y - cy;
        let d2 = dx * dx + dy * dy;
        const size = 2 * half[c];
        const leaf = point[c] >= 0;
        if (leaf || (size * size) / (d2 || 1e-9) < theta2) {
          if (leaf && point[c] === i) continue;
          if (d2 < 0.01) {
            // Two points on top of each other: nudge by index, deterministically.
            dx = ((i % 7) - 3) * 0.1 + 0.05;
            dy = ((i % 5) - 2) * 0.1 + 0.05;
            d2 = dx * dx + dy * dy;
          }
          const f = (repulsion * m * (degree[i] + 1)) / d2;
          ax += dx * f;
          ay += dy * f;
        } else {
          for (let k = 0; k < 4; k++) {
            const ch = child[4 * c + k];
            if (ch >= 0) stack[sp++] = ch;
          }
        }
      }
      fx[i] = ax;
      fy[i] = ay;
    }
    // Springs along the links.
    for (let e = 0; e < edges.length; e += 2) {
      const a = edges[e];
      const b = edges[e + 1];
      const dx = pos[2 * b] - pos[2 * a];
      const dy = pos[2 * b + 1] - pos[2 * a + 1];
      // Linear springs (as ForceAtlas2): the pull grows with the distance.
      fx[a] += dx * spring;
      fy[a] += dy * spring;
      fx[b] -= dx * spring;
      fy[b] -= dy * spring;
    }
    // Move, capped by the temperature (per node, by its degree).
    for (let i = 0; i < n; i++) {
      const m = degree[i] + 1;
      const vx = fx[i] / m;
      const vy = fy[i] / m;
      const len = Math.sqrt(vx * vx + vy * vy);
      const cap = Math.min(len, temperature);
      if (len > 0) {
        pos[2 * i] += (vx / len) * cap;
        pos[2 * i + 1] += (vy / len) * cap;
      }
    }
    temperature = Math.max(1, temperature * 0.96);
    if (opts.onProgress && (step + 1) % every === 0 && step + 1 < steps) opts.onProgress(pos, step + 1, steps);
  }
  // Centre on 0, 0.
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += pos[2 * i];
    sy += pos[2 * i + 1];
  }
  sx /= n;
  sy /= n;
  for (let i = 0; i < n; i++) {
    pos[2 * i] -= sx;
    pos[2 * i + 1] -= sy;
  }
  return pos;
}

/** A uniform grid over the positions, for "which node is under the pointer". */
export class PointGrid {
  private readonly cells = new Map<number, number[]>();
  constructor(
    private readonly pos: Float32Array,
    private readonly cell = 24,
  ) {
    const n = pos.length / 2;
    for (let i = 0; i < n; i++) {
      const k = this.key(pos[2 * i], pos[2 * i + 1]);
      let list = this.cells.get(k);
      if (!list) this.cells.set(k, (list = []));
      list.push(i);
    }
  }
  private key(x: number, y: number) {
    return Math.floor(x / this.cell) * 1_000_003 + Math.floor(y / this.cell);
  }
  /** The nearest node within `radius` of (x, y), or -1. */
  nearest(x: number, y: number, radius: number): number {
    let best = -1;
    let bestD = radius * radius;
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    for (let gx = cx - r; gx <= cx + r; gx++)
      for (let gy = cy - r; gy <= cy + r; gy++) {
        const list = this.cells.get(gx * 1_000_003 + gy);
        if (!list) continue;
        for (const i of list) {
          const dx = this.pos[2 * i] - x;
          const dy = this.pos[2 * i + 1] - y;
          const d = dx * dx + dy * dy;
          if (d <= bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    return best;
  }
}
