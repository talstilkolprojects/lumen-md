/**
 * The backup schedule (plan W1.6): once a day while the app is open. A tick
 * every 30 seconds checks whether a backup is due (none in the last 24 h);
 * a failure is reported at once (a toast, and the status the backup panel
 * shows) and retried after 15 minutes; three days without a successful
 * backup is reported once a day.
 */

import { runBackup, type BackupMode, type BackupResult, type BackupTarget } from "./backup";
import { backupStatus, setBackupStatus, STALE_AFTER_MS } from "./status";
import type { VaultBackend } from "../storage/vault/types";

export const TICK_MS = 30_000;
export const EVERY_MS = 86_400_000;
export const RETRY_MS = 15 * 60_000;

export interface SchedulerDeps {
  /** The configured target and mode, or null when backups aren't set up. */
  config: () => Promise<{ target: BackupTarget; mode: BackupMode } | null>;
  vault: () => VaultBackend;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  /** How the app tells the user (a toast). */
  notify?: (kind: "failed" | "stale" | "done", detail: string) => void;
  run?: typeof runBackup;
}

export function startBackupScheduler(d: SchedulerDeps) {
  const now = d.now ?? Date.now;
  const run = d.run ?? runBackup;
  let busy = false;
  let lastStaleNotice = 0;

  async function backupNow(): Promise<BackupResult | null> {
    if (busy) return null;
    busy = true;
    try {
      // A target that can't be reached (a folder without permission, an unplugged drive) is a failure too.
      const cfg = await d.config();
      if (!cfg) return null;
      setBackupStatus({ running: true });
      const r = await run({ vault: d.vault(), target: cfg.target, mode: cfg.mode, now });
      setBackupStatus({ running: false, lastSuccessAt: now(), lastName: r.name, lastError: null });
      d.notify?.("done", r.name);
      return r;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      setBackupStatus({ running: false, lastFailureAt: now(), lastError: msg });
      d.notify?.("failed", msg);
      throw e;
    } finally {
      busy = false;
    }
  }

  async function tick(): Promise<void> {
    const s = backupStatus();
    const t = now();
    const due = s.lastSuccessAt === null || t - s.lastSuccessAt >= EVERY_MS;
    const backingOff = s.lastFailureAt !== null && t - s.lastFailureAt < RETRY_MS && (s.lastSuccessAt === null || s.lastFailureAt > s.lastSuccessAt);
    if (due && !backingOff) await backupNow().catch(() => undefined);
    const after = backupStatus();
    // Three days since the last good backup, failing or not: said once a day.
    const stale = after.lastSuccessAt !== null && now() - after.lastSuccessAt > STALE_AFTER_MS;
    if (stale && now() - lastStaleNotice >= EVERY_MS) {
      lastStaleNotice = now();
      d.notify?.("stale", String(Math.floor((now() - (after.lastSuccessAt ?? 0)) / 86_400_000)));
    }
  }

  const si = d.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const ci = d.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const handle = si(() => void tick(), TICK_MS);
  const first = tick();
  return {
    backupNow,
    tick,
    /** The first check, started with the scheduler. */
    started: first,
    stop: () => ci(handle),
  };
}
