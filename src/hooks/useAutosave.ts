/**
 * Autosave of the shell (W6.25: moved out of App.tsx unchanged): the
 * debounced write of the open workspace file, the interval save of files
 * from disk and of ad-hoc documents, and the flush when the page is hidden.
 */
import { useEffect } from "react";
import { useAppStore } from "../store/useStore";
import { t } from "../i18n";
import { historyKey, isQuotaError, recordSnapshot } from "../storage/history";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { showAiToast } from "../ui/AiToast";
import { log } from "../lib/logger";

export interface AutosaveActions {
  handleSave: (saveAs?: boolean) => Promise<void>;
  adoptIntoWorkspace: () => Promise<string | null>;
}

export function useAutosave({ handleSave, adoptIntoWorkspace }: AutosaveActions): void {
  const doc = useAppStore((s) => s.doc);
  const markSaved = useAppStore((s) => s.markSaved);

  // Autosave the active workspace file as the user types (debounced).
  useEffect(() => {
    if (!doc.workspaceName) return;
    if (!doc.dirty) return;
    const name = doc.workspaceName;
    const content = doc.content;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const write = (attempt: number) => {
      // Compare-and-swap (plan 4.4): a file changed outside Lumen since it
      // was opened becomes a conflict instead of being overwritten.
      import("../store/externalChanges")
        .then((m) => m.saveOpenNote(name, content))
        .then((saved) => {
          if (!saved) return;
          // Only if nothing changed the note meanwhile (a quick capture into
          // the open inbox, plan 4.16): otherwise its newer text stays dirty
          // and the next autosave writes it.
          const now = useAppStore.getState().doc;
          if (now.workspaceName === name && now.content === content) markSaved();
          // Only this file's text changed: listeners skip the full rescan (C3).
          notifyWorkspaceChanged({ kind: "content", paths: [name] });
          // Every save path feeds the one history store (T35).
          void recordSnapshot(name, content, "autosave").catch(() => false);
        })
        .catch((err: unknown) => {
          // A failed write used to vanish silently. Say so once, retry
          // with back-off; the localStorage mirror still holds the text.
          if (attempt === 0) showAiToast(t(isQuotaError(err) ? "doc.save.quota" : "doc.save.failedRetrying", { name }), "error");
          if (attempt < 4) retry = setTimeout(() => write(attempt + 1), 2000 * 2 ** attempt);
        });
    };
    const timer = setTimeout(() => write(0), 600);
    return () => {
      clearTimeout(timer);
      if (retry) clearTimeout(retry);
    };
  }, [doc.workspaceName, doc.content, doc.dirty, markSaved]);

  // Auto-save: save dirty documents on interval
  const autoSave = useAppStore((s) => s.autoSave);
  const autoSaveInterval = useAppStore((s) => s.autoSaveInterval);
  useEffect(() => {
    if (!autoSave || !doc.dirty) return;
    const timer = setInterval(() => {
      const d = useAppStore.getState().doc;
      if (!d.dirty) return;
      if (d.handle) {
        // From disk: write back through the handle (workspace files are
        // written by the debounced effect above).
        handleSave(false);
      } else if (!d.workspaceName && d.content.trim()) {
        // Untitled / ad-hoc: until now these were never written anywhere
        // but localStorage. Give them a home in the workspace; from then
        // on the debounced workspace autosave owns them.
        adoptIntoWorkspace().catch((err) => log.warn("[autosave] adopt failed", (err as Error).message));
      }
    }, autoSaveInterval);
    return () => clearInterval(timer);
  }, [autoSave, autoSaveInterval, doc.dirty, handleSave, adoptIntoWorkspace]);

  // Flush the pending workspace write when the page is hidden or going
  // away: the debounced effect above may still be waiting, and a closed
  // tab (or a backgrounded phone) never runs it. `pagehide` is the last
  // reliable moment; `visibilitychange` covers mobile, where pages are
  // often frozen instead of unloaded. The localStorage mirror keeps the
  // text either way; this keeps the workspace file current.
  useEffect(() => {
    const flush = () => {
      const d = useAppStore.getState().doc;
      void recordSnapshot(historyKey(d), d.content, "close").catch(() => false);
      if (!d.dirty || !d.workspaceName) return;
      const name = d.workspaceName;
      const text = d.content;
      import("../store/externalChanges")
        .then((m) => m.saveOpenNote(name, text))
        .then((saved) => {
          // Only if nothing (a quick capture) changed the note meanwhile.
          const now = useAppStore.getState().doc;
          if (saved && now.workspaceName === name && now.content === text) markSaved();
        })
        .catch(() => {
          /* why: best effort; the debounced autosave retries on the next edit */
        });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [markSaved]);
}
