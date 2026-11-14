/**
 * Plan W3.3 — spaced repetition: FSRS-5 (formulas against hand-computed
 * values, the learning / review / relearning flow), the sources
 * (question::answer lines, highlights), the review file in the vault and
 * today's 5–10 cards.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_W, fsrs, newCard, retrievability, type Card } from "../srs/fsrs";
import { dailyQueue, emptyReviewFile, hash, highlightCard, parseReviewFile, qaCards, rate, serializeReviewFile, syncSources, type Source } from "../srs/cards";
import {
  makeScenarios,
  simulate,
  stepTime,
  START,
  // @ts-expect-error — plain .mjs module without type declarations
} from "../../scripts/lib/fsrs-scenarios.mjs";

const f = fsrs();
const T0 = new Date("2026-01-05T09:00:00Z");
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
const DAY = 86_400_000;
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

describe("FSRS-5 formulas (W3.3)", () => {
  it("retrievability is 90% after exactly S days, and the interval at 0.9 is S", () => {
    expect(close(retrievability(10, 10), 0.9)).toBe(true);
    expect(retrievability(0, 5)).toBe(1);
    expect(f.interval(10.4)).toBe(10);
    expect(f.interval(0.2)).toBe(1);
    expect(f.interval(1e9)).toBe(36500);
  });

  it("first stability is w0–w3; first difficulty w4 − e^(w5·(G−1)) + 1, clamped to 1–10", () => {
    expect([1, 2, 3, 4].map((g) => f.initStability(g as 1 | 2 | 3 | 4))).toEqual([DEFAULT_W[0], DEFAULT_W[1], DEFAULT_W[2], DEFAULT_W[3]]);
    expect(close(f.initDifficulty(3), DEFAULT_W[4] - Math.exp(2 * DEFAULT_W[5]) + 1, 1e-7)).toBe(true);
    expect(f.initDifficulty(4)).toBeGreaterThanOrEqual(1);
    expect(f.initDifficulty(1)).toBeLessThanOrEqual(10);
  });

  it("difficulty: Again raises it, Easy lowers it, Good barely moves it (mean reversion)", () => {
    const d = 5;
    expect(f.nextDifficulty(d, 1)).toBeGreaterThan(d);
    expect(f.nextDifficulty(d, 4)).toBeLessThan(d);
    expect(Math.abs(f.nextDifficulty(d, 3) - d)).toBeLessThan(0.01);
    const want = DEFAULT_W[7] * f.initDifficulty(4) + (1 - DEFAULT_W[7]) * (d + (-DEFAULT_W[6] * -2 * (10 - d)) / 9);
    expect(close(f.nextDifficulty(d, 1), Math.min(10, want), 1e-7)).toBe(true);
  });

  it("recall stability grows, more for Easy than Good than Hard; a lapse never raises it", () => {
    const [h, g, e] = ([2, 3, 4] as const).map((x) => f.recallStability(5, 10, 0.9, x));
    expect(h < g && g < e).toBe(true);
    const want = 10 * (1 + Math.exp(DEFAULT_W[8]) * 6 * Math.pow(10, -DEFAULT_W[9]) * (Math.exp(0.1 * DEFAULT_W[10]) - 1));
    expect(close(g, want, 1e-6)).toBe(true);
    expect(f.forgetStability(5, 10, 0.9)).toBeLessThanOrEqual(10);
    expect(f.forgetStability(5, 0.5, 0.9)).toBeLessThanOrEqual(0.5);
    expect(close(f.shortTermStability(2, 3), 2 * Math.exp(DEFAULT_W[17] * DEFAULT_W[18]), 1e-7)).toBe(true);
  });
});

describe("FSRS-5 flow (W3.3)", () => {
  it("new → learning (1 / 5 / 10 min) or straight to review on Easy", () => {
    const c = newCard(T0);
    expect(f.next(c, 1, T0)).toMatchObject({ state: "learning", due: plus(T0, 60_000).toISOString(), reps: 1 });
    expect(f.next(c, 2, T0).due).toBe(plus(T0, 5 * 60_000).toISOString());
    expect(f.next(c, 3, T0).due).toBe(plus(T0, 10 * 60_000).toISOString());
    const easy = f.next(c, 4, T0);
    expect(easy).toMatchObject({ state: "review", scheduledDays: f.interval(DEFAULT_W[3]) });
    expect(easy.due).toBe(plus(T0, easy.scheduledDays * DAY).toISOString());
  });

  it("learning → review on Good; review → relearning on Again (a lapse); Hard ≤ Good < Easy", () => {
    let c: Card = f.next(newCard(T0), 3, T0);
    c = f.next(c, 3, plus(T0, 10 * 60_000));
    expect(c.state).toBe("review");
    const due = new Date(c.due);
    const hard = f.next(c, 2, due);
    const good = f.next(c, 3, due);
    const easy = f.next(c, 4, due);
    expect(hard.scheduledDays).toBeLessThanOrEqual(good.scheduledDays);
    expect(good.scheduledDays).toBeLessThan(easy.scheduledDays);
    const lapse = f.next(c, 1, due);
    expect(lapse).toMatchObject({ state: "relearning", lapses: 1, due: plus(due, 5 * 60_000).toISOString() });
    expect(f.next(lapse, 3, plus(due, 5 * 60_000)).state).toBe("review");
  });

  it("a review later than due counts the real elapsed days (lower R, bigger gain)", () => {
    let c: Card = f.next(newCard(T0), 4, T0);
    const onTime = f.next(c, 3, new Date(c.due));
    const late = f.next(c, 3, plus(new Date(c.due), 10 * DAY));
    expect(late.stability).toBeGreaterThan(onTime.stability);
    c = onTime;
    expect(c.reps).toBe(2);
  });

  it("the golden scenarios are fixed: 50, each 4–10 reviews, with stable timing rules", () => {
    const s = makeScenarios();
    expect(s).toHaveLength(50);
    expect(s.every((x: { steps: unknown[] }) => x.steps.length >= 4 && x.steps.length <= 10)).toBe(true);
    expect(makeScenarios()).toEqual(s);
    expect(stepTime("late:2", START, null).toISOString()).toBe("2026-01-07T09:00:00.000Z");
    expect(stepTime("early:5", "2026-01-10T09:00:00.000Z", "2026-01-10T06:00:00.000Z").toISOString()).toBe("2026-01-10T06:01:00.000Z");
    const recs = simulate(s[0], { create: (now: Date) => newCard(now), next: (c: Card, g: 1 | 2 | 3 | 4, now: Date) => f.next(c, g, now), read: (c: Card) => c });
    expect(recs).toHaveLength(s[0].steps.length);
  });
});

describe("cards from the vault (W3.3)", () => {
  it("question::answer lines, not Dataview fields or code", () => {
    const md = "---\ntitle: x\n---\n# Notes\n\n- What is FSRS? :: A spacing algorithm\nמה בירת צרפת?::פריז\nstatus:: done\nThe capital of Japan :: Tokyo\n\n```\nfoo bar :: not a card\n```\n";
    const cards = qaCards("study/notes.md", md);
    expect(cards.map((c) => [c.front, c.back])).toEqual([
      ["What is FSRS?", "A spacing algorithm"],
      ["מה בירת צרפת?", "פריז"],
      ["The capital of Japan", "Tokyo"],
    ]);
    expect(cards[0]).toMatchObject({ id: `qa:study/notes.md#${hash("What is FSRS?")}`, link: "study/notes.md", kind: "qa" });
  });

  it("a highlight is a card with its note and link", () => {
    const c = highlightCard({ key: "k", kind: "pdf", source: "p.pdf", notePath: "p.pdf.md", id: "urn:uuid:1", text: "the passage", note: "why", tags: [], location: 2, link: "p.pdf#page=2&highlight=1", created: null, haystack: "" });
    expect(c).toEqual({ id: "hl:p.pdf.md#urn:uuid:1", kind: "highlight", front: "the passage", back: "why", link: "p.pdf#page=2&highlight=1", source: "p.pdf" });
  });
});

describe("the review file and today's queue (W3.3)", () => {
  const src = (i: number): Source => ({ id: `qa:n.md#${i}`, kind: "qa", front: `Question ${i}?`, back: `Answer ${i}`, link: "n.md", source: "n.md" });

  it("sync adds new cards, updates text, keeps schedules, marks gone sources", () => {
    let file = syncSources(emptyReviewFile(), [src(1), src(2)], T0);
    file = rate(file, "qa:n.md#1", 4, T0, f);
    const due = file.cards["qa:n.md#1"].card.due;
    file = syncSources(file, [{ ...src(1), back: "Changed" }, src(3)], plus(T0, DAY));
    expect(file.cards["qa:n.md#1"]).toMatchObject({ back: "Changed", card: { due } });
    expect(file.cards["qa:n.md#2"].gone).toBe(true);
    expect(file.cards["qa:n.md#3"].card.state).toBe("new");
    expect(parseReviewFile(serializeReviewFile(file))).toEqual(JSON.parse(serializeReviewFile(file)));
    expect(parseReviewFile("{oops")).toBeNull();
    expect(parseReviewFile(null)).toEqual(emptyReviewFile());
  });

  it("today: due cards first (most overdue), then at most 5 new, 10 in all; new cards seen today count", () => {
    let file = syncSources(emptyReviewFile(), Array.from({ length: 20 }, (_, i) => src(i)), T0);
    for (const i of [0, 1, 2, 3, 4, 5, 6, 7]) file = rate(file, `qa:n.md#${i}`, 4, T0, f);
    const later = plus(T0, 30 * DAY);
    const q = dailyQueue(file, later);
    expect(q).toHaveLength(10);
    expect(q.slice(0, 8).every((e) => e.card.state === "review")).toBe(true);
    expect(q.slice(8).every((e) => e.card.state === "new")).toBe(true);
    // Same day as 8 introductions: no more new cards today.
    expect(dailyQueue(file, plus(T0, 3_600_000)).filter((e) => e.card.state === "new")).toHaveLength(0);
    expect(dailyQueue(syncSources(emptyReviewFile(), [src(1), src(2)], T0), T0)).toHaveLength(2);
  });
});
