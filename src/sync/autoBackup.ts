/**
 * Auto-backup — a snapshot of the current document 30 s after the user
 * stops typing, even if they never save, plus a snapshot of every note
 * that changed in the vault every ten minutes (T35).
 *
 * Both go to the one history store (src/storage/history.ts) that the
 * Version History panel reads. They used to be written as files under
 * `backups/` in the vault itself, where they showed up in the file tree,
 * in search and in the embeddings index — and never in the history panel.
 */

import { useAppStore } from "../store/useStore";
import { log } from "../lib/logger";
import { getHistoryVault, historyKey, recordSnapshot } from "../storage/history";

const AUTO_BACKUP_INTERVAL_MS = 30_000;
const IDLE_CALLBACK_TIMEOUT_MS = 2_000;
export const VAULT_SNAPSHOT_EVERY_MS = 10 * 60_000;

let timer: ReturnType<typeof setTimeout> | undefined;
let snapshotQueue: Array<{ name: string; content: string; ts: number; vault: string | null }> = [];
let isWriting = false;
/** The edit the 30 s timer is still waiting on, so a closing tab can save it. */
let pending: { name: string; content: string; vault: string | null } | null = null;

/**
 * Start the auto-backup listener.  Call once at application startup.
 */
export function startAutoBackup(): void {
  // We only need to listen to the store's content changes.
  // Using a Zustand subscribe avoids React re-renders entirely.
  const unsub = useAppStore.subscribe((state, prevState) => {
    if (state.doc.content === prevState.doc.content) return;
    if (!state.doc.content) return;
    scheduleSnapshot(historyKey(state.doc), state.doc.content);
  });

  // Flush when the tab closes or is hidden: the 30 s timer may still be
  // waiting on the latest edit, and a closed tab never fires it. `pagehide`
  // is the last reliable event (beforeunload is skipped by bfcache and on
  // mobile); `visibilitychange` → hidden covers a backgrounded phone.
  const onPageHide = () => {
    flushNow();
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") flushNow();
  };
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("beforeunload", onPageHide);
  document.addEventListener("visibilitychange", onVisibility);

  // Return teardown so tests can clean up.
  (startAutoBackup as unknown as { _teardown?: () => void })._teardown = () => {
    unsub();
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("beforeunload", onPageHide);
    document.removeEventListener("visibilitychange", onVisibility);
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    pending = null;
  };
}

/**
 * Snapshot the edit the timer is still waiting on and write everything
 * queued, now. Used when the page is hidden or going away.
 */
export function flushNow(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (pending) {
    snapshotQueue.push({ ...pending, ts: Date.now() });
    pending = null;
  }
  return flushQueue();
}

function scheduleSnapshot(name: string, content: string): void {
  if (timer) clearTimeout(timer);
  // The vault the edit was made in: a switch before the timer fires must
  // not file it under the next vault's history (2.80).
  const vault = getHistoryVault();
  pending = { name, content, vault };
  timer = setTimeout(() => {
    timer = undefined;
    pending = null;
    snapshotQueue.push({ name, content, ts: Date.now(), vault });
    // Use requestIdleCallback when available to avoid blocking the main thread.
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(
        () => {
          flushQueue();
        },
        { timeout: IDLE_CALLBACK_TIMEOUT_MS },
      );
    } else {
      flushQueue();
    }
  }, AUTO_BACKUP_INTERVAL_MS);
}

async function flushQueue(): Promise<void> {
  if (isWriting) return;
  isWriting = true;
  try {
    while (snapshotQueue.length > 0) {
      const snapshot = snapshotQueue.shift();
      if (!snapshot) continue;
      try {
        await recordSnapshot(snapshot.name, snapshot.content, "auto-backup", snapshot.ts, snapshot.vault);
      } catch (err) {
        log.error("[auto-backup] write failed:", (err as Error).message);
      }
    }
  } finally {
    isWriting = false;
  }
}

/** Last modified time already snapshotted, per vault identity and path. */
const vaultSeen = new Map<string, number>();

/**
 * Snapshot every vault note whose modified time moved since the last
 * pass. Identical content is skipped by the store, so this is cheap when
 * little changed. Returns the number of snapshots written.
 */
export async function snapshotVault(): Promise<number> {
  const ws = await import("../storage/workspace");
  if (!ws.isOPFSAvailable()) return 0;
  const vault = getHistoryVault();
  if (vault === null) return 0;
  // The pass belongs to the vault it started in: every read goes through
  // that vault's backend, and the pass stops if the active vault changes,
  // so one vault's text is never filed in another's history.
  const { getVaultBackend } = await import("../storage/vault");
  const backend = getVaultBackend();
  const still = () => getVaultBackend() === backend && getHistoryVault() === vault;
  let written = 0;
  const list = await ws.listWorkspace({ includeAssets: false });
  for (const e of list) {
    if (!still()) break;
    const seen = `${vault}|${e.path}`;
    if (ws.isAssetName(e.path) || vaultSeen.get(seen) === e.modified) continue;
    try {
      const content = await backend.readText(e.path);
      if (!still()) break;
      if (await recordSnapshot(e.path, content, "vault", Date.now(), vault)) written++;
      vaultSeen.set(seen, e.modified);
    } catch (err) {
      log.warn("[auto-backup] vault snapshot skipped", e.path, (err as Error).message);
    }
  }
  return written;
}

let vaultTimer: ReturnType<typeof setInterval> | undefined;
/** Start the ten-minute vault snapshots (first pass after one minute). */
export function startVaultSnapshots(): () => void {
  const first = setTimeout(() => void snapshotVault().catch(() => 0), 60_000);
  vaultTimer = setInterval(() => void snapshotVault().catch(() => 0), VAULT_SNAPSHOT_EVERY_MS);
  return () => {
    clearTimeout(first);
    if (vaultTimer) clearInterval(vaultTimer);
    vaultTimer = undefined;
  };
}
