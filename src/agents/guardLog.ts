/**
 * The Rule of Two in the privacy log (W11.I2): when an agent run first holds
 * outside content (`tainted`), and every approval asked for a write or a
 * network call in such a run, with the user's answer. Kept apart from the
 * privacy ledger, which lists network requests only: nothing leaves the
 * device for these entries, and a request an approval let through has its
 * own ledger entry. The privacy panel shows them; this session only, like
 * the ledger.
 */

export interface GuardEvent {
  id: number;
  ts: number;
  event: "tainted" | "approved" | "declined";
  /** The tool asked about (not for `tainted`). */
  tool?: string;
  scope?: "write" | "network";
  /** Where the run's outside content came from, as the prompt lists it. */
  sources: string;
}

const MAX = 500;
let events: GuardEvent[] = [];
let seq = 0;
const listeners = new Set<() => void>();

export function recordGuardEvent(e: Omit<GuardEvent, "id" | "ts">): GuardEvent {
  const full: GuardEvent = { id: ++seq, ts: Date.now(), ...e };
  events = [...events, full].slice(-MAX);
  for (const fn of [...listeners]) fn();
  return full;
}

/** The session's events, oldest first (a stable array between changes). */
export function guardLog(): readonly GuardEvent[] {
  return events;
}

export function subscribeGuardLog(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Counts for the panel's summary. */
export function guardTotals(list: readonly GuardEvent[] = events): { tainted: number; asked: number; declined: number } {
  return { tainted: list.filter((e) => e.event === "tainted").length, asked: list.filter((e) => e.event !== "tainted").length, declined: list.filter((e) => e.event === "declined").length };
}

export function clearGuardLog(): void {
  events = [];
  for (const fn of [...listeners]) fn();
}
