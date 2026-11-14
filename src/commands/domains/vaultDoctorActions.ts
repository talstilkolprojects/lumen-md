/**
 * Vault Doctor's commands (plan D5), loaded when one runs: the report, and
 * applying its suggested link fixes. Moved out of the startup bundle.
 */
import { useAppStore } from "../../store/useStore";
import { t } from "../../i18n";
import { uiConfirm } from "../../ui/PromptDialog";
import { showAiToast } from "../../ui/AiToast";
import { isOPFSAvailable, readWorkspaceFile } from "../../storage/workspace";
import { openTemplateDoc } from "../openDoc";
import "./vaultDoctorActionsStrings";

/** Every Markdown note in the workspace, for Vault Doctor (null when there is none). */
async function loadDoctorNotes(): Promise<Array<{ path: string; text: string }> | null> {
  if (!isOPFSAvailable()) {
    showAiToast(t("doctor.noWorkspace"), "error");
    return null;
  }
  const { listWorkspace } = await import("../../storage/workspace");
  const notes: Array<{ path: string; text: string }> = [];
  for (const f of await listWorkspace({ includeAssets: false })) {
    if (!/\.(md|markdown)$/i.test(f.path)) continue;
    try {
      notes.push({ path: f.path, text: await readWorkspaceFile(f.path) });
    } catch {
      // A missing note would look like a broken link target (and "fix"
      // links to it): stop rather than scan an incomplete workspace.
      showAiToast(t("doctor.readFailed", { path: f.path }), "error");
      return null;
    }
  }
  if (!notes.length) {
    showAiToast(t("doctor.noWorkspace"), "error");
    return null;
  }
  return notes;
}

/** Vault Doctor: Check Workspace. */
export async function runDoctor(): Promise<void> {
  const notes = await loadDoctorNotes();
  if (!notes) return;
  showAiToast(t("doctor.checking", { count: notes.length }), "info");
  const { runVaultDoctor, formatDoctorReport } = await import("../../lint/vaultDoctor");
  const findings = runVaultDoctor(notes);
  openTemplateDoc("Vault Doctor report", formatDoctorReport(findings, notes.length));
  showAiToast(t("doctor.done", { count: findings.length }), findings.length ? "info" : "success");
}

/** Vault Doctor: Apply Suggested Link Fixes. */
export async function fixDoctorLinks(): Promise<void> {
  const notes = await loadDoctorNotes();
  if (!notes) return;
  const { runVaultDoctor, applyLinkFixes } = await import("../../lint/vaultDoctor");
  // Notes open in a tab may hold unsaved edits: never rewrite them.
  const open = new Set(useAppStore.getState().openTabs.map((tab) => tab.workspaceName).filter(Boolean));
  const current = useAppStore.getState().doc.workspaceName;
  if (current) open.add(current);
  const byFile = new Map<string, Array<{ from: string; to: string }>>();
  for (const f of runVaultDoctor(notes)) {
    if (f.kind !== "broken-wiki-link" || !f.suggestion || !f.detail || open.has(f.path)) continue;
    byFile.set(f.path, [...(byFile.get(f.path) ?? []), { from: f.detail, to: f.suggestion }]);
  }
  const links = [...byFile.values()].reduce((n, l) => n + l.length, 0);
  if (!links) {
    showAiToast(t("doctor.noFixes"), "info");
    return;
  }
  const list = [...byFile]
    .flatMap(([path, fixes]) => fixes.map((x) => `${path}: [[${x.from}]] → [[${x.to}]]`))
    .slice(0, 15)
    .join("\n");
  const ok = await uiConfirm({ message: t("doctor.confirmFix", { links, files: byFile.size, list }) });
  if (!ok) return;
  const { writeWorkspaceFile } = await import("../../storage/workspace");
  for (const [path, fixes] of byFile) {
    const note = notes.find((n) => n.path === path)!;
    await writeWorkspaceFile(path, applyLinkFixes(note.text, fixes));
  }
  // Backlinks, tags, file tree and database views refresh on this.
  window.dispatchEvent(new CustomEvent("lumen-workspace-changed"));
  showAiToast(t("doctor.fixed", { links, files: byFile.size }), "success");
}
