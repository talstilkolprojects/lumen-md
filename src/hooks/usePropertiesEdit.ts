/**
 * Properties panel edits (plan 4.9), and the database view's edits of the
 * open note (4.10), applied to the source editor's live text as one minimal
 * change (cursor, undo history and collab stay intact); without a mounted
 * source editor, to the store's text. In suggesting mode either way the
 * edit is recorded as a tracked change, not applied directly. W6.25: moved
 * out of App.tsx unchanged.
 */
import { useCallback, useEffect } from "react";
import type { RefObject } from "react";
import type { EditorHandle } from "../editor/Editor";
import type { NoteEditDetail } from "../views/databaseEdit";
import { minimalChange, propertiesTransaction, trackedPropertiesText } from "../editor/propertiesEdit";
import { useAppStore, flushPendingEdits } from "../store/useStore";
import { useAuth } from "../auth/useAuth";
import { showAiToast } from "../ui/AiToast";
import { t } from "../i18n";

export function usePropertiesEdit(editorRef: RefObject<EditorHandle | null>) {
  const setContent = useAppStore((s) => s.setContent);
  const applyPropertiesEdit = useCallback((edit: (text: string) => string) => {
    const view = editorRef.current?.getView();
    if (view) {
      const cur = view.state.doc.toString();
      const change = minimalChange(cur, edit(cur));
      if (change) view.dispatch(propertiesTransaction(change));
      return;
    }
    flushPendingEdits();
    const cur = useAppStore.getState().doc.content;
    const change = minimalChange(cur, edit(cur));
    if (!change) return;
    if (!useAppStore.getState().suggestingMode) return setContent(cur.slice(0, change.from) + change.insert + cur.slice(change.to));
    const user = useAuth.getState().user;
    const next = trackedPropertiesText(cur, change, user?.name?.trim() || user?.email?.split("@")[0] || null);
    if (next === null) return showAiToast(t("suggesting.untrackable"), "info");
    if (next !== cur) setContent(next);
  }, [setContent, editorRef]);
  // The database view edits the open note through here too (4.10), so the
  // editor, not the file behind it, takes the change. The event name is
  // NOTE_EDIT_EVENT of views/databaseEdit (not imported: it stays lazy).
  useEffect(() => {
    const onEdit = (e: Event) => {
      const d = (e as CustomEvent<NoteEditDetail>).detail;
      if (!d || useAppStore.getState().doc.workspaceName !== d.path) return;
      let changed = false;
      applyPropertiesEdit((cur) => {
        const next = d.edit(cur);
        changed = next !== cur;
        return next;
      });
      d.done(changed);
    };
    window.addEventListener("lumen-note-edit", onEdit);
    return () => window.removeEventListener("lumen-note-edit", onEdit);
  }, [applyPropertiesEdit]);
  return applyPropertiesEdit;
}
