/**
 * FSRS-5 scheduling (plan W3.3) — Lumen's own implementation of the
 * open-spaced-repetition algorithm (the one ts-fsrs implements; ts-fsrs is
 * not in the lockfile and can't be installed here). Default 19 weights,
 * request retention 0.9, no fuzz, short-term (same-day) steps on:
 *
 *   R(t, S)  = (1 + F·t/S)^C            C = −0.5, F = 19/81
 *   I(S)     = S/F · (r^(1/C) − 1)       = S at r = 0.9
 *   S₀(G)    = w[G−1]
 *   D₀(G)    = w4 − e^(w5·(G−1)) + 1
 *   D'(D,G)  = mean-revert( D − w6·(G−3)·(10−D)/9 )   towards D₀(Easy) by w7
 *   S'r      = S·(1 + e^w8·(11−D)·S^−w9·(e^(w10·(1−R)) − 1)·[w15 if Hard]·[w16 if Easy])
 *   S'f      = min( w11·D^−w12·((S+1)^w13 − 1)·e^(w14·(1−R)), S )
 *   S'short  = S·e^(w17·(G − 3 + w18))
 *
 * States and steps follow ts-fsrs's basic scheduler: a new card goes to
 * learning (Again 1 min, Hard 5 min, Good 10 min) or straight to review
 * (Easy); learning / relearning: Again 5 min, Hard 10 min, Good / Easy to
 * review; a lapse goes to relearning (5 min). Review intervals keep
 * Hard ≤ Good < Easy. Whether every number equals ts-fsrs's is checked by
 * the golden scenarios (src/__tests__/fixtures/fsrs-golden.json, generated
 * with ts-fsrs by `node scripts/fsrs-golden.mjs`); pure, so it can be
 * swapped for ts-fsrs behind `Scheduler` if they differ.
 */

export type Rating = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy
export type State = "new" | "learning" | "review" | "relearning";

export interface Card {
  state: State;
  /** ISO time the card is due. */
  due: string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  /** ISO time of the last review (null for a new card). */
  last: string | null;
  /** Days between the last two reviews when it was scheduled (review state). */
  scheduledDays: number;
}

export interface Params {
  w: readonly number[];
  requestRetention: number;
  maximumInterval: number;
}

export const DEFAULT_W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621] as const;
export const DEFAULT_PARAMS: Params = { w: DEFAULT_W, requestRetention: 0.9, maximumInterval: 36500 };

const DECAY = -0.5;
const FACTOR = 19 / 81;
const DAY = 86_400_000;
const MIN = 60_000;
const round8 = (x: number) => Math.round(x * 1e8) / 1e8;
const clampD = (d: number) => Math.min(10, Math.max(1, d));

export function newCard(now: Date): Card {
  return { state: "new", due: now.toISOString(), stability: 0, difficulty: 0, reps: 0, lapses: 0, last: null, scheduledDays: 0 };
}

export const retrievability = (elapsedDays: number, stability: number) => (stability > 0 ? Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / stability, DECAY) : 0);

export interface Scheduler {
  next(card: Card, rating: Rating, now: Date): Card;
}

export function fsrs(p: Params = DEFAULT_PARAMS): Scheduler & {
  initStability(g: Rating): number;
  initDifficulty(g: Rating): number;
  nextDifficulty(d: number, g: Rating): number;
  recallStability(d: number, s: number, r: number, g: Rating): number;
  forgetStability(d: number, s: number, r: number): number;
  shortTermStability(s: number, g: Rating): number;
  interval(s: number): number;
} {
  const w = p.w;
  const initStability = (g: Rating) => Math.max(w[g - 1], 0.1);
  const initDifficulty = (g: Rating) => round8(clampD(w[4] - Math.exp(w[5] * (g - 1)) + 1));
  const nextDifficulty = (d: number, g: Rating) => {
    const delta = -w[6] * (g - 3);
    const damped = d + (delta * (10 - d)) / 9;
    return round8(clampD(w[7] * initDifficulty(4) + (1 - w[7]) * damped));
  };
  const recallStability = (d: number, s: number, r: number, g: Rating) =>
    round8(s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1) * (g === 2 ? w[15] : 1) * (g === 4 ? w[16] : 1)));
  const forgetStability = (d: number, s: number, r: number) => round8(Math.min(w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]), s));
  const shortTermStability = (s: number, g: Rating) => round8(s * Math.exp(w[17] * (g - 3 + w[18])));
  const interval = (s: number) => {
    const raw = (s / FACTOR) * (Math.pow(p.requestRetention, 1 / DECAY) - 1);
    return Math.min(Math.max(Math.round(raw), 1), p.maximumInterval);
  };
  const at = (now: Date, ms: number) => new Date(now.getTime() + ms).toISOString();

  const next = (card: Card, g: Rating, now: Date): Card => {
    const elapsed = card.last ? Math.max(0, Math.floor((now.getTime() - new Date(card.last).getTime()) / DAY)) : 0;
    const base = { ...card, reps: card.reps + 1, last: now.toISOString() };
    if (card.state === "new") {
      const s = initStability(g);
      const d = initDifficulty(g);
      if (g === 4) {
        const days = interval(s);
        return { ...base, state: "review", stability: s, difficulty: d, scheduledDays: days, due: at(now, days * DAY) };
      }
      return { ...base, state: "learning", stability: s, difficulty: d, scheduledDays: 0, due: at(now, (g === 1 ? 1 : g === 2 ? 5 : 10) * MIN) };
    }
    const d = nextDifficulty(card.difficulty, g);
    if (card.state === "learning" || card.state === "relearning") {
      const s = shortTermStability(card.stability, g);
      if (g <= 2) return { ...base, stability: s, difficulty: d, scheduledDays: 0, due: at(now, (g === 1 ? 5 : 10) * MIN) };
      const days = interval(s);
      return { ...base, state: "review", stability: s, difficulty: d, scheduledDays: days, due: at(now, days * DAY) };
    }
    // Review.
    const r = retrievability(elapsed, card.stability);
    if (g === 1) {
      const s = forgetStability(card.difficulty, card.stability, r);
      return { ...base, state: "relearning", stability: s, difficulty: d, lapses: card.lapses + 1, scheduledDays: 0, due: at(now, 5 * MIN) };
    }
    const sHard = recallStability(card.difficulty, card.stability, r, 2);
    const sGood = recallStability(card.difficulty, card.stability, r, 3);
    const sEasy = recallStability(card.difficulty, card.stability, r, 4);
    let iHard = interval(sHard);
    let iGood = interval(sGood);
    let iEasy = interval(sEasy);
    iHard = Math.min(iHard, iGood);
    iGood = Math.max(iGood, iHard + 1);
    iEasy = Math.max(iEasy, iGood + 1);
    const s = g === 2 ? sHard : g === 3 ? sGood : sEasy;
    const days = g === 2 ? iHard : g === 3 ? iGood : iEasy;
    return { ...base, state: "review", stability: s, difficulty: d, scheduledDays: days, due: at(now, days * DAY) };
  };
  return { next, initStability, initDifficulty, nextDifficulty, recallStability, forgetStability, shortTermStability, interval };
}
