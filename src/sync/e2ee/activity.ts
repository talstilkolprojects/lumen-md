/**
 * What the sync did, as it does it (plan W1.8): the engine reports each step
 * through `onEvent`, the session keeps the latest ones here, and the
 * activity panel lists them. Kept on this device only, never uploaded.
 *
 * A conflict is reported the moment the round finds it, before the conflict
 * dialog opens, so the panel shows it while the user decides.
 */

import type { HoldReason } from "./status";

interface At {
  /** Milliseconds since the epoch. */
  at: number;
}

export type SyncEvent =
  | (At & { kind: "start" })
  | (At & { kind: "plan"; direction: "up" | "down"; files: number; bytes: number })
  | (At & { kind: "upload" | "download" | "delete"; path: string; bytes: number; direction: "up" | "down" })
  | (At & { kind: "conflict"; path: string })
  | (At & { kind: "held"; path: string; reason: HoldReason })
  | (At & { kind: "excluded"; path: string; reason: string; direction: "up" | "down" })
  | (At & { kind: "done"; uploaded: number; downloaded: number; deleted: number; conflicts: number; held: number; incomplete: boolean })
  | (At & { kind: "error"; message: string });

export type SyncEventListener = (e: SyncEvent) => void;

/** The newest events, oldest first, bounded. */
export class ActivityLog {
  private items: SyncEvent[] = [];
  private readonly listeners = new Set<() => void>();
  /** A new array per change, so React's useSyncExternalStore sees it. */
  private snapshot: readonly SyncEvent[] = [];

  private readonly limit: number;

  constructor(limit = 500) {
    this.limit = limit;
  }

  push(e: SyncEvent): void {
    // One "excluded" line per path and direction is enough; every round would repeat it.
    if (e.kind === "excluded" && this.items.some((x) => x.kind === "excluded" && x.path === e.path && x.direction === e.direction && x.reason === e.reason)) return;
    this.items.push(e);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    this.snapshot = [...this.items];
    for (const l of this.listeners) l();
  }

  list = (): readonly SyncEvent[] => this.snapshot;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  clear(): void {
    this.items = [];
    this.snapshot = [];
    for (const l of this.listeners) l();
  }
}
