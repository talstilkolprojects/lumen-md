/**
 * Keep the documents held in memory (the active note and the open tabs)
 * consistent with file operations on the vault (T46 review fixes).
 */

import { flushPendingEdits, tabIdOf, useAppStore } from "./useStore";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { t } from "../i18n";
import { movedPath } from "../storage/fileOps";

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
 * After `from` moved to `to`: open notes inside the moved entry take their
 * new path (so autosave does not recreate the old one), and every open
 * note's text gets the same link rewrite the files on disk got (so a tab
 * switch or autosave does not write the old links back). Dirty state is kept.
 */
export function syncOpenDocsAfterMove(from: string, to: string, rewrite: (content: string, notePrevPath: string) => string): void {
  flushPendingEdits();
  const fix = (ws: string | null | undefined, content: string) => {
    if (!ws) return null;
    const path = movedPath(ws, from, to) ?? ws;
    const text = /\.(md|markdown)$/i.test(ws) ? rewrite(content, ws) : content;
    return path === ws && text === content ? null : { path, text };
  };
  useAppStore.setState((state) => {
    const openTabs = state.openTabs.map((t) => {
      const f = fix(t.workspaceName, t.content);
      return f ? { ...t, id: tabIdOf({ workspaceName: f.path, name: f.path }), name: t.name === t.workspaceName ? f.path : t.name, workspaceName: f.path, content: f.text } : t;
    });
    const d = state.doc;
    const f = fix(d.workspaceName, d.content);
    const doc = f ? { ...d, name: d.name === d.workspaceName ? f.path : d.name, workspaceName: f.path, content: f.text } : d;
    return { doc, openTabs };
  });
}
