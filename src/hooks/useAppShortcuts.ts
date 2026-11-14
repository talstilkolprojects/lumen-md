/**
 * The shell's global keyboard shortcuts (W6.25: moved out of App.tsx
 * unchanged). Matched by the physical key, so the Hebrew layout works too
 * (plan W2.8).
 */
import { useEffect } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { EditorHandle } from "../editor/Editor";
import { appShortcutFor } from "../lib/shortcuts";
import { noteTypedKey } from "../lib/keyboardLayout";
import { handleTrashUndoKey } from "../ui/trashUndoShortcut";
import { openInsertTextDialog } from "../ui/insertTextFromDialog";
import { useAppStore } from "../store/useStore";

export interface AppShortcutActions {
  editorRef: RefObject<EditorHandle | null>;
  handleOpen: () => unknown;
  handleSave: (saveAs?: boolean) => unknown;
  handleNew: () => unknown;
  focusMode: boolean;
  setFocusMode: (on: boolean) => void;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setFindReplaceOpen: Dispatch<SetStateAction<boolean>>;
  setShortcutsOpen: Dispatch<SetStateAction<boolean>>;
  setCaptureOpen: (open: boolean) => void;
}

export function useAppShortcuts(a: AppShortcutActions): void {
  const { editorRef, handleOpen, handleSave, handleNew, focusMode, setFocusMode, setPaletteOpen, setFindReplaceOpen, setShortcutsOpen, setCaptureOpen } = a;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      noteTypedKey(e.key);
      // F1 → in-app help (W3.7), as the palette shows.
      if (e.key === "F1" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        void import("../ui/HelpButton").then((m) => m.openHelp());
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      // ⌘Z / Ctrl+Z outside the editor: restore the last delete (plan 3.1).
      // In an editor or a text field it stays their own undo.
      if (handleTrashUndoKey(e)) return;
      // ⌥⌘D → today's daily note (e.code: Option changes e.key on a Mac).
      if (e.altKey && e.code === "KeyD") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("lumen-open-today"));
        return;
      }
      // ⌥⌘N → quick capture to inbox.md (plan 4.16).
      // Not AltGr (reported as Ctrl+Alt on Windows / Linux): AltGr+N types a letter (ń).
      if (e.altKey && e.code === "KeyN" && !e.getModifierState("AltGraph")) {
        e.preventDefault();
        setCaptureOpen(true);
        return;
      }
      // ⌥⌘S → the open-sources dialog (plan W7.24). Not AltGr: AltGr+S types a letter (ś).
      if (e.altKey && e.code === "KeyS" && !e.getModifierState("AltGraph")) {
        e.preventDefault();
        void import("../sources/open/OpenSourcesDialog").then((m) => m.openSourcesDialog());
        return;
      }
      // ⌥⌘C → the cite dialog (plan W2.16).
      if (e.altKey && e.code === "KeyC") {
        e.preventDefault();
        void import("../citations/CiteDialog").then((m) => m.openCiteDialog());
        return;
      }
      // Matched by the physical key, so the Hebrew layout works too (plan W2.8).
      const id = appShortcutFor(e);
      if (!id) return;
      e.preventDefault();
      switch (id) {
        case "view.focusMode":
          // ⇧⌘F → focus mode toggle
          setFocusMode(!focusMode);
          return;
        case "palette.toggle":
          setPaletteOpen((v) => !v);
          return;
        case "file.save":
        case "file.saveAs":
          handleSave(id === "file.saveAs");
          return;
        case "view.findReplace":
          setFindReplaceOpen((v) => !v);
          return;
        case "file.open":
          handleOpen();
          return;
        case "file.new":
          handleNew();
          return;
        case "view.source":
          useAppStore.getState().setMode("source");
          return;
        case "view.split":
          useAppStore.getState().setMode("split");
          return;
        case "view.preview":
          useAppStore.getState().setMode("preview");
          return;
        case "view.wysiwyg":
          useAppStore.getState().setMode("wysiwyg");
          return;
        case "help.shortcuts":
          setShortcutsOpen((v) => !v);
          return;
        case "insert.smart":
          // ⌘⇧V — Smart Insert (paste anything → auto-detect → wrap).
          (async () => {
            const result = await openInsertTextDialog();
            if (!result) return;
            const cur = useAppStore.getState().doc.content;
            const setter = useAppStore.getState().setContent;
            if (result.mode === "replace") setter(result.markdown);
            else if (result.mode === "atCursor" && editorRef.current) {
              editorRef.current.insertText(result.markdown);
            } else {
              const trimmed = cur.endsWith("\n") ? cur : cur + "\n";
              setter(trimmed + (result.mode === "append" ? "\n" : "") + result.markdown);
            }
          })();
          return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // The setters and the ref are stable (App's useState / useRef): the
    // listener is replaced when a handler or focusMode changes, as before.
  }, [handleOpen, handleSave, handleNew, focusMode, editorRef, setFocusMode, setPaletteOpen, setFindReplaceOpen, setShortcutsOpen, setCaptureOpen]);
}
