/**
 * Reconcile the open notes with changes made outside Lumen (plan 4.4).
 *
 * The vault watcher (src/storage/vault/watcher.ts) reports external writes,
 * deletes and renames; the index and the file tree already follow them (an
 * external event is announced as a structural workspace change). This module
 * keeps the open tabs right:
 *
 * - **changed on disk, tab has no unsaved edit** → the tab shows the new text;
 * - **changed on disk, tab has an unsaved edit** → a conflict. The version on
 *   disk is first kept as a sibling file (`name (changed outside Lumen …).md`)
 *   so nothing is lost whatever the user picks, saving stops for that note,
 *   and the three-way conflict dialog (the one cloud sync uses) offers
 *   mine / theirs / a merge;
 * - **renamed on disk** → the tab follows the new path;
 * - **deleted on disk** → the tab stays open with its text, marked unsaved
 *   and detached from the path, so autosave does not bring the file back
 *   behind the user's back.
 *
 * Saving is compare-and-swap: before autosave writes a note, it checks the
 * file still holds what Lumen last saw there (`known`). If another program
 * changed it in the meantime — even before the watcher noticed — the save
 * becomes the same conflict instead of overwriting that change.
 */

import { log } from "../lib/logger";
import { t } from "../i18n";
import { readWorkspaceFile, uniqueWorkspaceName, workspaceHasFile, writeWorkspaceFile, deleteWorkspaceFile } from "../storage/workspace";
import { getVaultBackend, watchVault, type VaultEvent } from "../storage/vault";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { flushPendingEdits, tabIdOf, useAppStore } from "./useStore";
import { syncOpenDocsAfterMove } from "./openDocs";
import { movedPath } from "../storage/fileOps";
import { isSealedNote, lockedNotes } from "../storage/lockedNotesRegistry";

/** What Lumen last saw in each open note's file (read or written). */
const known = new Map<string, string>();

/**
 * A hash of what Lumen last saw on disk per note, kept across restarts
 * (localStorage): a note restored with unsaved edits, or changed by another
 * program while Lumen was closed, is checked against it instead of being
 * saved over blindly.
 */
const HASH_KEY = "lumen-vault-known";
let hashes: Record<string, string> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** FNV-1a (32-bit) — change detection, not security. */
export function textHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function diskHashes(): Record<string, string> {
  if (hashes) return hashes;
  try {
    const raw = localStorage.getItem(HASH_KEY);
    hashes = raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    hashes = {};
  }
  return hashes;
}

function persistHashes(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      localStorage.setItem(HASH_KEY, JSON.stringify(diskHashes()));
    } catch {
      /* why: storage full / blocked: the in-memory base still works this session */
    }
  }, 300);
}

/** `content` is what the file at `path` holds now. */
function noteDisk(path: string, content: string): void {
  // W5.11: an unlocked note with its own password is sealed on disk; the base is the sealed text.
  if (lockedNotes.has(path) && !isSealedNote(content)) content = lockedNotes.sealed(path) ?? content;
  known.set(path, content);
  diskHashes()[path] = textHash(content);
  persistHashes();
}

/**
 * Lumen itself just wrote `content` to `path` outside an open note's save
 * (quick capture appending to inbox.md, plan 4.16): that text is the new
 * base, so the open copy's next save is not taken for a change made outside
 * Lumen.
 */
export function noteOwnWrite(path: string, content: string): void {
  noteDisk(path, content);
}

/** Forget (or move) what is known about `prefix` and everything under it. */
function forgetDisk(prefix: string, movedTo?: string): void {
  const h = diskHashes();
  const under = (p: string) => p === prefix || p.startsWith(prefix + "/");
  for (const p of [...known.keys()]) {
    if (!under(p)) continue;
    const v = known.get(p)!;
    known.delete(p);
    if (movedTo) known.set(movedTo + p.slice(prefix.length), v);
  }
  for (const p of Object.keys(h)) {
    if (!under(p)) continue;
    const v = h[p];
    delete h[p];
    if (movedTo) h[movedTo + p.slice(prefix.length)] = v;
  }
  persistHashes();
}
/** Notes whose saving waits for a conflict to be resolved. */
const conflicted = new Set<string>();
/** The running resolution of each conflict. */
const resolving = new Map<string, Promise<void>>();

/** Resolves once no conflict is pending for `path`. */
export function whenResolved(path: string): Promise<void> {
  return resolving.get(path) ?? Promise.resolve();
}

export type ConflictResolver = (o: { path: string; base: string; local: string; remote: string }) => Promise<
  { kind: "merged"; content: string } | { kind: "local" } | { kind: "remote" } | null
>;

/** The conflict dialog; tests replace it. */
let resolveConflict: ConflictResolver = async (o) => {
  const { openConflictDialog } = await import("../sync/cloud/ConflictDialog");
  return openConflictDialog({
    ...o,
    labels: {
      title: t("external.conflict.title", { path: o.path }),
      description: t("external.conflict.body"),
      local: t("external.conflict.mine"),
      remote: t("external.conflict.theirs"),
      takeLocal: t("external.conflict.takeMine"),
      takeRemote: t("external.conflict.takeTheirs"),
      merge: t("external.conflict.merge"),
      cancel: t("external.conflict.keepMine"),
    },
  });
};

let toast: (message: string, type?: "info" | "error") => void = (message, type = "info") => {
  void import("../ui/AiToast").then((m) => m.showAiToast(message, type));
};

/** @internal tests */
export function __setConflictUi(r: ConflictResolver, notify?: typeof toast): void {
  resolveConflict = r;
  if (notify) toast = notify;
}

/** @internal tests */
export function __resetExternalChanges(): void {
  known.clear();
  conflicted.clear();
  hashes = {};
  try {
    localStorage.removeItem(HASH_KEY);
  } catch {
    /* why: storage denied: nothing was persisted to clear */
  }
}

/** The open notes (the active one and every tab) bound to a vault path. */
function openPaths(): Map<string, { content: string; dirty: boolean }> {
  const s = useAppStore.getState();
  const out = new Map<string, { content: string; dirty: boolean }>();
  for (const tab of s.openTabs) if (tab.workspaceName) out.set(tab.workspaceName, { content: tab.content, dirty: tab.dirty });
  if (s.doc.workspaceName) out.set(s.doc.workspaceName, { content: s.doc.content, dirty: s.doc.dirty });
  return out;
}

/** Replace a note's text in the store (the editor follows), as saved. */
function showFromDisk(path: string, content: string): void {
  useAppStore.setState((state) => {
    const doc = state.doc.workspaceName === path ? { ...state.doc, content, dirty: false } : state.doc;
    const openTabs = state.openTabs.map((tab) => (tab.workspaceName === path ? { ...tab, content, dirty: false } : tab));
    return { doc, openTabs };
  });
}

function setLocal(path: string, content: string, dirty: boolean): void {
  useAppStore.setState((state) => {
    const doc = state.doc.workspaceName === path ? { ...state.doc, content, dirty } : state.doc;
    const openTabs = state.openTabs.map((tab) => (tab.workspaceName === path ? { ...tab, content, dirty } : tab));
    return { doc, openTabs };
  });
}

/** `notes/a.md` → `notes/a (changed outside Lumen 2026-10-19 10-30).md`, free. */
async function conflictCopyPath(path: string): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "-");
  const m = /^(.*?)(\.[^./]+)?$/.exec(path)!;
  return uniqueWorkspaceName(`${m[1]} (${t("external.conflict.copyName")} ${stamp})${m[2] ?? ".md"}`);
}

/**
 * The note at `path` has `local` unsaved text and `remote` on disk. Keep the
 * disk version as a copy first (0 loss), then let the user choose.
 */
function conflict(path: string, local: string, remote: string): Promise<void> {
  if (conflicted.has(path)) return whenResolved(path);
  conflicted.add(path);
  const run = resolveOne(path, local, remote)
    .finally(() => {
      conflicted.delete(path);
      resolving.delete(path);
    })
    .then((next) => {
      // The file changed again while the dialog was open: that newer version
      // is a new conflict (with its own copy), never overwritten by the
      // answer given about the older one.
      if (next === "deleted") return onExternal({ type: "delete", path, origin: "external" });
      if (next) return conflict(path, next.local, next.remote);
    });
  resolving.set(path, run);
  return run;
}

/** The disk's text at `path`, or null when the file is gone. */
async function diskText(path: string): Promise<string | null> {
  if (!(await workspaceHasFile(path))) return null;
  return readWorkspaceFile(path).catch(() => null);
}

type Restart = { local: string; remote: string } | "deleted" | undefined;

async function resolveOne(path: string, local: string, remote: string): Promise<Restart> {
  try {
    // Typing must not go on behind the dialog.
    (globalThis.document?.activeElement as HTMLElement | null)?.blur?.();
    const copy = await conflictCopyPath(path);
    await writeWorkspaceFile(copy, remote);
    notifyWorkspaceChanged({ kind: "structure", paths: [copy] });
    const base = known.get(path) ?? "";
    const choice = await resolveConflict({ path, base, local, remote });
    flushPendingEdits();
    const current = openPaths().get(path)?.content ?? local;
    // The answer was given about `remote`. If the file changed again in the
    // meantime, the answer must not be written over that newer version.
    const now = await diskText(path);
    if (now === null) return "deleted";
    if (now !== remote) {
      // `remote` is kept in the copy already; the dialog comes back for the newer text.
      noteDisk(path, remote);
      return { local: current, remote: now };
    }
    // If the user kept typing during the dialog, the answer was given about
    // older text: keep the newer text (unsaved; the next save writes it, the
    // other version stays in the copy).
    if (current !== local) {
      noteDisk(path, remote);
      setLocal(path, current, true);
      toast(t("external.conflict.keptTyping", { path: copy }));
      return;
    }
    if (choice?.kind === "remote") {
      noteDisk(path, remote);
      showFromDisk(path, remote);
      await deleteWorkspaceFile(copy).catch(() => undefined); // the file holds it again
      notifyWorkspaceChanged({ kind: "structure", paths: [copy] });
      return;
    }
    const text = choice?.kind === "merged" ? choice.content : current;
    await writeWorkspaceFile(path, text);
    noteDisk(path, text);
    setLocal(path, text, false);
    notifyWorkspaceChanged({ kind: "content", paths: [path] });
    toast(t("external.conflict.keptCopy", { path: copy }));
  } catch (err) {
    log.warn("resolving an external change failed", err);
    toast(t("external.conflict.failed", { path }), "error");
  }
  return undefined;
}

/**
 * Save an open note, unless its file changed outside Lumen since Lumen last
 * saw it: then it becomes a conflict (nothing is overwritten). True when the
 * text is on disk.
 */
export async function saveOpenNote(path: string, content: string): Promise<boolean> {
  if (conflicted.has(path)) return false;
  const base = known.get(path);
  const stored = diskHashes()[path];
  if ((base !== undefined && base !== content) || (base === undefined && stored !== undefined)) {
    if (!(await workspaceHasFile(path))) {
      // The file Lumen knew is gone: deleted or renamed outside Lumen. The
      // watcher's event decides (detach / follow) — never recreate it here.
      return false;
    }
    const disk = await readWorkspaceFile(path).catch(() => null);
    if (disk !== null && disk !== content) {
      const changed = base !== undefined ? disk !== base : textHash(disk) !== stored;
      if (changed) {
        void conflict(path, content, disk);
        return false;
      }
    }
  }
  await writeWorkspaceFile(path, content);
  noteDisk(path, content);
  return true;
}

/**
 * Start-up: compare the open notes (restored from the last session) with
 * what is on disk now. A note changed outside Lumen while it was closed is
 * reloaded, or becomes a conflict if it has unsaved edits; one deleted is
 * detached.
 */
export async function reconcileOpenNotes(): Promise<void> {
  const vault = getVaultBackend();
  // A closed vault (start-up, a folder waiting for a click) tells nothing.
  if (!vault.available()) return;
  for (const [path, note] of openPaths()) {
    const stored = diskHashes()[path];
    let st;
    try {
      st = await vault.stat(path);
    } catch {
      continue; // unreadable now: not evidence of a delete
    }
    if (!st) {
      if (stored !== undefined) await onExternal({ type: "delete", path, origin: "external" });
      continue;
    }
    const disk = await readWorkspaceFile(path).catch(() => null);
    if (disk === null) continue;
    if (stored === undefined) {
      // Nothing recorded yet (first run): a clean note shows the disk.
      if (!note.dirty && disk !== note.content) showFromDisk(path, disk);
      if (!note.dirty || disk === note.content) noteDisk(path, disk);
      continue;
    }
    if (textHash(disk) !== stored) {
      known.delete(path);
      await onExternal({ type: "write", path, origin: "external" });
    } else {
      noteDisk(path, disk);
    }
  }
}

async function onExternal(e: VaultEvent): Promise<void> {
  const open = openPaths();
  if (e.type === "write") {
    const tab = open.get(e.path);
    if (!tab) {
      forgetDisk(e.path);
      return;
    }
    const disk = await readWorkspaceFile(e.path).catch(() => null);
    if (disk === null || disk === known.get(e.path)) return;
    flushPendingEdits();
    const now = openPaths().get(e.path) ?? tab;
    if (disk === now.content) {
      noteDisk(e.path, disk);
      if (now.dirty) showFromDisk(e.path, disk);
      return;
    }
    if (!now.dirty) {
      noteDisk(e.path, disk);
      showFromDisk(e.path, disk);
      toast(t("external.reloaded", { path: e.path }));
      return;
    }
    await conflict(e.path, now.content, disk);
    return;
  }
  if (e.type === "rename" && e.from) {
    const from = e.from;
    const affected = [...open.keys()].some((p) => movedPath(p, from, e.path) !== null);
    forgetDisk(from, e.path);
    if (affected) {
      syncOpenDocsAfterMove(from, e.path, (c) => c);
      toast(t("external.renamed", { from, to: e.path }));
    }
    return;
  }
  if (e.type === "delete") {
    const gone = [...open.keys()].filter((p) => p === e.path || p.startsWith(e.path + "/"));
    forgetDisk(e.path);
    if (!gone.length) return;
    // Keep the text open and unsaved, not tied to the deleted path.
    flushPendingEdits();
    useAppStore.setState((state) => {
      const detach = <T extends { workspaceName?: string | null; name: string; dirty: boolean }>(d: T): T =>
        d.workspaceName && gone.includes(d.workspaceName) ? { ...d, workspaceName: null, dirty: true } : d;
      const openTabs = state.openTabs.map((tab) => {
        const next = detach(tab);
        return next === tab ? tab : { ...next, id: tabIdOf({ workspaceName: null, name: tab.name }) };
      });
      return { doc: detach(state.doc), openTabs };
    });
    toast(t("external.deleted", { path: gone[0] }));
  }
}

let started: (() => void) | null = null;

/** Start following external changes (idempotent). Returns the stop function. */
export function startExternalChanges(): () => void {
  if (started) return started;
  // A clean note's text is what is on disk: remember it as the base.
  const remember = () => {
    for (const [path, v] of openPaths()) {
      if (v.dirty || conflicted.has(path) || known.get(path) === v.content) continue;
      noteDisk(path, v.content);
    }
  };
  remember();
  const unsub = useAppStore.subscribe(remember);
  const off = watchVault((e) => {
    if (e.origin !== "external") {
      // Lumen's own deletes and renames: what was known moves with them.
      if (e.type === "delete") forgetDisk(e.path);
      else if (e.type === "rename" && e.from) forgetDisk(e.from, e.path);
      return;
    }
    void onExternal(e).catch((err) => log.warn("external change failed", err));
  });
  void reconcileOpenNotes().catch((err) => log.warn("checking open notes against the disk failed", err));
  started = () => {
    unsub();
    off();
    started = null;
  };
  return started;
}
