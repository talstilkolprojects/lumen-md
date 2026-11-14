/**
 * Command palette search (plan W2.8): rank the commands for a query, and
 * also for the same keystrokes in the other keyboard layout — `jhpuai`
 * finds "חיפוש", `xhhu` finds "save" — so typing with the wrong layout on
 * still finds the command.
 *
 * Ranking: the label starts with the query, then a word in the label does,
 * then the label contains it, then the hint or group does. Within a tier
 * the palette's own order is kept. Matches of the other-layout reading come
 * just below matches of the same tier for what was typed.
 */

import { wrongLayoutVariant } from "../lib/keyboardLayout";

interface Searchable {
  label: string;
  hint?: string;
  group?: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 4 starts the label, 3 starts a word of it, 2 inside it, 1 in the hint or group, 0 no match. */
export function matchScore(c: Searchable, q: string): number {
  if (!q) return 0;
  // Leading emoji and symbols ("🎨 Canvas") don't count for "starts with".
  const label = c.label.toLowerCase().replace(/^[^\p{L}\p{N}]+/u, "");
  if (label.startsWith(q)) return 4;
  if (new RegExp(`(^|[^\\p{L}\\p{N}])${escape(q)}`, "u").test(label)) return 3;
  if (label.includes(q)) return 2;
  if (`${c.hint ?? ""} ${c.group ?? ""}`.toLowerCase().includes(q)) return 1;
  return 0;
}

export interface RankedSearch<T> {
  items: T[];
  /** The other-layout reading that also matched, for the "also showing" note. */
  variant: string | null;
}

export function rankCommands<T extends Searchable>(list: readonly T[], query: string): RankedSearch<T> {
  const q = query.trim().toLowerCase();
  if (!q) return { items: [...list], variant: null };
  const v = wrongLayoutVariant(q)?.toLowerCase() ?? null;
  const scored: Array<{ c: T; s: number; i: number }> = [];
  let variantHit = false;
  list.forEach((c, i) => {
    const direct = matchScore(c, q);
    const other = v ? matchScore(c, v) : 0;
    if (other > direct) variantHit = true;
    // An other-layout match ranks half a tier below the same match for what was typed.
    const s = Math.max(direct, other ? other - 0.5 : 0);
    if (s > 0) scored.push({ c, s, i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return { items: scored.map((x) => x.c), variant: variantHit ? v : null };
}

/** Hits for what was typed, then the other-layout hits not already there (by path). */
export function mergeLayoutHits<T extends { path: string }>(direct: readonly T[], other: readonly T[]): T[] {
  const seen = new Set(direct.map((h) => h.path));
  return [...direct, ...other.filter((h) => !seen.has(h.path))];
}
