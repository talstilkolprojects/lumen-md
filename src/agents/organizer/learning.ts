/**
 * What the organizer learns from your approvals and rejections (plan W2.1):
 * a tally per feature (`link`, `tag`, `tag:<tag>`, `merge`, `moc`), kept by
 * the learning critic itself (T30 / plan 5.6, agents/outcomes.ts, scope
 * `organizer`; audit W10.C16) instead of a store of its own, in IndexedDB,
 * on this device only. A tally from the older `lumen-organizer` store is
 * folded in once.
 *
 * A suggestion's confidence is scaled by how its features fared here
 * (Laplace-smoothed approval rate, 0.5 when nothing is known yet), and a
 * feature rejected at least 3 times with under a 25% approval rate is not
 * suggested again.
 */
import { createStore, del, get, type UseStore } from "idb-keyval";
import type { OrganizerSuggestion } from "./analyze";
import { __resetOutcomes, featureTallies, recordFeatureOutcome } from "../outcomes";

export interface Tally {
  ok: number;
  no: number;
}
export type Book = Record<string, Tally>;

/** The older store (before W10.C16): read once and folded into the outcomes book. */
const LEGACY_KEY = "organizer.v1";
export const OUTCOME_SCOPE = "organizer";
let book: Book | null = null;

async function legacyBook(): Promise<Book | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const s: UseStore = createStore("lumen-organizer", "kv");
    const old = (await get(LEGACY_KEY, s)) as Book | undefined;
    if (old && Object.keys(old).length) await del(LEGACY_KEY, s);
    return old ?? null;
  } catch {
    return null;
  }
}

export async function loadBook(): Promise<Book> {
  if (book) return book;
  const old = await legacyBook();
  if (old) {
    for (const [f, t] of Object.entries(old)) {
      for (let i = 0; i < t.ok; i++) await recordFeatureOutcome(OUTCOME_SCOPE, [f], true);
      for (let i = 0; i < t.no; i++) await recordFeatureOutcome(OUTCOME_SCOPE, [f], false);
    }
  }
  const tallies = await featureTallies(OUTCOME_SCOPE);
  book = Object.fromEntries(Object.entries(tallies).map(([f, t]) => [f, { ok: t.ok, no: t.fail }]));
  return book;
}

/** Laplace-smoothed approval rate of a feature (0.5 when unknown). */
export function rate(b: Book, feature: string): number {
  const t = b[feature];
  return t ? (t.ok + 1) / (t.ok + t.no + 2) : 0.5;
}

export function suppressed(b: Book, feature: string): boolean {
  const t = b[feature];
  return !!t && t.no >= 3 && rate(b, feature) < 0.25;
}

/** Confidence after learning: × (0.5 + rate) per feature, the most specific (last) feature counting most. */
export function adjust(s: OrganizerSuggestion, b: Book): OrganizerSuggestion | null {
  if (s.features.some((f) => suppressed(b, f))) return null;
  let c = s.confidence;
  for (const f of s.features) c *= 0.5 + rate(b, f);
  return { ...s, confidence: Math.max(0, Math.min(0.99, Math.round(c * 100) / 100)) };
}

export function applyLearning(list: readonly OrganizerSuggestion[], b: Book, minConfidence = 0.5): OrganizerSuggestion[] {
  return list
    .map((s) => adjust(s, b))
    .filter((s): s is OrganizerSuggestion => !!s && s.confidence >= minConfidence)
    .sort((x, y) => y.confidence - x.confidence || x.id.localeCompare(y.id));
}

/** Record a decision on a suggestion (all of its features), in the learning critic's book. */
export async function recordDecision(features: readonly string[], approved: boolean): Promise<Book> {
  const b = await loadBook();
  for (const f of features) {
    const t = (b[f] ??= { ok: 0, no: 0 });
    if (approved) t.ok++;
    else t.no++;
  }
  await recordFeatureOutcome(OUTCOME_SCOPE, features, approved);
  return b;
}

/** Tests: forget everything (in memory; the next save overwrites the stored book). */
export function __resetLearning(): void {
  book = {};
  __resetOutcomes();
}
