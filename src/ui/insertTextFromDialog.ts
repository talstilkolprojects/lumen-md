/**
 * The Insert-text dialog, from the toolbar and the native menu (W6.25:
 * moved out of App.tsx unchanged). The dialog (and its smart detector)
 * loads on first use, off the startup path — it made room in the startup
 * budget for the PDF reader (4.14).
 */
import type { EditorHandle } from "../editor/Editor";

export const openInsertTextDialog = () => import("./InsertTextDialog").then((m) => m.openInsertTextDialog());

/**
 * Ask for text and put it in the note: replace it, at the cursor (or at the
 * end when no editor is mounted, e.g. preview-only mode), or appended after a
 * blank line. Resolves false when the dialog was cancelled.
 */
export async function insertTextFromDialog(current: string, setContent: (text: string) => void, getEditor: () => EditorHandle | null): Promise<boolean> {
  const result = await openInsertTextDialog();
  if (!result) return false;
  const editor = getEditor();
  if (result.mode === "replace") {
    setContent(result.markdown);
  } else if (result.mode === "atCursor" && editor) {
    // Real cursor-aware insert via the Editor's exposed handle.
    editor.insertText(result.markdown);
  } else if (result.mode === "atCursor") {
    // Fallback when the editor isn't mounted (e.g. preview-only mode).
    const trimmed = current.endsWith("\n") ? current : current + "\n";
    setContent(trimmed + result.markdown);
  } else {
    setContent(current + (current.endsWith("\n") ? "" : "\n") + "\n" + result.markdown);
  }
  return true;
}
