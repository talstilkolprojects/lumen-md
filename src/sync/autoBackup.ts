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
import { historyKey, recordSnapshot } from "../storage/history";

const AUTO_BACKUP_INTERVAL_MS = 30_000;
const IDLE_CALLBACK_TIMEOUT_MS = 2_000;
export const VAULT_SNAPSHOT_EVERY_MS = 10 * 60_000;

let timer: ReturnType<typeof setTimeout> | undefined;
let snapshotQueue: Array<{ name: string; content: string; ts: number }> = [];
let isWriting = false;
/** The edit the 30 s timer is still waiting on, so a closing tab can save it. */
let pending: { name: string; content: string } | null = null;

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
    if (document.visibilityState === "hidden") {
      flushNow();
      // A vault pass too (plan 3.2) — best effort: a hidden tab usually
      // keeps running long enough; a closed one may cut it short.
      void snapshotVault().catch(() => 0);
    }
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
  pending = { name, content };
  timer = setTimeout(() => {
    timer = undefined;
    pending = null;
    snapshotQueue.push({ name, content, ts: Date.now() });
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
        await recordSnapshot(snapshot.name, snapshot.content, "auto-backup", snapshot.ts);
      } catch (err) {
        log.error("[auto-backup] write failed:", (err as Error).message);
      }
    }
  } finally {
    isWriting = false;
  }
}

/** Last modified time already snapshotted, per vault path. */
const vaultSeen = new Map<string, number>();

/**
 * Snapshot every vault note whose modified time moved since the last
 * pass. Identical content is skipped by the store, so this is cheap when
 * little changed. Returns the number of snapshots written.
 */
export async function snapshotVault(): Promise<number> {
  const ws = await import("../storage/workspace");
  if (!ws.isOPFSAvailable()) return 0;
  let written = 0;
  const list = await ws.listWorkspace({ includeAssets: false });
  for (const e of list) {
    if (ws.isAssetName(e.path) || LEGACY_BACKUP.test(e.path) || vaultSeen.get(e.path) === e.modified) continue;
    try {
      const content = await ws.readWorkspaceFile(e.path);
      if (await recordSnapshot(e.path, content, "vault")) written++;
      vaultSeen.set(e.path, e.modified);
    } catch (err) {
      log.warn("[auto-backup] vault snapshot skipped", e.path, (err as Error).message);
    }
  }
  return written;
}

/** A file the auto-backup used to write into the vault: `backups/<folder>/<ms>.md`. */
const LEGACY_BACKUP = /^backups\/([^/]+)\/(\d{10,})\.md$/;

/**
 * Folder name the old auto-backup gave a document: a readable part plus a
 * hash of the full name (kept to match old folders to their notes).
 */
export function backupDirName(name: string): string {
  let h = 0x811c9dc5;
  for (const ch of name.normalize("NFC")) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const readable = name
    .normalize("NFC")
    .replace(/\.(md|markdown)$/i, "")
    .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return `${readable || "note"}-${h.toString(16).padStart(8, "0")}`;
}

/**
 * Move the old `backups/` folder of the vault into the history store (plan
 * 3.2): every `backups/<folder>/<timestamp>.md` becomes a version of the
 * note the folder belonged to (matched by the folder's name hash, else by
 * its readable name), with its original time. When every file was copied,
 * the folder goes to the trash (restorable for 30 days). Returns the number
 * of versions imported.
 */
export async function migrateLegacyBackups(): Promise<number> {
  const ws = await import("../storage/workspace");
  if (!ws.isOPFSAvailable() || !(await ws.workspaceHasEntry("backups"))) return 0;
  const all = await ws.listWorkspace({ includeAssets: true });
  const legacy = all.filter((e) => LEGACY_BACKUP.test(e.path));
  if (!legacy.length) return 0;
  const notes = all.map((e) => e.path).filter((p) => !p.startsWith("backups/") && /\.(md|markdown)$/i.test(p));
  const byFolder = new Map(notes.map((p) => [backupDirName(p), p]));
  // Before the hash (T26), the folder was the name with `[^\w.-]` → `_`,
  // extension included: match it against the notes' paths and names too.
  const legacyName = (s: string) => s.replace(/[^\w.-]/g, "_");
  for (const p of notes) {
    const base = p.split("/").pop() ?? p;
    // A note opened by name (Graph View) was backed up under its basename's hash.
    for (const k of [backupDirName(base), legacyName(p), legacyName(base)]) if (!byFolder.has(k)) byFolder.set(k, p);
  }
  const keyFor = (folder: string) => {
    const known = byFolder.get(folder);
    if (known) return known;
    // A note that's gone: keep the folder's readable name, adding `.md` only when missing.
    const readable = folder.replace(/-[0-9a-f]{8}$/, "");
    return /\.(md|markdown)$/i.test(readable) ? readable : `${readable}.md`;
  };
  const versions = legacy
    .map((e) => {
      const m = LEGACY_BACKUP.exec(e.path)!;
      return { path: e.path, key: keyFor(m[1]), ts: Number(m[2]) };
    })
    .sort((a, b) => a.ts - b.ts);
  let imported = 0;
  let failed = 0;
  for (const v of versions) {
    try {
      if (await recordSnapshot(v.key, await ws.readWorkspaceFile(v.path), "migrated", v.ts)) imported++;
    } catch (err) {
      failed++;
      log.warn("[history] backup not migrated", v.path, (err as Error).message);
    }
  }
  // Only a folder that held nothing but old backups, all copied, leaves the vault.
  const others = all.some((e) => e.path.startsWith("backups/") && !LEGACY_BACKUP.test(e.path));
  if (!failed && !others) {
    const { moveToTrash } = await import("../storage/trash");
    await moveToTrash(["backups"], { backups: "directory" });
    window.dispatchEvent(new Event("lumen-workspace-changed"));
  }
  return imported;
}

let vaultTimer: ReturnType<typeof setInterval> | undefined;
/** Start the ten-minute vault snapshots (first pass after one minute, after migrating old backups). */
export function startVaultSnapshots(): () => void {
  const first = setTimeout(
    () =>
      void migrateLegacyBackups()
        .catch((e) => log.warn("[history] backup migration failed", (e as Error).message))
        .then(() => snapshotVault())
        .catch(() => 0),
    60_000,
  );
  vaultTimer = setInterval(() => void snapshotVault().catch(() => 0), VAULT_SNAPSHOT_EVERY_MS);
  return () => {
    clearTimeout(first);
    if (vaultTimer) clearInterval(vaultTimer);
    vaultTimer = undefined;
  };
}
