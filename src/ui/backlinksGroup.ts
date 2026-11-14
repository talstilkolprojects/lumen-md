/**
 * The backlinks panel's search, sort and per-file groups (plan W7.3,
 * Heptabase 8.2026). Pure, so the tests run it without a DOM.
 */
import type { BacklinkHit } from "../storage/vaultIndexCore";

export type BacklinkSort = "name" | "modified";

export interface BacklinkGroup {
  fromPath: string;
  fromName: string;
  modified: number;
  hits: BacklinkHit[];
}

/** Case and niqqud do not matter to the search (what a person types rarely has niqqud). */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0591-\u05C7\u0300-\u036F]/g, "").toLowerCase();
}

/**
 * Hits grouped by the note they come from. `query` keeps a group when its
 * name or path matches (all its hits) or else only the hits whose text does.
 */
export function groupBacklinks(hits: readonly BacklinkHit[], opts: { query?: string; sort?: BacklinkSort; modified?: ReadonlyMap<string, number>; locale?: string } = {}): BacklinkGroup[] {
  const q = fold((opts.query ?? "").trim());
  const groups = new Map<string, BacklinkGroup>();
  for (const h of hits) {
    let g = groups.get(h.fromPath);
    if (!g) groups.set(h.fromPath, (g = { fromPath: h.fromPath, fromName: h.fromName, modified: opts.modified?.get(h.fromPath) ?? 0, hits: [] }));
    g.hits.push(h);
  }
  let out = [...groups.values()];
  if (q) {
    out = out
      .map((g) => (fold(g.fromPath).includes(q) ? g : { ...g, hits: g.hits.filter((h) => fold(h.snippet).includes(q)) }))
      .filter((g) => g.hits.length > 0);
  }
  const collator = new Intl.Collator(opts.locale, { sensitivity: "base", numeric: true });
  const byName = (a: BacklinkGroup, b: BacklinkGroup) => collator.compare(a.fromName, b.fromName) || collator.compare(a.fromPath, b.fromPath);
  out.sort(opts.sort === "modified" ? (a, b) => b.modified - a.modified || byName(a, b) : byName);
  for (const g of out) g.hits = [...g.hits].sort((a, b) => a.offset - b.offset);
  return out;
}
