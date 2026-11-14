/**
 * Keep the documents held in memory (the active note and the open tabs)
 * consistent with file operations on the vault (T46 review fixes).
 */

import { flushPendingEdits, moveTabRuntimes, notifyTabIdChange, tabIdOf, useAppStore } from "./useStore";
import { writeWorkspaceFile } from "../storage/workspace";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { t } from "../i18n";
import { movedPath, trashPaths } from "../storage/fileOps";
import { PartialTrashError, trashedPathOf, type TrashItem } from "../storage/trash";

/**
 * Write the active workspace note now if it has edits the debounced
 * autosave has not written yet — before an operation that reads or moves
 * the file on disk (trash, export).
 */
export async function flushActiveWorkspaceDoc(): Promise<void> {
  flushPendingEdits();
  const d = useAppStore.getState().doc;
  if (!d.dirty || !d.workspaceName) return;
  const { workspaceName: name, content } = d;
  // Compare-and-swap (plan 4.4): never over a change made outside Lumen.
  const { saveOpenNote, whenResolved } = await import("./externalChanges");
  if (!(await saveOpenNote(name, content))) {
    // A change made outside Lumen is being resolved: wait for the answer, then
    // save what the note holds now. Callers (trash, move, export) must not go
    // on as if the note were saved.
    await whenResolved(name);
    flushPendingEdits();
    const d2 = useAppStore.getState().doc;
    if (d2.workspaceName !== name || !d2.dirty) return; // resolved: on disk
    if (!(await saveOpenNote(name, d2.content))) throw new Error(t("external.conflict.notSaved", { path: name }));
    const after = useAppStore.getState().doc;
    if (after.workspaceName === name && after.content === d2.content) useAppStore.getState().markSaved();
    notifyWorkspaceChanged({ kind: "content", paths: [name] });
    return;
  }
  const now = useAppStore.getState().doc;
  if (now.workspaceName === name && now.content === content) useAppStore.getState().markSaved();
  notifyWorkspaceChanged({ kind: "content", paths: [name] });
}

/**
 * Write the unsaved text of open notes (the active one and inactive tabs
 * alike) to where `target` maps their workspace path, skipping notes it maps
 * to null. Notes whose text is still what was written are marked clean.
 * Returns how many notes it wrote; 0 means none was dirty, decided with no
 * await after the check. Throws when a write fails.
 */
async function writeDirtyOpenDocs(target: (workspacePath: string) => string | null): Promise<number> {
  flushPendingEdits();
  const st = useAppStore.getState();
  const activeId = tabIdOf(st.doc);
  const pending = new Map<string, { to: string; content: string }>(); // workspace path → write
  const add = (ws: string, content: string) => {
    const to = target(ws);
    if (to !== null && !pending.has(ws)) pending.set(ws, { to, content });
  };
  if (st.doc.dirty && st.doc.workspaceName) add(st.doc.workspaceName, st.doc.content);
  for (const tab of st.openTabs) {
    // The active document is the source of truth for its own tab.
    if (tab.id !== activeId && tab.dirty && tab.workspaceName) add(tab.workspaceName, tab.content);
  }
  if (!pending.size) return 0;
  const written = new Map<string, string>(); // workspace path → text written
  // In place: compare-and-swap (plan 4.4), never over a change made outside Lumen.
  const { saveOpenNote } = await import("./externalChanges");
  try {
    for (const [ws, { to, content }] of pending) {
      if (to !== ws) await writeWorkspaceFile(to, content);
      else if (!(await saveOpenNote(to, content))) throw new Error(t("external.conflict.notSaved", { path: to }));
      written.set(ws, content);
    }
  } finally {
    if (written.size) {
      // Clean only where the text is still what was written (no edit since).
      const saved = (ws: string | null | undefined, content: string) => !!ws && written.get(ws) === content;
      useAppStore.setState((s) => ({
        doc: s.doc.dirty && saved(s.doc.workspaceName, s.doc.content) ? { ...s.doc, dirty: false } : s.doc,
        openTabs: s.openTabs.map((t) => (t.dirty && saved(t.workspaceName, t.content) ? { ...t, dirty: false } : t)),
      }));
      notifyWorkspaceChanged({ kind: "content", paths: [...pending.values()].map((w) => w.to) });
    }
  }
  return pending.size;
}

/**
 * Write every open note at or under `paths` whose edits are not on disk yet
 * (the active one and inactive tabs alike) before those paths go to the
 * trash, so Undo / Ctrl+Z brings back the latest text (plan 3.1). Only the
 * active note has a debounced autosave; a tab left within that window keeps
 * its edits in memory until it is selected again. Throws when a write fails,
 * so the caller does not trash a note whose edits were not saved.
 */
export async function flushOpenDocsUnder(paths: string[]): Promise<void> {
  const under = (ws: string) => paths.some((p) => ws === p || ws.startsWith(p + "/"));
  await writeDirtyOpenDocs((ws) => (under(ws) ? ws : null));
}

/** Post-trash passes before giving up on a note whose text keeps changing during its own write. */
const SETTLE_PASSES = 5;

/**
 * Delete from the file tree with the open notes' latest text kept: write
 * their unsaved edits, move the paths to the trash, then write any edit made
 * while that was in flight (the user kept typing in the open note) into the
 * trashed copy, so Undo / Ctrl+Z still brings back the newest text
 * (plan 3.1, review: #218). That pass repeats until one finds nothing left
 * to write, inside the trash queue, so nothing restores or purges the
 * entries mid-write. The final check runs with no await after it, so no
 * keystroke (a task) can slip in before the caller clears the document.
 *
 * `settled` is false when the text still changed during every pass. The
 * newest edits are then only in memory, and the caller must not clear the
 * document.
 */
export async function trashWithOpenEdits(
  paths: string[],
  kinds: Record<string, "file" | "directory"> = {},
): Promise<{ items: TrashItem[]; settled: boolean }> {
  await flushOpenDocsUnder(paths);
  let settled = true;
  let movedItems: TrashItem[] = [];
  let items: TrashItem[];
  try {
    // Inside the trash queue (afterMove): a Ctrl+Z or Trash-panel restore of
    // these entries waits until the trashed copies hold the newest text.
    items = await trashPaths(paths, kinds, async (moved) => {
      movedItems = moved;
      const inTrash = (ws: string) => {
        for (const item of moved) {
          const at = trashedPathOf(item, ws);
          if (at) return at;
        }
        return null;
      };
      settled = false;
      for (let pass = 0; pass < SETTLE_PASSES; pass++) {
        if ((await writeDirtyOpenDocs(inTrash)) === 0) {
          settled = true;
          return;
        }
      }
    });
  } catch (e) {
    // Something moved before the failure (a post-trash write rejected, or a
    // bulk delete stopped part way): open notes still bound to a moved path
    // are detached, or their autosave recreates the deleted file (review: #218).
    const moved = movedItems.length ? movedItems : e instanceof PartialTrashError ? e.items : [];
    if (moved.length) detachUnder(moved.map((i) => i.originalPath), { dirtyTabs: true });
    throw e;
  }
  // Its text kept changing: keep it in memory as an unsaved note, detached from
  // the trashed path, so autosave does not recreate the deleted file.
  if (!settled) detachUnder(paths);
  return { items, settled };
}

/**
 * The active note under `paths` becomes an ad-hoc note (same text, no
 * workspace path); with `dirtyTabs`, so does every inactive tab there with
 * unsaved edits.
 */
function detachUnder(paths: string[], opts: { dirtyTabs?: boolean } = {}): void {
  const under = (ws: string | null | undefined): ws is string => !!ws && paths.some((p) => ws === p || ws.startsWith(p + "/"));
  useAppStore.setState((state) => {
    const activeWs = under(state.doc.workspaceName) ? state.doc.workspaceName : null;
    const detach = new Set<string>();
    if (activeWs) detach.add(activeWs);
    if (opts.dirtyTabs) for (const t of state.openTabs) if (t.dirty && under(t.workspaceName)) detach.add(t.workspaceName);
    if (!detach.size) return state;
    const taken = new Set<string>();
    const names = new Map<string, string>(); // workspace path → ad-hoc name
    for (const ws of detach) {
      const file = ws.split("/").pop() || ws;
      const stem = file.replace(/(\.[^./]+)$/, "");
      const ext = file.slice(stem.length) || ".md";
      let name = file;
      for (let i = 2; taken.has(name) || state.openTabs.some((t) => t.id === name); i++) name = `${stem} ${i}${ext}`;
      taken.add(name);
      names.set(ws, name);
    }
    moveTabRuntimes([...names]);
    const activeName = activeWs ? names.get(activeWs) : undefined;
    return {
      doc: activeName ? { ...state.doc, name: activeName, workspaceName: null, handle: undefined } : state.doc,
      openTabs: state.openTabs.map((t) => {
        const name = t.workspaceName && t.id === t.workspaceName ? names.get(t.id) : undefined;
        return name ? { ...t, id: name, name, workspaceName: null } : t;
      }),
    };
  });
}

/**
 * After `from` moved to `to`: open notes inside the moved entry take their
 * new path (so autosave does not recreate the old one), and every open
 * note's text gets the same link rewrite the files on disk got (so a tab
 * switch or autosave does not write the old links back). Dirty state is kept.
 */
export function syncOpenDocsAfterMove(
  from: string,
  to: string,
  rewrite: (content: string, notePrevPath: string) => string,
  /** The entry the move overwrote (it went to the trash), when there was one. */
  replaced?: string | null,
): void {
  flushPendingEdits();
  const under = (ws: string, root: string) => ws === root || ws.startsWith(root + "/");
  // An open note at the overwritten path still claims it: detach it first, or
  // its next autosave writes over the note that just moved there and two
  // tabs share one id.
  const wasReplaced = (ws: string | null | undefined): boolean => !!replaced && !!ws && under(ws, replaced) && !under(ws, from);
  const fix = (ws: string | null | undefined, content: string) => {
    if (!ws) return null;
    const path = movedPath(ws, from, to) ?? ws;
    const text = /\.(md|markdown)$/i.test(ws) ? rewrite(content, ws) : content;
    return path === ws && text === content ? null : { path, text };
  };
  // Tab ids that changed, announced after the store update (open panels keyed by tab id follow).
  const renamed = new Map<string, string>();
  useAppStore.setState((state) => {
    // The active document can be outside openTabs (opened with setDoc): its id is taken too.
    const taken = new Set<string>([tabIdOf(state.doc)]);
    const detachedName = (ws: string) => {
      const file = ws.split("/").pop() || ws;
      const stem = file.replace(/(\.[^./]+)$/, "");
      const ext = file.slice(stem.length) || ".md";
      let name = file;
      for (let i = 2; taken.has(name) || state.openTabs.some((t) => t.id === name); i++) name = `${stem} ${i}${ext}`;
      taken.add(name);
      return name;
    };
    const detached = new Map<string, string>(); // old path → ad-hoc name
    const remaps: [string, string][] = []; // applied together below: ids can collide mid-map
    const openTabs = state.openTabs.map((t) => {
      if (t.workspaceName && wasReplaced(t.workspaceName)) {
        // Kept as an ad-hoc note: its text (unsaved edits included) is not lost; the file itself is in the trash.
        const name = detachedName(t.workspaceName);
        detached.set(t.workspaceName, name);
        remaps.push([t.id, name]);
        return { ...t, id: name, name, workspaceName: null };
      }
      const f = fix(t.workspaceName, t.content);
      if (!f) return t;
      const id = tabIdOf({ workspaceName: f.path, name: f.path });
      remaps.push([t.id, id]);
      return { ...t, id, name: t.name === t.workspaceName ? f.path : t.name, workspaceName: f.path, content: f.text };
    });
    moveTabRuntimes(remaps);
    for (const [from, to] of remaps) renamed.set(from, to);
    const d = state.doc;
    let doc = d;
    if (d.workspaceName && wasReplaced(d.workspaceName)) {
      const name = detached.get(d.workspaceName) ?? detachedName(d.workspaceName);
      doc = { ...d, name, workspaceName: null, handle: undefined };
    } else {
      const f = fix(d.workspaceName, d.content);
      if (f) doc = { ...d, name: d.name === d.workspaceName ? f.path : d.name, workspaceName: f.path, content: f.text };
    }
    if (doc !== d) renamed.set(tabIdOf(d), tabIdOf(doc));
    return { doc, openTabs };
  });
  for (const [from, to] of renamed) notifyTabIdChange(from, to);
}
