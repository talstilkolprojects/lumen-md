/**
 * The vault integrity check command (plan W1.5), loaded when it runs.
 */
import { t } from "../../i18n";
import { useAppStore } from "../../store/useStore";
import { flushActiveWorkspaceDoc } from "../../store/openDocs";
import { uiConfirm } from "../../ui/PromptDialog";
import { showAiToast } from "../../ui/AiToast";
import { openTemplateDoc } from "../../commands/openDoc";
import { getVaultBackend } from "./index";
import { checkVault, repairVault, REPAIRABLE } from "./integrity";
import { explainError } from "../../lib/userError";

/**
 * The vault integrity check (plan W1.5): a report note, then — when
 * something can be repaired — one confirmation and the repair, with a
 * backup of every file first. Notes open in a tab are never touched.
 */
export async function runVaultCheck(): Promise<void> {
  try {
    await flushActiveWorkspaceDoc();
    showAiToast(t("vaultCheck.checking"), "info");
    const backend = getVaultBackend();
    const report = await checkVault(backend);
    // The report module registers the vault-check strings; it loads only here.
    const { formatIntegrityReport } = await import("./integrityReport");
    openTemplateDoc(t("vaultCheck.title"), formatIntegrityReport(report));
    const open = new Set(useAppStore.getState().openTabs.map((tab) => tab.workspaceName).filter(Boolean));
    const current = useAppStore.getState().doc.workspaceName;
    if (current) open.add(current);
    const todo = report.findings.filter((f) => REPAIRABLE.has(f.kind) && !open.has(f.path));
    if (!todo.length) return;
    const folder = ".lumen-repair/";
    if (!(await uiConfirm({ message: t("vaultCheck.confirm", { n: todo.length, folder }) }))) return;
    const r = await repairVault(backend, todo);
    window.dispatchEvent(new CustomEvent("lumen-workspace-changed"));
    showAiToast(t("vaultCheck.repaired", { n: r.repaired.length, folder: r.backup ?? folder }), r.skipped.length ? "info" : "success");
    if (r.skipped.length) showAiToast(t("vaultCheck.skipped", { n: r.skipped.length }), "info");
  } catch (e) {
    showAiToast(t("vaultCheck.failed", { error: explainError(e) }), "error");
  }
}
