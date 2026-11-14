/**
 * Open, save, new, export and workspace actions of the shell, and the
 * recent files they keep (W6.25: moved out of App.tsx unchanged). Also the
 * before-unload warning for unsaved changes.
 */
import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../store/useStore";
import { t } from "../i18n";
import { historyKey, recordSnapshot } from "../storage/history";
import { openFileDialog, saveFile } from "../storage/fs";
import { exportToHtml } from "../storage/exportHtml";
import { getRecents, pushRecent, reopenRecent } from "../storage/recent";
import type { RecentFile } from "../storage/recent";
import { isOPFSAvailable, makeAssetName, uniqueWorkspaceName, writeWorkspaceBlob, writeWorkspaceFile } from "../storage/workspace";
import { uiAlert, uiConfirm } from "../ui/PromptDialog";
import { explainError } from "../lib/userError";

export function useDocFileActions() {
  const doc = useAppStore((s) => s.doc);
  const setDoc = useAppStore((s) => s.setDoc);
  const markSaved = useAppStore((s) => s.markSaved);
  const adoptWorkspaceName = useAppStore((s) => s.adoptWorkspaceName);
  const openTabAction = useAppStore((s) => s.openTab);
  const showWorkspace = useAppStore((s) => s.showWorkspace);
  const toggleWorkspace = useAppStore((s) => s.toggleWorkspace);
  const [recents, setRecents] = useState<RecentFile[]>([]);

  // Load recents on mount.
  useEffect(() => {
    getRecents().then(setRecents).catch(() => setRecents([]));
  }, []);

  // Beforeunload warning if dirty
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (doc.dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [doc.dirty]);

  const handleOpen = useCallback(async () => {
    const file = await openFileDialog();
    if (!file) return;
    setDoc({
      name: file.name,
      content: file.content,
      handle: file.handle,
      dirty: false,
    });
    if (file.handle) {
      await pushRecent({ name: file.name, handle: file.handle });
      setRecents(await getRecents());
    }
  }, [setDoc]);

  const handleReopenRecent = useCallback(
    async (entry: RecentFile) => {
      const opened = await reopenRecent(entry);
      if (!opened) {
        await uiAlert({ message: t("doc.alert.reopenFailed") });
        return;
      }
      setDoc({
        name: opened.name,
        content: opened.content,
        handle: opened.handle,
        dirty: false,
      });
      await pushRecent({ name: opened.name, handle: opened.handle });
      setRecents(await getRecents());
    },
    [setDoc],
  );

  const handleSave = useCallback(
    async (saveAs = false) => {
      try {
        const next = await saveFile(
          { name: doc.name, content: doc.content, handle: doc.handle },
          { saveAs },
        );
        setDoc({
          name: next.name,
          content: next.content,
          handle: next.handle,
          dirty: false,
        });
        markSaved();
        void recordSnapshot(historyKey({ name: next.name, workspaceName: useAppStore.getState().doc.workspaceName }), next.content, "save").catch(() => false);
      } catch (err) {
        // User cancelled Save-As dialog or filesystem error
        if ((err as DOMException)?.name !== "AbortError") {
          await uiAlert({ message: t("doc.alert.saveFailed", { error: explainError(err) }) });
        }
      }
    },
    [doc.name, doc.content, doc.handle, setDoc, markSaved],
  );

  const handleNew = useCallback(async () => {
    if (doc.dirty && !(await uiConfirm({ message: t("doc.confirm.discardUnsaved") }))) return;

    let baseName = `${t("doc.untitled")}.md`;
    if (await isOPFSAvailable()) {
      baseName = await uniqueWorkspaceName(baseName);
    }

    setDoc({
      name: baseName,
      content: `# ${baseName.replace(/\.md$/, "")}\n\n`,
      handle: undefined,
      dirty: false,
    });
  }, [doc.dirty, setDoc]);

  const handleExportHtml = useCallback(async () => {
    try {
      await exportToHtml(doc.content, doc.name);
    } catch (e) {
      await uiAlert({ message: t("doc.alert.exportFailed", { error: explainError(e) }) });
    }
  }, [doc.content, doc.name]);

  /**
   * When the user pastes/drops an image into the editor, persist it under
   * OPFS as a `lumen-asset-*` file (so the workspace owns the asset) and
   * return the markdown link. Falls back to a data: URL when OPFS isn't
   * available.
   */
  const handleAddAsset = useCallback(async (file: File): Promise<string | null> => {
    if (!isOPFSAvailable()) return null;
    try {
      const name = makeAssetName(file.name);
      await writeWorkspaceBlob(name, file);
      window.dispatchEvent(new Event("lumen-workspace-changed"));
      return name;
    } catch {
      return null;
    }
  }, []);

  // Workspace: open a file from the file tree. Routed through `openTab` so
  // re-opening an already-active doc just focuses its tab without losing
  // unsaved edits in the previous one.
  const handleOpenFromWorkspace = useCallback(
    (name: string, content: string) => {
      openTabAction({ name, content, workspaceName: name });
    },
    [openTabAction],
  );

  // Workspace: when active file is renamed (in the tree), keep doc.name in sync.
  const handleActiveRenamed = useCallback(
    (newName: string) => {
      setDoc({ name: newName, workspaceName: newName, dirty: false });
    },
    [setDoc],
  );

  const handleActiveDeleted = useCallback(() => {
    setDoc({
      name: `${t("doc.untitled")}.md`,
      content: "",
      workspaceName: null,
      handle: undefined,
      dirty: false,
    });
  }, [setDoc]);

  // Write the active ad-hoc document (no disk handle, not in the
  // workspace) into the workspace under a free name derived from its own,
  // and switch the document and its tab to that identity. Shared by the
  // explicit "save to workspace" command and by autosave.
  const adoptIntoWorkspace = useCallback(async (): Promise<string | null> => {
    const d = useAppStore.getState().doc;
    if (!isOPFSAvailable()) return null;
    const base = d.name.replace(/\.[^./]+$/, "") + ".md";
    const name = await uniqueWorkspaceName(base);
    await writeWorkspaceFile(name, d.content);
    adoptWorkspaceName(name);
    window.dispatchEvent(new Event("lumen-workspace-changed"));
    return name;
  }, [adoptWorkspaceName]);

  // Save the current doc into the workspace as a fresh file.
  const handleSaveToWorkspace = useCallback(async () => {
    if (!isOPFSAvailable()) {
      await uiAlert({ message: t("doc.alert.workspaceUnavailable") });
      return;
    }
    await adoptIntoWorkspace();
    if (!showWorkspace) toggleWorkspace();
  }, [adoptIntoWorkspace, showWorkspace, toggleWorkspace]);

  return {
    recents,
    setRecents,
    handleOpen,
    handleReopenRecent,
    handleSave,
    handleNew,
    handleExportHtml,
    handleAddAsset,
    handleOpenFromWorkspace,
    handleActiveRenamed,
    handleActiveDeleted,
    adoptIntoWorkspace,
    handleSaveToWorkspace,
  };
}
