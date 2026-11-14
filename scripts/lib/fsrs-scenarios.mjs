/**
 * The 50 golden spaced-repetition scenarios (plan W3.3): each a new card
 * reviewed 4–10 times with a fixed pattern of ratings and timing (on time,
 * early, late, same day). The same simulation runs against ts-fsrs
 * (scripts/fsrs-golden.mjs, which writes the expected results) and against
 * Lumen's scheduler (src/__tests__/fsrsGolden.test.ts), so the two can be
 * compared step by step. Deterministic; pure.
 */

export const START = "2026-01-05T09:00:00.000Z";

/** A small deterministic generator (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * steps: [{ rating 1–4, when }]: when "due" (at the due time), "late:N" (N days
 * after due), "early:N" (N hours before due, never before the last review),
 * "now:M" (M minutes after the last review).
 */
export function makeScenarios(n = 50) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = rng(1000 + i);
    const len = 4 + Math.floor(r() * 7);
    const steps = [];
    for (let j = 0; j < len; j++) {
      const x = r();
      const rating = x < 0.15 ? 1 : x < 0.3 ? 2 : x < 0.85 ? 3 : 4;
      const y = r();
      const when = j === 0 ? "due" : y < 0.55 ? "due" : y < 0.75 ? `late:${1 + Math.floor(r() * 20)}` : y < 0.9 ? `early:${1 + Math.floor(r() * 12)}` : `now:${1 + Math.floor(r() * 30)}`;
      steps.push({ rating, when });
    }
    out.push({ id: `s${String(i + 1).padStart(2, "0")}`, steps });
  }
  return out;
}

/** The time of a step, from the card's due time and its last review (ISO strings). */
export function stepTime(when, due, last) {
  const d = new Date(due).getTime();
  const l = last ? new Date(last).getTime() : d;
  const [kind, num] = when.split(":");
  const n = Number(num ?? 0);
  if (kind === "late") return new Date(d + n * 86_400_000);
  if (kind === "early") return new Date(Math.max(l + 60_000, d - n * 3_600_000));
  if (kind === "now") return new Date(l + n * 60_000);
  return new Date(Math.max(d, l + 60_000));
}

/**
 * Run a scenario. `adapter`: { create(now) → card, next(card, rating, now) → card,
 * read(card) → { state, due (ISO), stability, difficulty, scheduledDays, last (ISO|null) } }.
 * → one record per step.
 */
export function simulate(scenario, adapter) {
  let card = adapter.create(new Date(START));
  const records = [];
  for (const s of scenario.steps) {
    const view = adapter.read(card);
    const now = stepTime(s.when, view.due, view.last);
    card = adapter.next(card, s.rating, now);
    const v = adapter.read(card);
    records.push({ at: now.toISOString(), rating: s.rating, state: v.state, due: v.due, stability: v.stability, difficulty: v.difficulty, scheduledDays: v.scheduledDays });
  }
  return records;
}
