/** The bodies of the journalist-mode commands (plan W5.11), loaded on first use (./export.ts). */
import type { EditorView } from "@codemirror/view";
import { t } from "../../i18n";
import { exportReadyText } from "../../storage/exportReady";

/** Wrap the selection in <redact>; with nothing selected, say how. */
export async function redactSelection(view: EditorView | null): Promise<void> {
  const sel = view?.state.selection.main;
  if (!view || !sel || sel.empty) {
    const [{ uiAlert }] = await Promise.all([import("../../ui/PromptDialog"), import("../../lib/journalistStrings")]);
    await uiAlert({ message: t("redact.empty") });
    return;
  }
  const { wrapRedaction } = await import("../../lib/redaction");
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert: wrapRedaction(view.state.sliceDoc(sel.from, sel.to)) } });
  view.focus();
}

/** The note as Markdown without its redacted passages and hidden comments. */
export async function exportRedactedMarkdown(doc: { name: string; content: string }): Promise<void> {
  const content = await exportReadyText(doc.content);
  const { downloadText } = await import("../../storage/exportFormats");
  downloadText(`${doc.name.replace(/\.(md|markdown)$/i, "") || "note"}.md`, content, "text/markdown");
}
