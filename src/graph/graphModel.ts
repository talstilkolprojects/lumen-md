/**
 * The knowledge graph as typed arrays (plan W1.10): built once from the vault
 * index, sized for 10,000 notes and 50,000 links. Nodes are indices; edges
 * are undirected pairs; neighbours are in CSR form (offsets + list), so a
 * local graph of depth 1–3 is a BFS over arrays, not over objects.
 *
 * Pure: no DOM, no storage — the view feeds it the indexed notes.
 */

export interface GraphNoteInput {
  path: string;
  /** Raw `[[target]]` texts (the vault index's wikiTargets). */
  wikiTargets: readonly string[];
  /** The note's text, for tags and frontmatter properties (optional). */
  content?: string;
  /** Tags and properties read already (`noteMeta`), instead of the text. */
  meta?: { tags: string[]; props: Record<string, string> };
}

export interface GraphData {
  /** Node i: its path, label (basename), folder, tags and frontmatter scalars. */
  paths: string[];
  labels: string[];
  folders: string[];
  tags: string[][];
  props: Array<Record<string, string>>;
  /** Undirected edges, two node indices each, no duplicates or self-links. */
  edges: Uint32Array;
  /** CSR adjacency: the neighbours of i are `neighbors[offsets[i] .. offsets[i + 1])`. */
  offsets: Uint32Array;
  neighbors: Uint32Array;
  /** Index of a path. */
  indexOf: Map<string, number>;
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1).replace(/\.(md|markdown)$/i, "");
const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

const FM = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/;

/** Tags (frontmatter `tags:` and inline `#tags`) and scalar frontmatter values of a note — a light read, not a YAML parser. */
export function noteMeta(content: string | undefined): { tags: string[]; props: Record<string, string> } {
  const tags = new Set<string>();
  const props: Record<string, string> = {};
  if (!content) return { tags: [], props };
  const m = FM.exec(content);
  let body = content;
  if (m) {
    body = content.slice(m[0].length);
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const kv = /^([\p{L}\p{N}_-]+):\s*(.*)$/u.exec(lines[i]);
      if (!kv) continue;
      const [, key, rawValue] = kv;
      const value = rawValue.trim();
      if (key === "tags" || key === "tag") {
        if (value.startsWith("[")) for (const t of value.slice(1, -1).split(",")) addTag(tags, t);
        else if (value) for (const t of value.split(/[,\s]+/)) addTag(tags, t);
        else for (let j = i + 1; j < lines.length && /^\s*-\s+/.test(lines[j]); j++) addTag(tags, lines[j].replace(/^\s*-\s+/, ""));
      } else if (value && !value.startsWith("[") && !value.startsWith("{")) props[key] = value.replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  const prose = body.replace(/^(```|~~~)[\s\S]*?^\1/gm, "").replace(/`[^`\n]*`/g, "");
  for (const t of prose.matchAll(/(^|[^\w&/])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)) tags.add(t[2]);
  return { tags: [...tags], props };
}

function addTag(set: Set<string>, raw: string) {
  const t = raw.trim().replace(/^["']|["']$/g, "").replace(/^#/, "");
  if (t) set.add(t);
}

/** Build the graph. Links resolve by path, path without `.md`, or note name (shortest path first), as Obsidian does. */
export function buildGraph(notes: readonly GraphNoteInput[]): GraphData {
  const sorted = notes.map((n, i) => ({ n, i })).sort((a, b) => a.n.path.split("/").length - b.n.path.split("/").length || (a.n.path < b.n.path ? -1 : 1));
  const byKey = new Map<string, number>();
  for (const { n, i } of sorted) {
    const p = n.path.toLowerCase();
    if (!byKey.has(p)) byKey.set(p, i);
    const noExt = p.replace(/\.(md|markdown)$/, "");
    if (!byKey.has(noExt)) byKey.set(noExt, i);
    const name = basename(p);
    if (!byKey.has(name)) byKey.set(name, i);
  }
  const resolve = (target: string): number | undefined => {
    const t = target.split("|")[0].split("#")[0].trim().replace(/^\/+/, "").toLowerCase();
    if (!t) return undefined;
    return byKey.get(t) ?? byKey.get(t.replace(/\.(md|markdown)$/, "")) ?? byKey.get(basename(t));
  };
  const n = notes.length;
  const seen = new Set<number>();
  const pairs: number[] = [];
  const degree = new Uint32Array(n);
  notes.forEach((note, a) => {
    for (const target of note.wikiTargets) {
      const b = resolve(target);
      if (b === undefined || b === a) continue;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = lo * n + hi;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push(lo, hi);
      degree[lo]++;
      degree[hi]++;
    }
  });
  const edges = Uint32Array.from(pairs);
  const offsets = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + degree[i];
  const fill = offsets.slice(0, n);
  const neighbors = new Uint32Array(offsets[n]);
  for (let e = 0; e < edges.length; e += 2) {
    neighbors[fill[edges[e]]++] = edges[e + 1];
    neighbors[fill[edges[e + 1]]++] = edges[e];
  }
  const metas = notes.map((x) => x.meta ?? noteMeta(x.content));
  return {
    paths: notes.map((x) => x.path),
    labels: notes.map((x) => basename(x.path)),
    folders: notes.map((x) => folderOf(x.path)),
    tags: metas.map((m) => m.tags),
    props: metas.map((m) => m.props),
    edges,
    offsets,
    neighbors,
    indexOf: new Map(notes.map((x, i) => [x.path, i])),
  };
}

export const degreeOf = (g: GraphData, i: number) => g.offsets[i + 1] - g.offsets[i];
export const neighborsOf = (g: GraphData, i: number) => g.neighbors.subarray(g.offsets[i], g.offsets[i + 1]);

/* ─── Filters and groups ─────────────────────────────────────────────── */

export interface GraphFilter {
  /** Keep notes with this tag (or a nested tag under it). */
  tag?: string;
  /** Keep notes in this folder (or below it). */
  folder?: string;
  /** Keep notes whose frontmatter `key` equals `value` (`status=open`), or has `key` at all. */
  property?: string;
}

/** Whether node i passes the filter. */
export function passes(g: GraphData, i: number, f: GraphFilter): boolean {
  if (f.tag) {
    const want = f.tag.replace(/^#/, "").toLowerCase();
    if (!g.tags[i].some((t) => t.toLowerCase() === want || t.toLowerCase().startsWith(`${want}/`))) return false;
  }
  if (f.folder) {
    const want = f.folder.replace(/^\/+|\/+$/g, "").toLowerCase();
    const folder = g.folders[i].toLowerCase();
    if (want && folder !== want && !folder.startsWith(`${want}/`)) return false;
  }
  if (f.property) {
    const [key, ...rest] = f.property.split("=");
    const value = rest.join("=").trim();
    const have = g.props[i][key.trim()];
    if (have === undefined || (value && have.toLowerCase() !== value.toLowerCase())) return false;
  }
  return true;
}

export type GroupBy = "folder" | "tag" | "none";

/** A colour group per node (index into a palette; -1 = none), by top folder or first tag, largest groups first. */
export function groupsOf(g: GraphData, by: GroupBy, max = 12): { group: Int16Array; names: string[] } {
  const n = g.paths.length;
  const group = new Int16Array(n).fill(-1);
  if (by === "none") return { group, names: [] };
  const keyOf = (i: number) => (by === "folder" ? g.folders[i].split("/")[0] : (g.tags[i][0] ?? "").split("/")[0]);
  const counts = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = keyOf(i);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const names = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, max).map(([k]) => k);
  const idx = new Map(names.map((k, i) => [k, i]));
  for (let i = 0; i < n; i++) group[i] = idx.get(keyOf(i)) ?? -1;
  return { group, names };
}

/* ─── Local graph ────────────────────────────────────────────────────── */

export interface Subgraph {
  /** Node indices of the full graph, the centre first; `depth` of each. */
  nodes: Uint32Array;
  depth: Uint8Array;
  /** Edges between them, as pairs of positions in `nodes`. */
  edges: Uint32Array;
}

/** The notes within `depth` links (1–3) of `center` that pass `filter` (the centre always stays). */
export function localGraph(g: GraphData, center: number, depth: number, filter: GraphFilter = {}, maxNodes = 2000): Subgraph {
  const d = Math.max(1, Math.min(3, Math.floor(depth)));
  const pos = new Map<number, number>([[center, 0]]);
  const order: number[] = [center];
  const depths: number[] = [0];
  let frontier = [center];
  for (let level = 1; level <= d && order.length < maxNodes; level++) {
    const next: number[] = [];
    for (const u of frontier) {
      for (const v of neighborsOf(g, u)) {
        if (pos.has(v) || !passes(g, v, filter)) continue;
        pos.set(v, order.length);
        order.push(v);
        depths.push(level);
        next.push(v);
        if (order.length >= maxNodes) break;
      }
      if (order.length >= maxNodes) break;
    }
    frontier = next;
  }
  const edges: number[] = [];
  for (let a = 0; a < order.length; a++) {
    for (const v of neighborsOf(g, order[a])) {
      const b = pos.get(v);
      if (b !== undefined && b > a) edges.push(a, b);
    }
  }
  return { nodes: Uint32Array.from(order), depth: Uint8Array.from(depths), edges: Uint32Array.from(edges) };
}

/** The whole graph narrowed by a filter, as a subgraph (every node when the filter is empty). */
export function filteredGraph(g: GraphData, filter: GraphFilter): Subgraph {
  const n = g.paths.length;
  const pos = new Int32Array(n).fill(-1);
  const order: number[] = [];
  for (let i = 0; i < n; i++) if (passes(g, i, filter)) pos[i] = order.push(i) - 1;
  const edges: number[] = [];
  for (let e = 0; e < g.edges.length; e += 2) {
    const a = pos[g.edges[e]];
    const b = pos[g.edges[e + 1]];
    if (a >= 0 && b >= 0) edges.push(a, b);
  }
  return { nodes: Uint32Array.from(order), depth: new Uint8Array(order.length), edges: Uint32Array.from(edges) };
}

/* ─── Keyboard navigation ────────────────────────────────────────────── */

/**
 * The node to move to from `from` with an arrow key: among its neighbours,
 * the one closest to the direction (dx, dy); with no neighbour that way, the
 * nearest node that way at all. -1 when there is none.
 */
export function stepFrom(positions: Float32Array, count: number, from: number, dx: number, dy: number, neighbors?: ArrayLike<number>): number {
  const x0 = positions[2 * from];
  const y0 = positions[2 * from + 1];
  const best = (candidates: Iterable<number>) => {
    let pick = -1;
    let score = Infinity;
    for (const j of candidates) {
      if (j === from) continue;
      const vx = positions[2 * j] - x0;
      const vy = positions[2 * j + 1] - y0;
      const dist = Math.hypot(vx, vy) || 1e-9;
      const cos = (vx * dx + vy * dy) / dist;
      if (cos < 0.5) continue; // within ±60° of the arrow
      const s = dist * (2 - cos);
      if (s < score) {
        score = s;
        pick = j;
      }
    }
    return pick;
  };
  const viaLink = neighbors ? best(Array.from(neighbors)) : -1;
  if (viaLink >= 0) return viaLink;
  return best({ [Symbol.iterator]: function* () { for (let j = 0; j < count; j++) yield j; } });
}
