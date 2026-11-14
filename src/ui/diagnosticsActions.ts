/** Save the diagnostics bundle (plan W3.7) — the user attaches it to an issue. */
import { collectDiagnostics, diagnosticsText } from "../feedback/diagnostics";
import { showAiToast } from "./AiToast";
import { t } from "../i18n";
import { log } from "../lib/logger";

export async function saveDiagnostics(): Promise<void> {
  try {
    const text = diagnosticsText(await collectDiagnostics());
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = `lumen-diagnostics-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showAiToast(t("diagnostics.saved"), "success");
  } catch (e) {
    log.warn("diagnostics: could not build", e);
    showAiToast(t("diagnostics.failed"), "error");
  }
}
