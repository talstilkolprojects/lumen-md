/**
 * Writing a highlights note (a "sidecar": `<file>.pdf.md`, `<book>.epub.md`)
 * safely (plans 4.14, W1.14, W1.15). The same steps the PDF reader takes:
 * save the open note first, read the file, apply the change, write, and give
 * every open copy of the note (the active document and background tabs) the
 * same change — otherwise their next autosave would write the old block back.
 *
 * `update` gets the note's text (null when there is no note yet) and returns
 * the new text, or throws to refuse (an unreadable highlights block must not
 * be overwritten).
 */

function isMissing(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: unknown }).name === "NotFoundError";
}

export async function writeSidecar(notePath: string, update: (existing: string | null) => string): Promise<void> {
  const [ws, { flushActiveWorkspaceDoc }, { notifyWorkspaceChanged }, { useAppStore, tabIdOf }] = await Promise.all([
    import("../storage/workspace"),
    import("../store/openDocs"),
    import("../storage/workspaceEvents"),
    import("../store/useStore"),
  ]);
  await flushActiveWorkspaceDoc();
  let existing: string | null = null;
  try {
    existing = await ws.readWorkspaceFile(notePath);
  } catch (e) {
    if (!isMissing(e)) throw e;
  }
  const next = update(existing);
  await ws.writeWorkspaceFile(notePath, next);
  const st = useAppStore.getState();
  if (st.doc.workspaceName === notePath) st.setDoc({ name: st.doc.name, content: update(st.doc.content), dirty: st.doc.dirty });
  const activeId = tabIdOf(useAppStore.getState().doc);
  useAppStore.setState((s) => ({
    openTabs: s.openTabs.map((tab) => (tab.workspaceName === notePath && tab.id !== activeId ? { ...tab, content: update(tab.content) } : tab)),
  }));
  notifyWorkspaceChanged(existing === null ? { kind: "structure" } : { kind: "content", paths: [notePath] });
}
