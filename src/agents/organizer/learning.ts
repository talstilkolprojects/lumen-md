/**
 * What the organizer learns from your approvals and rejections (plan W2.1),
 * the way the learning critic (T30 / plan 5.6, agents/outcomes.ts) learns
 * which suggestion worked: a tally per feature (`link`, `tag`, `tag:<tag>`,
 * `merge`, `moc`) in IndexedDB, on this device only.
 *
 * A suggestion's confidence is scaled by how its features fared here
 * (Laplace-smoothed approval rate, 0.5 when nothing is known yet), and a
 * feature rejected at least 3 times with under a 25% approval rate is not
 * suggested again.
 */
import { createStore, get, set, type UseStore } from "idb-keyval";
import type { OrganizerSuggestion } from "./analyze";

export interface Tally {
  ok: number;
  no: number;
}
export type Book = Record<string, Tally>;

const KEY = "organizer.v1";
let db: UseStore | null = null;
let book: Book | null = null;

function store(): UseStore | null {
  if (typeof indexedDB === "undefined") return null;
  return (db ??= createStore("lumen-organizer", "kv"));
}

export async function loadBook(): Promise<Book> {
  if (book) return book;
  const s = store();
  try {
    book = (s ? ((await get(KEY, s)) as Book | undefined) : undefined) ?? {};
  } catch {
    book = {};
  }
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

/** Record a decision on a suggestion (all of its features). */
export async function recordDecision(features: readonly string[], approved: boolean): Promise<Book> {
  const b = await loadBook();
  for (const f of features) {
    const t = (b[f] ??= { ok: 0, no: 0 });
    if (approved) t.ok++;
    else t.no++;
  }
  const s = store();
  if (s) {
    try {
      await set(KEY, b, s);
    } catch {
      /* storage denied: learning stays for the session */
    }
  }
  return b;
}

/** Tests: forget everything (in memory; the next save overwrites the stored book). */
export function __resetLearning(): void {
  book = {};
}
