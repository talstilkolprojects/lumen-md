/**
 * The backup's state (plan W1.6): when the last backup worked, when the last
 * one failed and why, and whether one is running. Kept in localStorage so a
 * reload still knows; tiny and dependency-free, so the status bar can read
 * it without loading the backup code.
 */

export const STATUS_KEY = "lumen.backup.status.v1";
/** No successful backup for this long: the app says so. */
export const STALE_AFTER_MS = 3 * 86_400_000;

export interface BackupStatus {
  lastSuccessAt: number | null;
  lastName: string | null;
  lastFailureAt: number | null;
  lastError: string | null;
  running: boolean;
}

const empty = (): BackupStatus => ({ lastSuccessAt: null, lastName: null, lastFailureAt: null, lastError: null, running: false });
let status: BackupStatus | null = null;
const listeners = new Set<(s: BackupStatus) => void>();

export function backupStatus(): BackupStatus {
  if (status) return status;
  try {
    const v = JSON.parse(localStorage.getItem(STATUS_KEY) ?? "null") as BackupStatus | null;
    status = v && typeof v === "object" ? { ...empty(), ...v, running: false } : empty();
  } catch {
    status = empty();
  }
  return status;
}

export function setBackupStatus(patch: Partial<BackupStatus>): BackupStatus {
  status = { ...backupStatus(), ...patch };
  try {
    localStorage.setItem(STATUS_KEY, JSON.stringify({ ...status, running: false }));
  } catch {
    // why: storage is blocked or full (private mode, quota): the setting holds for this session only
    /* private mode: the state lives for this tab */
  }
  for (const l of [...listeners]) l(status);
  return status;
}

export function subscribeBackupStatus(fn: (s: BackupStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** What the app should say: nothing, a failure, or that backups stopped running. */
export function backupHealth(s: BackupStatus, now = Date.now()): "ok" | "failed" | "stale" | "never" {
  if (s.lastFailureAt !== null && (s.lastSuccessAt === null || s.lastFailureAt > s.lastSuccessAt)) return "failed";
  if (s.lastSuccessAt === null) return "never";
  return now - s.lastSuccessAt > STALE_AFTER_MS ? "stale" : "ok";
}

/** @internal tests */
export function __resetBackupStatus(): void {
  status = null;
  listeners.clear();
}
