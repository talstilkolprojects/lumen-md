/**
 * Git watch-mode — polls the remote of an active repo every N minutes
 * and pulls if there are upstream changes. Off by default; flip on via
 * `localStorage["lumen.git.watch"] = "1"` or the command palette.
 *
 * Why polling and not webhooks: Git providers don't push to clients,
 * and Lumen runs entirely in-browser — there's no server we control to
 * receive a webhook. Polling at a humane cadence (5 min default) is
 * the practical option.
 *
 * Each tick:
 *   1. Read the active doc's `workspaceName` to find the repo folder.
 *   2. `git fetch` (delta-only, cheap) via isomorphic-git.
 *   3. If HEAD is behind, run `pullRepo()` — the safe pull (plan 3.3): a
 *      three-way merge that never deletes and never overwrites a note
 *      with unsaved edits — and dispatch a workspace changed event so the
 *      UI refreshes. Conflicts are left marked in their files and reported
 *      (`onConflicts`); the user resolves them with "Git: pull".
 *
 * Disabled when:
 *   • the user is offline (`navigator.onLine === false`)
 *   • the tab is hidden (saves battery + bandwidth)
 *   • a pull is already in flight
 */

import { pullRepo } from "./git";
import { log } from "../lib/logger";

const STORAGE_KEY = "lumen.git.watch";
const DEFAULT_INTERVAL_MS = 5 * 60_000;

let timer: number | null = null;
let inFlight = false;

export interface WatchOptions {
  /** Folder name in the OPFS workspace that maps to a Git repo. */
  repoFolder: string;
  /** Poll cadence in ms. Default 5 minutes. */
  intervalMs?: number;
  /** Called after a successful pull with the diff stat. */
  onPulled?: (stats: { changedFiles: number }) => void;
  /** Called when a pull left conflicts (marked in the files, nothing lost). */
  onConflicts?: (count: number) => void;
  /** Called on every tick that didn't pull (no upstream changes). */
  onIdle?: () => void;
}

export function isWatching(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setWatching(on: boolean): void {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode — best-effort */
  }
}

/**
 * Start polling. Idempotent — calling twice replaces the running timer.
 * Returns a stop function.
 */
export function startGitWatch(opts: WatchOptions): () => void {
  stopGitWatch();
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  const tick = async () => {
    if (inFlight) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      opts.onIdle?.();
      return;
    }
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      opts.onIdle?.();
      return;
    }
    inFlight = true;
    try {
      const result = await pullRepo(opts.repoFolder);
      if (result.changedFiles > 0) {
        window.dispatchEvent(new Event("lumen-workspace-changed"));
        opts.onPulled?.({ changedFiles: result.changedFiles });
        if (result.conflicts.length) opts.onConflicts?.(result.conflicts.length);
      } else {
        opts.onIdle?.();
      }
    } catch (err) {
      log.warn("git-watch tick failed", err);
    } finally {
      inFlight = false;
    }
  };

  // Run once now so the user sees immediate feedback when they enable it.
  void tick();
  timer = window.setInterval(() => void tick(), intervalMs);
  return stopGitWatch;
}

export function stopGitWatch(): void {
  if (timer != null) {
    window.clearInterval(timer);
    timer = null;
  }
}
