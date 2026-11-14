/**
 * "Open an EPUB for reading…" (plan W1.14): copy a book from the computer
 * into the vault and open it in the reader. Its own chunk, loaded by the command.
 */
import "./strings";
import { t } from "../i18n";
import { showAiToast } from "../ui/AiToast";
import { isOPFSAvailable, uniqueWorkspaceName, writeWorkspaceBlob } from "../storage/workspace";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { explainError } from "../lib/userError";

export function pickAndOpenEpub(): void {
  if (!isOPFSAvailable()) {
    showAiToast(t("epub.noWorkspace"), "error");
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".epub,application/epub+zip";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const path = await uniqueWorkspaceName(/\.epub$/i.test(file.name) ? file.name : `${file.name}.epub`);
      await writeWorkspaceBlob(path, file);
      notifyWorkspaceChanged();
      window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path } }));
    } catch (e) {
      showAiToast(t("epub.failed", { error: explainError(e) }), "error");
    }
  };
  input.click();
}
