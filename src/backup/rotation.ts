/**
 * Which backups to keep (plan W1.6): the newest backup of each of the last 7
 * days, of each of the last 4 weeks and of each of the last 6 months
 * ("grandfather–father–son"). A backup that is the newest of its day, week
 * or month within those windows is kept; every other one is pruned. The
 * newest backup of all is always kept. Days, weeks and months are UTC.
 */

export interface Snapshot {
  name: string;
  /** When it was taken, ms since the epoch. */
  at: number;
}

export const KEEP = { daily: 7, weekly: 4, monthly: 6 } as const;

const DAY = 86_400_000;
const dayKey = (t: number) => Math.floor(t / DAY);
/** Weeks starting on Monday (1970-01-01 was a Thursday). */
const weekKey = (t: number) => Math.floor((dayKey(t) + 3) / 7);
const monthKey = (t: number) => {
  const d = new Date(t);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

export function selectKept(snapshots: Snapshot[], keep: { daily: number; weekly: number; monthly: number } = KEEP): { keep: Snapshot[]; prune: Snapshot[]; why: Map<string, string[]> } {
  const sorted = [...snapshots].sort((a, b) => b.at - a.at);
  const why = new Map<string, string[]>();
  const tag = (s: Snapshot, w: string) => why.set(s.name, [...(why.get(s.name) ?? []), w]);
  const bucket = (key: (t: number) => number, count: number, label: string) => {
    const seen = new Set<number>();
    for (const s of sorted) {
      const k = key(s.at);
      if (seen.has(k)) continue;
      if (seen.size >= count) break;
      seen.add(k);
      tag(s, label);
    }
  };
  bucket(dayKey, keep.daily, "daily");
  bucket(weekKey, keep.weekly, "weekly");
  bucket(monthKey, keep.monthly, "monthly");
  if (sorted[0]) tag(sorted[0], "latest");
  return { keep: sorted.filter((s) => why.has(s.name)), prune: sorted.filter((s) => !why.has(s.name)), why };
}
