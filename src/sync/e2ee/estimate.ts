/**
 * How long the current sync round will take (plan W1.8), from its own
 * events: the plan (files and bytes to move each way) and each finished
 * transfer. Work is weighted half by bytes and half by files, because a
 * round of many small notes is bound by requests and one of a few videos by
 * bandwidth. Before anything has finished, the speed of this device's
 * earlier rounds (saved locally) gives a first estimate; with neither, it
 * says nothing rather than guess.
 */

import type { SyncEvent } from "./activity";

export interface Progress {
  files: number;
  filesDone: number;
  bytes: number;
  bytesDone: number;
  /** Seconds left, or null when there is nothing to base it on yet. */
  secondsLeft: number | null;
  /** 0..1 */
  fraction: number;
}

export interface Speed {
  bytesPerSec: number;
  filesPerSec: number;
}

const SPEED_KEY = "lumen.sync.speed.v1";

export function loadSpeed(): Speed | null {
  try {
    const v = JSON.parse(localStorage.getItem(SPEED_KEY) ?? "null") as Speed | null;
    return v && v.bytesPerSec > 0 && v.filesPerSec > 0 ? v : null;
  } catch {
    return null;
  }
}

function saveSpeed(s: Speed): void {
  try {
    localStorage.setItem(SPEED_KEY, JSON.stringify(s));
  } catch {
    /* only a convenience */
  }
}

type Dir = "up" | "down";

export class RoundEstimator {
  private plan: Record<Dir, { files: number; bytes: number }> = { up: { files: 0, bytes: 0 }, down: { files: 0, bytes: 0 } };
  private done: Record<Dir, { files: number; bytes: number }> = { up: { files: 0, bytes: 0 }, down: { files: 0, bytes: 0 } };
  private startedAt = 0;
  /** When the first plan of the round was ready (transfers are measured from there), or null. */
  private measuredFrom: number | null = null;
  private prior: Speed | null;
  private readonly now: () => number;

  constructor(opts: { prior?: Speed | null; now?: () => number } = {}) {
    this.prior = opts.prior === undefined ? loadSpeed() : opts.prior;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Feed every engine event; returns the progress after it. */
  push(e: SyncEvent): Progress {
    switch (e.kind) {
      case "start":
        this.plan = { up: { files: 0, bytes: 0 }, down: { files: 0, bytes: 0 } };
        this.done = { up: { files: 0, bytes: 0 }, down: { files: 0, bytes: 0 } };
        this.startedAt = e.at;
        this.measuredFrom = null;
        break;
      case "plan":
        // A retried attempt plans again: what is still to do, on top of what is done.
        this.plan[e.direction] = { files: this.done[e.direction].files + e.files, bytes: this.done[e.direction].bytes + e.bytes };
        this.measuredFrom ??= e.at;
        break;
      case "upload":
      case "download":
      case "delete":
        this.done[e.direction].files++;
        this.done[e.direction].bytes += e.bytes;
        break;
      case "done":
        this.learn(e.at);
        break;
    }
    return this.progress();
  }

  private totals() {
    const files = this.plan.up.files + this.plan.down.files;
    const bytes = this.plan.up.bytes + this.plan.down.bytes;
    const filesDone = Math.min(files, this.done.up.files + this.done.down.files);
    const bytesDone = Math.min(bytes, this.done.up.bytes + this.done.down.bytes);
    return { files, bytes, filesDone, bytesDone };
  }

  progress(): Progress {
    const t = this.totals();
    const parts: number[] = [];
    if (t.files > 0) parts.push(t.filesDone / t.files);
    if (t.bytes > 0) parts.push(t.bytesDone / t.bytes);
    const fraction = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : t.files === 0 && this.startedAt ? 1 : 0;
    let secondsLeft: number | null = null;
    const elapsed = (this.now() - (this.measuredFrom ?? this.startedAt)) / 1000;
    if (fraction >= 1) secondsLeft = 0;
    else if (fraction > 0 && elapsed > 0) secondsLeft = (elapsed * (1 - fraction)) / fraction;
    else if (this.prior) {
      const left = { files: t.files - t.filesDone, bytes: t.bytes - t.bytesDone };
      secondsLeft = (left.files / this.prior.filesPerSec + left.bytes / this.prior.bytesPerSec) / 2;
    }
    return { ...t, secondsLeft: secondsLeft === null ? null : Math.max(0, secondsLeft), fraction };
  }

  /** After a round that moved something: remember this device's speed for the next first estimate. */
  private learn(at: number): void {
    const t = this.totals();
    const secs = (at - (this.measuredFrom ?? this.startedAt)) / 1000;
    if (secs < 1 || t.filesDone < 5) return;
    const now: Speed = { bytesPerSec: Math.max(1, t.bytesDone / secs), filesPerSec: Math.max(0.01, t.filesDone / secs) };
    // Moving average, so one slow round doesn't throw the next estimate off.
    this.prior = this.prior ? { bytesPerSec: (this.prior.bytesPerSec + now.bytesPerSec) / 2, filesPerSec: (this.prior.filesPerSec + now.filesPerSec) / 2 } : now;
    saveSpeed(this.prior);
  }
}

/** "about 3 min", "about 40 s", "less than 5 s": the panel's wording keys and values. */
export function describeSecondsLeft(s: number | null): { key: string; n?: number } | null {
  if (s === null) return null;
  if (s < 5) return { key: "e2ee.eta.seconds.few" };
  if (s < 60) return { key: "e2ee.eta.seconds", n: Math.round(s / 5) * 5 };
  if (s < 3600) return { key: "e2ee.eta.minutes", n: Math.round(s / 60) };
  return { key: "e2ee.eta.hours", n: Math.round((s / 3600) * 10) / 10 };
}
