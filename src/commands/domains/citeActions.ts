/** The body of "cite a ruling from the case number at the cursor" (./export.ts), loaded on first use. */
import type { EditorView } from "@codemirror/view";
import { t } from "../../i18n";
import { showAiToast } from "../../ui/AiToast";
import "./commandBodiesStrings";

/** Open the legal-citation dialog for the case number at the cursor (or empty, saying why). */
export async function legalCiteFromCase(view: EditorView): Promise<void> {
  const [{ caseNumberAt, rulingFromMatch }, dialog] = await Promise.all([import("../../citations/legal"), import("../../citations/LegalCiteDialog")]);
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const m = caseNumberAt(line.text, view.state.selection.main.head - line.from);
  if (!m) {
    showAiToast(t("toast.cite.noCaseNumber"), "info");
    dialog.openLegalCiteDialog();
    return;
  }
  // why: the citation replaces the case number it was made from
  view.dispatch({ selection: { anchor: line.from + m.from, head: line.from + m.to } });
  dialog.openLegalCiteDialog(rulingFromMatch(m));
}
