/**
 * Where the vault lives (plan 4.2): the browser's private storage (OPFS) or
 * a real folder on the user's computer, opened with `showDirectoryPicker`
 * (Chromium: Chrome, Edge, Opera). The folder is a directory-handle vault
 * backend (./handleBackend.ts) — the same code and the same contract as OPFS.
 *
 * - The chosen location is remembered in IndexedDB (a directory handle is
 *   structured-cloneable). On start the folder's permission is checked; when
 *   the browser wants a click first, the vault reports "disconnected" (no
 *   reads, no writes — never a silent fallback to another store) until the
 *   user presses "Reconnect folder" or chooses browser storage.
 * - Moving between locations copies every file, reads each copy back and
 *   compares it byte for byte, checks the whole set once more, and only then
 *   switches. The source is never deleted. Files already at the target with
 *   different content stop the move before anything is written. Progress is
 *   recorded, so an interrupted move (tab closed, quota) resumes where it
 *   stopped instead of starting over.
 */

import { get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";
import { log } from "../../lib/logger";
import { notifyWorkspaceChanged } from "../workspaceEvents";
import { getVaultBackend, setVaultBackend } from "./index";
import { createDirectoryHandleBackend } from "./handleBackend";
import { createOpfsBackend } from "./opfs";
import type { VaultBackend } from "./types";
import { createTauriBackend, isDesktopApp, loadTauriInvoke, type TauriInvoke } from "./tauri";
import { observeDirectoryHandle, watchExternalChanges } from "./watcher";

// ── Persistence ──────────────────────────────────────────────────────────

/** Where the vault is, as stored. */
export type StoredLocation =
  | { kind: "opfs" }
  | { kind: "folder"; handle: FileSystemDirectoryHandle; name: string }
  /** Desktop app (plan 4.3): the folder the Rust side holds; `root` is its absolute path. */
  | { kind: "desktop"; root: string; name: string };

/** An unfinished move, as stored. */
export interface MoveRecord {
  from: StoredLocation;
  to: StoredLocation;
  startedAt: number;
  /**
   * Files this move wrote to the target, with the SHA-256 of what it wrote.
   * A resume may overwrite such a file only while it still holds exactly
   * those bytes; one changed since (edited in the folder) is a conflict.
   */
  written: Record<string, string>;
  total: number;
}

interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

const LOCATION_KEY = "lumen-vault-location";
const MOVE_KEY = "lumen-vault-move";
const LAST_MOVE_KEY = "lumen-vault-last-move";

/** The last completed move: what it copied (path → SHA-256) from where to where. */
interface LastMove {
  from: StoredLocation;
  to: StoredLocation;
  copied: Record<string, string>;
}

let kv: KV = { get: (k) => idbGet(k), set: (k, v) => idbSet(k, v), del: (k) => idbDel(k) };

/** @internal tests: a key-value store that keeps fake handles as they are. */
export function __setLocationStore(store: KV): void {
  kv = store;
}

// ── Status ───────────────────────────────────────────────────────────────

export type VaultStatus =
  | { location: "opfs" }
  | { location: "folder"; name: string }
  /** The vault is a folder the browser wants a click to reopen. */
  | { location: "folder-disconnected"; name: string }
  /** Start-up is still finding out where the vault is: closed until then. */
  | { location: "restoring" };

export interface MoveProgress {
  done: number;
  total: number;
  to: string;
}

let status: VaultStatus = { location: "opfs" };
let pending: MoveRecord | null = null;
let progress: MoveProgress | null = null;
let disconnected: { name: string; connect(): Promise<boolean> } | null = null;
/** Desktop app with no vault folder chosen yet: the first-run prompt shows. */
let desktopFirstRun = false;
let desktopInvoke: TauriInvoke | null = null;

/** @internal tests: the stand-in for the app's Rust vault commands. */
export function __setDesktopInvoke(inv: TauriInvoke | null): void {
  desktopInvoke = inv;
}

async function desktop(): Promise<TauriInvoke> {
  desktopInvoke ??= await loadTauriInvoke();
  return desktopInvoke;
}

/** On first launch of the desktop app, the user is asked for the vault folder. */
export function isDesktopFirstRun(): boolean {
  return desktopFirstRun;
}

/** The last segment of an absolute path, either separator. */
function folderName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}
const listeners = new Set<() => void>();

function changed(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      log.warn("vault status listener failed", err);
    }
  }
}

export function getVaultStatus(): VaultStatus {
  return status;
}
/** The interrupted move waiting to be resumed, if any. */
export function getPendingMove(): MoveRecord | null {
  return pending;
}
/** The move in progress, if any. */
export function getMoveProgress(): MoveProgress | null {
  return progress;
}
export function onVaultStatusChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ── Folders ──────────────────────────────────────────────────────────────

type PickerWindow = Window & { showDirectoryPicker?: (o?: { id?: string; mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle> };

/** Can this browser open a real folder? (Chromium yes; Firefox and Safari no.) */
export function isFolderVaultSupported(): boolean {
  return typeof window !== "undefined" && typeof (window as PickerWindow).showDirectoryPicker === "function";
}

/** Ask the user for a folder (null when they cancel). */
export async function pickVaultFolder(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) return null;
  try {
    // A WebIDL method: it must be called on `window`.
    return await picker.call(window, { id: "lumen-vault", mode: "readwrite" });
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") return null;
    throw e;
  }
}

/**
 * Is read-write access to `handle` granted? With `request`, ask for it —
 * which the browser allows only during a user gesture (a click).
 */
export async function ensureFolderPermission(handle: FileSystemDirectoryHandle, request: boolean): Promise<boolean> {
  const h = handle as FileSystemDirectoryHandle & {
    queryPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState>;
    requestPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState>;
  };
  // Engines without the permission API (and fake handles) are always granted.
  if (typeof h.queryPermission !== "function") return true;
  if ((await h.queryPermission({ mode: "readwrite" })) === "granted") return true;
  if (!request || typeof h.requestPermission !== "function") return false;
  return (await h.requestPermission({ mode: "readwrite" })) === "granted";
}

/** A vault backend on a folder; `available()` follows `connected()`. */
export function createFolderBackend(handle: FileSystemDirectoryHandle, connected: () => boolean = () => true): VaultBackend {
  return createDirectoryHandleBackend({
    id: "folder",
    available: connected,
    root: async () => {
      if (!connected()) throw new Error(`The vault folder “${handle.name}” is not connected. Reconnect it first.`);
      return handle;
    },
  });
}

function backendFor(loc: StoredLocation): VaultBackend {
  if (loc.kind === "opfs") return createOpfsBackend();
  if (loc.kind === "desktop") {
    if (!desktopInvoke) throw new Error("The desktop vault is not ready.");
    return createTauriBackend(desktopInvoke, loc.root);
  }
  return createFolderBackend(loc.handle);
}

function nameOf(loc: StoredLocation): string {
  return loc.kind === "opfs" ? "" : loc.name;
}

let onVaultReplaced: () => void = () => {};
/**
 * Called when the vault is replaced by a different one without copying
 * (open a folder, use browser storage): open notes belong to the old vault,
 * so the app detaches them instead of autosaving them over the new one.
 */
export function setOnVaultReplaced(fn: () => void): void {
  onVaultReplaced = fn;
}

let stopWatching: (() => void) | null = null;

/**
 * Watch a folder vault for changes made outside Lumen (plan 4.4). OPFS is
 * private to this origin: nothing else writes it, so it is not watched.
 */
function watch(loc: StoredLocation, backend: VaultBackend): void {
  stopWatching?.();
  stopWatching = null;
  if (loc.kind === "folder") {
    const handle = loc.handle;
    const hasObserver = typeof (globalThis as { FileSystemObserver?: unknown }).FileSystemObserver === "function";
    stopWatching = watchExternalChanges(backend, {
      observe: (poke) => observeDirectoryHandle(handle, poke),
      // The observer reports changes at once; polling is the backstop.
      intervalMs: hasObserver ? 5000 : 1000,
    });
  } else if (loc.kind === "desktop" && desktopInvoke) {
    const inv = desktopInvoke;
    const root = loc.root;
    stopWatching = watchExternalChanges(backend, {
      snapshot: async () => {
        const list = await inv<{ path: string; size: number; mtime: number }[]>("vault_snapshot", { root });
        return new Map(list.map((e) => [e.path, { size: e.size, mtime: e.mtime }]));
      },
      intervalMs: 1000,
    });
  }
}

function activate(loc: StoredLocation, backend: VaultBackend): void {
  disconnected = null;
  if (loc.kind !== "opfs") desktopFirstRun = false;
  setVaultBackend(loc.kind === "opfs" ? null : backend);
  watch(loc, backend);
  status = loc.kind === "opfs" ? { location: "opfs" } : { location: "folder", name: loc.name };
  notifyWorkspaceChanged({ kind: "structure" });
  changed();
}

// ── Start-up ─────────────────────────────────────────────────────────────

/**
 * Restore the stored location before the app reads the vault. A folder whose
 * permission needs a click becomes "folder-disconnected": its backend is
 * active but unavailable, so nothing is read from or written to anywhere
 * else in the meantime.
 */
export async function restoreVaultLocation(): Promise<VaultStatus> {
  try {
    pending = (await kv.get<MoveRecord>(MOVE_KEY)) ?? null;
    const loc = await kv.get<StoredLocation>(LOCATION_KEY);
    if (!loc || loc.kind === "opfs") {
      // Replaces the closed start-up vault (if any) with OPFS.
      if (getVaultBackend().id !== "opfs") activate({ kind: "opfs" }, createOpfsBackend());
      // First launch of the desktop app: ask where the vault lives.
      desktopFirstRun = !loc && isDesktopApp();
      return status;
    }
    if (loc.kind === "desktop") {
      const inv = await desktop();
      const root = await inv<string | null>("vault_root");
      if (root && root === loc.root) {
        activate(loc, createTauriBackend(inv, root));
        return status;
      }
      // The folder moved or the app's config was lost: closed until the
      // user picks the folder again.
      let open = false;
      setVaultBackend(createTauriBackend(inv, loc.root, { available: () => open }));
      disconnected = {
        name: loc.name,
        connect: async () => {
          const picked = await inv<string | null>("vault_pick_folder");
          if (!picked) return false;
          const next: StoredLocation = { kind: "desktop", root: picked, name: folderName(picked) };
          await inv("vault_use", { root: picked });
          await kv.set(LOCATION_KEY, next);
          open = true;
          activate(next, createTauriBackend(inv, picked));
          return true;
        },
      };
      status = { location: "folder-disconnected", name: loc.name };
      changed();
      return status;
    }
    if (await ensureFolderPermission(loc.handle, false)) {
      activate(loc, createFolderBackend(loc.handle));
      return status;
    }
    let granted = false;
    const handle = loc.handle;
    const name = loc.name;
    const folderBackend = createFolderBackend(handle, () => granted);
    setVaultBackend(folderBackend);
    disconnected = {
      name,
      connect: async () => {
        if (!(await ensureFolderPermission(handle, true))) return false;
        granted = true;
        disconnected = null;
        watch(loc, folderBackend);
        status = { location: "folder", name };
        notifyWorkspaceChanged({ kind: "structure" });
        changed();
        return true;
      },
    };
    status = { location: "folder-disconnected", name: loc.name };
    changed();
  } catch (err) {
    log.warn("restoring the vault location failed; using browser storage", err);
    if (getVaultBackend().id === "restoring") activate({ kind: "opfs" }, createOpfsBackend());
  } finally {
    changed();
  }
  return status;
}

/**
 * Start-up: restore the location, waiting at most `ms`. If that is not
 * enough (a slow IndexedDB or permission check), the vault stays closed —
 * an unavailable backend, status "restoring" — until the restore finishes,
 * so nothing is read from or written to a store that may be the wrong one.
 */
export async function restoreVaultLocationWithin(ms: number): Promise<VaultStatus> {
  let done = false;
  const restoring = restoreVaultLocation().finally(() => (done = true));
  const timedOut = await Promise.race([restoring.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), ms))]);
  if (timedOut && !done) {
    if (getVaultBackend().id !== "restoring") {
      setVaultBackend(
        createDirectoryHandleBackend({
          id: "restoring",
          available: () => false,
          root: async () => {
            throw new Error("The vault is still opening.");
          },
        }),
      );
    }
    status = { location: "restoring" };
    changed();
  }
  return status;
}

/** "Reconnect folder" (call from a click). True when the folder is open again. */
export async function reconnectVaultFolder(): Promise<boolean> {
  const d = disconnected;
  if (!d) return status.location === "folder";
  return d.connect();
}

/**
 * Desktop: the user picks the vault folder in the native dialog. When the
 * app storage (the WebView's OPFS) holds notes, they are first backed up (a
 * zip in the app's data folder), then moved with the same copy → byte check
 * → switch as the web build — the app storage is never deleted, and an
 * interrupted move resumes. Null when the user cancelled.
 */
export async function chooseDesktopVaultFolder(): Promise<(MoveReport & { backup: string | null }) | null> {
  const inv = await desktop();
  const root = await inv<string | null>("vault_pick_folder");
  if (!root) return null;
  const to: StoredLocation = { kind: "desktop", root, name: folderName(root) };
  const source = getVaultBackend();
  // Only a listing that succeeds and is empty skips the migration: a source
  // that cannot be read stops here, it is not "empty".
  if (!source.available()) throw new Error("The current vault is not available.");
  const hasNotes = (await source.list("")).length > 0;
  if (!hasNotes) {
    await inv("vault_use", { root });
    await kv.set(LOCATION_KEY, to);
    activate(to, createTauriBackend(inv, root));
    return { files: 0, bytes: 0, unchanged: 0, trashed: 0, backup: null };
  }
  const backup = await backupCurrentVault(inv);
  return { ...(await moveVault(to)), backup };
}

/** A zip of the current vault, kept by the desktop app (its data folder). */
async function backupCurrentVault(inv: TauriInvoke): Promise<string> {
  const { exportVaultZip } = await import("../exportAll");
  const { bytes } = await exportVaultZip();
  const name = `vault-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
  return inv<string>("vault_backup", bytes, { headers: { "x-backup-name": encodeURIComponent(name) } });
}

/** Desktop: work in a folder the user picks, without copying (e.g. an existing Obsidian vault). */
export async function openDesktopFolderAsVault(): Promise<string | null> {
  const inv = await desktop();
  const root = await inv<string | null>("vault_pick_folder");
  if (!root) return null;
  const loc: StoredLocation = { kind: "desktop", root, name: folderName(root) };
  await inv("vault_use", { root });
  await kv.set(LOCATION_KEY, loc);
  await cancelPendingMove(); // its source is no longer the vault
  onVaultReplaced();
  activate(loc, createTauriBackend(inv, root));
  return loc.name;
}

/** Desktop: "Not now" on the first-run prompt (asked again on the next launch). */
export function dismissDesktopFirstRun(): void {
  desktopFirstRun = false;
  changed();
}

/** Work in browser storage (OPFS) from now on, without copying anything. */
/** Desktop: the vault no longer lives in a folder — the app forgets it (the folder is not touched). */
async function releaseDesktopFolder(): Promise<void> {
  if (!isDesktopApp()) return;
  await (await desktop())("vault_forget").catch((err) => log.warn("forgetting the desktop vault folder failed", err));
}

export async function switchToBrowserStorage(): Promise<void> {
  await releaseDesktopFolder();
  await kv.set(LOCATION_KEY, { kind: "opfs" } satisfies StoredLocation);
  await cancelPendingMove(); // its source is no longer the vault
  onVaultReplaced();
  activate({ kind: "opfs" }, createOpfsBackend());
}

/** Work in `handle` from now on, without copying anything (e.g. an existing Obsidian vault). */
export async function openFolderAsVault(handle: FileSystemDirectoryHandle): Promise<boolean> {
  if (!(await ensureFolderPermission(handle, true))) return false;
  const loc: StoredLocation = { kind: "folder", handle, name: handle.name };
  await releaseDesktopFolder();
  await kv.set(LOCATION_KEY, loc);
  await cancelPendingMove(); // its source is no longer the vault
  onVaultReplaced();
  activate(loc, createFolderBackend(handle));
  return true;
}

// ── Moving ───────────────────────────────────────────────────────────────

/** Files at the target that already exist with different content: nothing was written. */
export class VaultMoveConflictError extends Error {
  constructor(readonly paths: string[]) {
    super(`${paths.length} file(s) already exist at the target with different content: ${paths.slice(0, 3).join(", ")}`);
    this.name = "VaultMoveConflictError";
  }
}

/** The browser did not grant read-write access to the folder. */
export class VaultPermissionError extends Error {
  constructor(readonly folder: string) {
    super(`No permission to edit “${folder}”`);
    this.name = "VaultPermissionError";
  }
}

export interface MoveReport {
  files: number;
  bytes: number;
  /** Files already identical at the target (a resume, or a merge into an existing folder). */
  unchanged: number;
  /**
   * Moving back: copies an earlier move left at the target whose notes were
   * deleted since, put in the trash (restorable) instead of reappearing.
   */
  trashed: number;
}

/** Every file path of `b`, dot entries (the trash) included. */
async function allFiles(b: VaultBackend, dir = "", out: string[] = []): Promise<string[]> {
  for (const e of await b.list(dir)) {
    if (e.kind === "directory") await allFiles(b, e.path, out);
    else out.push(e.path);
  }
  return out;
}

async function bytes(b: VaultBackend, path: string): Promise<Uint8Array> {
  return new Uint8Array(await (await b.read(path)).arrayBuffer());
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function targetBytes(b: VaultBackend, path: string): Promise<Uint8Array | null> {
  const st = await b.stat(path);
  if (!st) return null;
  if (st.kind !== "file") throw new VaultMoveConflictError([path]);
  return bytes(b, path);
}

/**
 * Move the vault from where it is now to `to`: copy, verify byte for byte,
 * then switch. The source is left as it was. Resumes a recorded move to the
 * same target. Throws `VaultMoveConflictError` (nothing written) when the
 * target holds different files at the same paths.
 */
export async function moveVault(
  to: StoredLocation,
  opts: { onProgress?: (p: MoveProgress) => void; from?: StoredLocation } = {},
): Promise<MoveReport> {
  // First, while the click that started this still counts as a user gesture.
  if (to.kind === "folder" && !(await ensureFolderPermission(to.handle, true))) {
    throw new VaultPermissionError(to.name);
  }
  if (to.kind === "desktop") await desktop();
  const fromLoc: StoredLocation = opts.from ?? ((await kv.get<StoredLocation>(LOCATION_KEY)) || { kind: "opfs" });
  const source = getVaultBackend();
  if (!source.available()) throw new Error("The current vault is not available.");
  if (await sameLocation(fromLoc, to)) throw new Error("The vault is already there.");
  const target = backendFor(to);
  // A resume continues the same move: same target *and* same source.
  const resuming = pending && (await sameLocation(pending.to, to)) && (await sameLocation(pending.from, fromLoc)) ? pending : null;
  const written: Record<string, string> = { ...(resuming?.written ?? {}) };
  // Moving back to where the vault came from: the copies left there by
  // that move are known (same hash) and may be replaced, not conflicts.
  const last = await kv.get<LastMove>(LAST_MOVE_KEY);
  const leftBehind = last && (await sameLocation(last.from, to)) && (await sameLocation(last.to, fromLoc)) ? last.copied : {};
  const known = (path: string, hash: string) => written[path] === hash || leftBehind[path] === hash;
  const report = (done: number, total: number) => {
    progress = { done, total, to: nameOf(to) };
    opts.onProgress?.(progress);
    changed();
  };

  try {
    const files = (await allFiles(source)).sort();
    report(0, files.length);

    // 1. Nothing is written while any target file differs and is not ours.
    //    What each target path holds now is remembered: if it changes while
    //    the copy runs (another app editing the folder), the move stops.
    const conflicts: string[] = [];
    const before = new Map<string, string | null>();
    for (const path of files) {
      const there = await targetBytes(target, path).catch((e) => {
        if (e instanceof VaultMoveConflictError) return "conflict" as const;
        throw e;
      });
      if (there === "conflict") {
        conflicts.push(path);
        continue;
      }
      const hash = there ? await sha256(there) : null;
      before.set(path, hash);
      if (there && hash && !same(there, await bytes(source, path)) && !known(path, hash)) conflicts.push(path);
    }
    if (conflicts.length) throw new VaultMoveConflictError(conflicts);

    const record: MoveRecord = { from: fromLoc, to, startedAt: resuming?.startedAt ?? Date.now(), written, total: files.length };
    await kv.set(MOVE_KEY, record);
    pending = record;

    // 2. Copy each file and read it back.
    let total = 0;
    let unchanged = 0;
    const copied: Record<string, string> = {};
    for (const [i, path] of files.entries()) {
      const data = await bytes(source, path);
      total += data.byteLength;
      copied[path] = await sha256(data);
      const there = await targetBytes(target, path);
      if ((there ? await sha256(there) : null) !== before.get(path)) throw new VaultMoveConflictError([path]);
      if (there && same(there, data)) {
        unchanged++;
      } else {
        await target.write(path, data);
        if (!same(await bytes(target, path), data)) throw new Error(`The copy of “${path}” does not match the original.`);
        written[path] = copied[path];
        await kv.set(MOVE_KEY, record);
      }
      report(i + 1, files.length);
    }

    // 3. The whole set once more — and no file added to the source meanwhile
    //    (a note saved during the move) — then switch.
    const now = (await allFiles(source)).sort();
    if (now.length !== files.length || now.some((p, i) => p !== files[i])) {
      throw new Error("Files were added or removed while the vault was moving; resume to copy them too.");
    }
    for (const path of files) {
      const there = await targetBytes(target, path);
      if (!there || !same(there, await bytes(source, path))) throw new Error(`“${path}” changed or went missing during the move; resume to copy it again.`);
    }
    // The desktop app remembers its folder too (or forgets it when the vault leaves it).
    if (to.kind === "desktop") await (await desktop())("vault_use", { root: to.root });
    else await releaseDesktopFolder();
    await kv.set(LOCATION_KEY, to);
    await kv.set(LAST_MOVE_KEY, { from: fromLoc, to, copied } satisfies LastMove);
    await kv.del(MOVE_KEY);
    pending = null;
    progress = null;
    activate(to, target);

    // Copies this vault left here earlier and that were deleted since (they
    // are not in the source any more) would come back to life: they go to
    // the trash of the vault that is now active — restorable, not deleted.
    const stale: string[] = [];
    for (const [path, hash] of Object.entries(leftBehind)) {
      if (copied[path]) continue;
      const there = await targetBytes(target, path).catch(() => null);
      if (there && (await sha256(there)) === hash) stale.push(path);
    }
    let trashed = 0;
    if (stale.length) {
      const { moveToTrash } = await import("../trash");
      trashed = (await moveToTrash(stale, Object.fromEntries(stale.map((p) => [p, "file" as const])))).length;
      notifyWorkspaceChanged({ kind: "structure" });
    }
    return { files: files.length, bytes: total, unchanged, trashed };
  } catch (e) {
    progress = null;
    changed();
    throw e;
  }
}

/** Drop the record of an interrupted move. The files it copied stay where they are. */
export async function cancelPendingMove(): Promise<void> {
  await kv.del(MOVE_KEY);
  pending = null;
  changed();
}

async function sameLocation(a: StoredLocation, b: StoredLocation): Promise<boolean> {
  if (a.kind === "opfs" || b.kind === "opfs") return a.kind === b.kind;
  if (a.kind === "desktop" || b.kind === "desktop") return a.kind === "desktop" && b.kind === "desktop" && a.root === b.root;
  if (a.handle === b.handle) return true;
  const f = (a.handle as { isSameEntry?: (o: FileSystemHandle) => Promise<boolean> }).isSameEntry;
  return typeof f === "function" ? await f.call(a.handle, b.handle).catch(() => false) : false;
}

/** @internal tests */
export function __resetVaultLocation(): void {
  stopWatching?.();
  stopWatching = null;
  onVaultReplaced = () => {};
  status = { location: "opfs" };
  pending = null;
  progress = null;
  disconnected = null;
  desktopFirstRun = false;
  desktopInvoke = null;
  setVaultBackend(null);
}
