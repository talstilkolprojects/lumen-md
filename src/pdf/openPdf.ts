/**
 * "Open a PDF for reading…" (plan 4.14): copy a PDF from the computer into
 * the vault and open it in the reader. Its own chunk, loaded by the command.
 */

import "./strings";
import { t } from "../i18n";
import { showAiToast } from "../ui/AiToast";
import { isOPFSAvailable, uniqueWorkspaceName, writeWorkspaceBlob } from "../storage/workspace";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { explainError } from "../lib/userError";

export function pickAndOpenPdf(): void {
  if (!isOPFSAvailable()) {
    showAiToast(t("pdf.noWorkspace"), "error");
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".pdf,application/pdf";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const path = await uniqueWorkspaceName(/\.pdf$/i.test(file.name) ? file.name : `${file.name}.pdf`);
      await writeWorkspaceBlob(path, file);
      notifyWorkspaceChanged();
      window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path } }));
    } catch (e) {
      showAiToast(t("pdf.failed", { error: explainError(e) }), "error");
    }
  };
  input.click();
}
