/**
 * Louvain community detection — small, dependency-free implementation
 * for clustering the knowledge graph (P3-05).
 *
 * Louvain greedily assigns each node to the community whose join would
 * maximise the network's modularity (a measure of how dense each
 * cluster's internal edges are vs. random). After the first pass the
 * algorithm collapses each community into a super-node and repeats,
 * producing a hierarchical decomposition. We only run a single pass
 * here — knowledge graphs in Lumen are typically <500 nodes, and the
 * one-level result already produces useful "topic clusters" without
 * the cost (and tuning headaches) of a full multi-level run.
 *
 * Reference:
 *   Blondel et al. — "Fast unfolding of communities in large networks",
 *   J. Stat. Mech. (2008) — https://arxiv.org/abs/0803.0476
 */

export interface GraphInput {
  nodes: string[];
  edges: { source: string; target: string; weight?: number }[];
}

export interface CommunityResult {
  /** Map from node id → community label (0-indexed integer). */
  communities: Map<string, number>;
  /** Final modularity score in [-0.5, 1] — higher = better-defined clusters. */
  modularity: number;
  /** Number of distinct communities found. */
  numCommunities: number;
}

export function louvain(input: GraphInput): CommunityResult {
  const { nodes, edges } = input;
  const n = nodes.length;
  if (n === 0) {
    return { communities: new Map(), modularity: 0, numCommunities: 0 };
  }
  // Build adjacency + per-node weighted degree.
  const idx = new Map<string, number>();
  nodes.forEach((id, i) => idx.set(id, i));
  const adj: Map<number, number>[] = Array.from({ length: n }, () => new Map());
  let totalWeight = 0;
  for (const e of edges) {
    const a = idx.get(e.source);
    const b = idx.get(e.target);
    if (a == null || b == null) continue;
    const w = e.weight ?? 1;
    adj[a].set(b, (adj[a].get(b) ?? 0) + w);
    if (a !== b) adj[b].set(a, (adj[b].get(a) ?? 0) + w);
    totalWeight += w;
  }
  // Each node starts in its own community.
  const community: number[] = nodes.map((_, i) => i);
  const degree: number[] = nodes.map((_, i) => {
    let d = 0;
    for (const w of adj[i].values()) d += w;
    return d;
  });
  // Σ_tot[c] = sum of degrees of nodes in community c.
  const sigmaTot: number[] = degree.slice();
  const m2 = totalWeight * 2 || 1; // avoid /0 on isolated subgraphs

  // Phase 1: local moves. Loop until no node changes community.
  let improved = true;
  let safety = 0;
  while (improved && safety < 32) {
    improved = false;
    safety++;
    for (let i = 0; i < n; i++) {
      const ci = community[i];
      // k_i,in[c] = sum of weights of edges from i to nodes already in c.
      const kIn = new Map<number, number>();
      for (const [j, w] of adj[i]) {
        const cj = community[j];
        kIn.set(cj, (kIn.get(cj) ?? 0) + w);
      }
      // Remove i from its current community.
      sigmaTot[ci] -= degree[i];
      const kIself = kIn.get(ci) ?? 0;
      // Pick the community that maximises ΔQ for i.
      let bestC = ci;
      let bestGain = 0;
      for (const [c, kIc] of kIn) {
        // ΔQ ∝ kIc/m - (Σ_tot[c] * k_i) / 2m²
        const gain = kIc / totalWeight - (sigmaTot[c] * degree[i]) / (2 * totalWeight * totalWeight);
        if (gain > bestGain) {
          bestGain = gain;
          bestC = c;
        }
      }
      // Re-insert i into the chosen community.
      community[i] = bestC;
      sigmaTot[bestC] += degree[i];
      if (bestC !== ci && bestGain > 0) improved = true;
      // bestC === ci → no movement, kIself accounted for in sigmaTot already.
      void kIself;
    }
  }
  // Renumber communities to 0..k-1 for a tidy output.
  const remap = new Map<number, number>();
  const result = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const raw = community[i];
    if (!remap.has(raw)) remap.set(raw, remap.size);
    result.set(nodes[i], remap.get(raw)!);
  }
  // Final modularity Q = (1/2m) Σ (A_ij - k_i k_j / 2m) δ(c_i, c_j)
  let q = 0;
  for (let i = 0; i < n; i++) {
    for (const [j, w] of adj[i]) {
      if (community[i] === community[j]) {
        q += w - (degree[i] * degree[j]) / m2;
      }
    }
  }
  const modularity = q / m2;
  return {
    communities: result,
    modularity: Number.isFinite(modularity) ? modularity : 0,
    numCommunities: remap.size,
  };
}

/** Generate a colour palette of size n using HSL hue spread. */
export function communityPalette(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const hue = Math.round((360 * i) / Math.max(n, 1));
    // design-allow: generated hues for graph communities (data colours, not interface colours)
    out.push(`hsl(${hue} 70% 60%)`);
  }
  return out;
}
