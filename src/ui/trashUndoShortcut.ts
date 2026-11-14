/**
 * Ctrl+Z / ⌘Z outside the editor restores the last delete from the file
 * tree (plan 3.1). Inside an editor, a text field or the canvas, the key
 * stays theirs (their own undo); the app-wide handler takes it only when
 * focus is elsewhere: the file tree, a panel, the page itself.
 */
import { t } from "../i18n";
import { trashUndoDepth, undoLastTrash } from "../storage/fileOps";
import { toast } from "../store/useToastStore";

/**
 * Places with their own undo: CodeMirror, the WYSIWYG editor (ProseMirror),
 * text fields, anything contenteditable, the tldraw canvas.
 */
const EDITING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cm-editor, .ProseMirror, .wysiwyg-root, .tl-container';

/** Is focus somewhere that owns Ctrl+Z? */
export function isEditingTarget(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : typeof document !== "undefined" ? document.activeElement : null;
  if (!el) return false;
  if ((el as HTMLElement).isContentEditable) return true;
  return !!el.closest(EDITING);
}

/**
 * Ctrl+Z / ⌘Z without Shift or Alt. Matches the physical Z key too, so the
 * shortcut works on a Hebrew (or other non-Latin) layout, where `key` is the
 * layout's letter; on AZERTY the Latin `key` wins (Z is where W is on QWERTY).
 */
export function isUndoKey(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return false;
  const key = e.key ?? "";
  if (key.toLowerCase() === "z") return true;
  return e.code === "KeyZ" && !/^[a-z]$/i.test(key);
}

/**
 * The app-wide keydown handler's Ctrl+Z branch. Returns true when it took
 * the key (and restores in the background), false to leave the key alone:
 * not Ctrl+Z, someone already handled it, focus is in an editor, or there is
 * no delete to undo.
 */
export function handleTrashUndoKey(e: KeyboardEvent): boolean {
  if (!isUndoKey(e) || e.defaultPrevented || isEditingTarget(e.target)) return false;
  if (trashUndoDepth() === 0) return false;
  e.preventDefault();
  void undoLastTrash().then(
    (restored) => {
      if (!restored?.length) return;
      if (restored.length === 1) toast.success(t("trash.restored", { path: restored[0] }));
      else toast.success(t("trash.restoredMany", { count: String(restored.length) }));
    },
    (err: unknown) => {
      toast.error(t("trash.restoreFailed", { error: err instanceof Error ? err.message : String(err) }));
    },
  );
  return true;
}
