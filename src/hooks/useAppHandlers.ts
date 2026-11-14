/**
 * useAppHandlers — all file/workspace/export handlers extracted from App.tsx.
 *
 * This hook owns:
 *  - File open / save / new / save-as
 *  - Recent files management
 *  - Workspace file operations (open, rename, delete, save-to)
 *  - Asset pasting (OPFS)
 *  - Autosave to workspace (debounced)
 *  - HTML export
 */
import { useCallback, useEffect, useState } from "react";
import type { EditorHandle } from "../editor/Editor";
import { useAppStore } from "../store/useStore";
import { t } from "../i18n";
import { openFileDialog, saveFile } from "../storage/fs";
import { exportToHtml } from "../storage/exportHtml";
import { getRecents, pushRecent, reopenRecent } from "../storage/recent";
import type { RecentFile } from "../storage/recent";
import {
  isOPFSAvailable,
  makeAssetName,
  uniqueWorkspaceName,
  writeWorkspaceBlob,
  writeWorkspaceFile,
} from "../storage/workspace";
import { uiAlert, uiConfirm } from "../ui/PromptDialog";

export function useAppHandlers(editorRef: React.RefObject<EditorHandle | null>) {
  const doc = useAppStore((s) => s.doc);
  const setDoc = useAppStore((s) => s.setDoc);
  const markSaved = useAppStore((s) => s.markSaved);
  const showWorkspace = useAppStore((s) => s.showWorkspace);
  const toggleWorkspace = useAppStore((s) => s.toggleWorkspace);

  const [recents, setRecents] = useState<RecentFile[]>([]);

  // Load recents on mount.
  useEffect(() => {
    getRecents().then(setRecents).catch(() => setRecents([]));
  }, []);

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
      } catch (err) {
        if ((err as DOMException)?.name !== "AbortError") {
          await uiAlert({ message: t("doc.alert.saveFailed", { error: (err as Error).message }) });
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
      await uiAlert({ message: t("doc.alert.exportFailed", { error: (e as Error).message }) });
    }
  }, [doc.content, doc.name]);

  const insertSnippet = useCallback((snippet: string) => {
    editorRef.current?.insertText(snippet);
  }, [editorRef]);

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

  const handleOpenFromWorkspace = useCallback(
    (name: string, content: string) => {
      setDoc({
        name,
        content,
        handle: undefined,
        workspaceName: name,
        dirty: false,
      });
    },
    [setDoc],
  );

  const handleActiveRenamed = useCallback(
    (newName: string) => {
      setDoc({ name: newName, workspaceName: newName, dirty: false });
    },
    [setDoc],
  );

  const handleActiveDeleted = useCallback(() => {
    setDoc({
      name: "Untitled.md",
      content: "",
      workspaceName: null,
      handle: undefined,
      dirty: false,
    });
  }, [setDoc]);

  const handleSaveToWorkspace = useCallback(async () => {
    if (!isOPFSAvailable()) {
      await uiAlert({ message: t("doc.alert.workspaceUnavailable") });
      return;
    }
    const base = doc.name.replace(/\.[^./]+$/, "") + ".md";
    const name = await uniqueWorkspaceName(base);
    await writeWorkspaceFile(name, doc.content);
    setDoc({ name, workspaceName: name, handle: undefined, dirty: false });
    if (!showWorkspace) toggleWorkspace();
    window.dispatchEvent(new Event("lumen-workspace-changed"));
  }, [doc.name, doc.content, setDoc, showWorkspace, toggleWorkspace]);

  // Autosave the active workspace file as the user types (debounced).
  useEffect(() => {
    if (!doc.workspaceName) return;
    if (!doc.dirty) return;
    const name = doc.workspaceName;
    const content = doc.content;
    const timer = setTimeout(() => {
      writeWorkspaceFile(name, content)
        .then(() => {
          markSaved();
          window.dispatchEvent(new Event("lumen-workspace-changed"));
        })
        .catch(() => {
          /* why: swallow; will retry on next change */
        });
    }, 600);
    return () => clearTimeout(timer);
  }, [doc.workspaceName, doc.content, doc.dirty, markSaved]);

  return {
    recents,
    setRecents,
    handleOpen,
    handleReopenRecent,
    handleSave,
    handleNew,
    handleExportHtml,
    insertSnippet,
    handleAddAsset,
    handleOpenFromWorkspace,
    handleActiveRenamed,
    handleActiveDeleted,
    handleSaveToWorkspace,
  };
}
