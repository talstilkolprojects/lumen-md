/**
 * The vault commands' bodies (export, undoing an import, digest, encryption), loaded
 * when one runs — out of the startup bundle, which the merge engine (plan
 * W1.9) and safe git's strings needed room in. Same behaviour. Vault
 * Doctor's bodies are in ./vaultDoctorActions.
 */
import { useAppStore } from "../../store/useStore";
import { t, getLocale } from "../../i18n";
import { uiPrompt, uiSelect } from "../../ui/PromptDialog";
import { showAiToast } from "../../ui/AiToast";
import { encryptDocument, decryptDocument, isEncrypted } from "../../storage/encryption";
import { explainError } from "../../lib/userError";
import type { CommandContext } from "./context";
import "./vaultActionsStrings";

export async function exportVault(): Promise<void> {
  const { exportVaultZip, exportVaultToFolder } = await import("../../storage/exportAll");
  const { flushActiveWorkspaceDoc } = await import("../../store/openDocs");
  try {
    const picker = (window as unknown as { showDirectoryPicker?: (o?: object) => Promise<unknown> }).showDirectoryPicker;
    const choice = picker
      ? await uiSelect({ message: t("vault.export.where"), choices: [{ value: "zip", label: t("vault.export.zip") }, { value: "folder", label: t("vault.export.folder") }] })
      : "zip";
    if (!choice) return;
    // The export reads the vault from disk: include edits the
    // debounced autosave has not written yet.
    await flushActiveWorkspaceDoc();
    if (choice === "folder" && picker) {
      // A WebIDL method: it must be called on `window` (Illegal invocation otherwise).
      const dir = await picker.call(window, { mode: "readwrite" });
      const r = await exportVaultToFolder(dir as Parameters<typeof exportVaultToFolder>[0]);
      showAiToast(t("vault.export.doneFolder", { n: String(r.files), folder: r.folder }), "info");
      return;
    }
    const { bytes, files } = await exportVaultZip();
    const { downloadBytes } = await import("../../storage/exportFormats");
    downloadBytes(`lumen-vault-${new Date().toISOString().slice(0, 10)}.zip`, bytes, "application/zip");
    showAiToast(t("vault.export.done", { n: String(files) }), "info");
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") return;
    showAiToast(t("vault.export.failed", { error: explainError(e) }), "error");
  }

}

/** Undo the last import (plan W1.26 import wizard): its notes leave, or go to the trash if edited since. */
export async function undoLastImport(): Promise<void> {
  const { lastImport, undoImport } = await import("../../storage/import/commit");
  await import("../../storage/import/strings");
  const last = lastImport();
  const r = last ? await undoImport(last) : "gone";
  window.dispatchEvent(new Event("lumen-workspace-changed"));
  showAiToast(t(r === "removed" ? "importWizard.undone" : r === "trashed" ? "importWizard.undoneTrash" : "importWizard.undoGone"), "info");
}

export async function writeDigest(): Promise<void> {
  const { readWorkspaceFile, writeWorkspaceFile, isOPFSAvailable } = await import("../../storage/workspace");
  if (!isOPFSAvailable()) return;
  // The digest reads the vault through the agent runtime's tools
  // (list_files + read_file, plan 5.3.3); it writes its own note.
  const { callTool } = await import("../../agents/runtime");
  const { digestFolder, writeDigest, toolDigestIO } = await import("../../agents/defs/digester");
  const KEY = "lumen.digest.last";
  const now = Date.now();
  let since = now - 24 * 3600_000;
  try {
    since = Number(localStorage.getItem(KEY)) || since;
  } catch {
    /* why: storage denied: the digest covers the last 24 h */
  }
  const lang = getLocale();
  const FOLDER_KEY = "lumen.digest.folder";
  let storedFolder: string | null = null;
  try {
    storedFolder = localStorage.getItem(FOLDER_KEY);
  } catch {
    /* why: the UI language's default */
  }
  // Fixed once chosen: a language switch keeps writing to the same folder (and the same day's note).
  const folder = digestFolder(storedFolder, lang);
  const fmtDate = (ms: number) => new Date(ms).toLocaleString(getLocale(), { dateStyle: "medium", timeStyle: "short" });
  const res = await writeDigest(
    toolDigestIO({ callTool, readOwn: readWorkspaceFile, write: writeWorkspaceFile, since, now, folder }),
    { since, now, lang, folder, formatDate: fmtDate },
  );
  if (!res.ok) {
    // The checkpoint stays, so these notes are in the next digest.
    showAiToast(t("toast.digest.readFailed", { count: res.failed.length }), "error");
    return;
  }
  const { path, body } = res;
  try {
    localStorage.setItem(KEY, String(now));
    localStorage.setItem(FOLDER_KEY, folder);
  } catch {
    /* why: next digest covers 24 h again */
  }
  window.dispatchEvent(new Event("lumen-workspace-changed"));
  useAppStore.getState().openTab({ name: path.split("/").pop()!, content: body, workspaceName: path });

}

export async function encryptOpenNote({ setContent, liveDoc }: Pick<CommandContext, "setContent" | "liveDoc">): Promise<void> {
  const password = await uiPrompt({ message: t("vault.prompt.encryptPassword") });
  if (!password) return;
  const encrypted = await encryptDocument(liveDoc().content, password);
  setContent(encrypted);
  showAiToast(t("toast.documentEncrypted"), "info");

}

export async function decryptOpenNote({ setContent, liveDoc }: Pick<CommandContext, "setContent" | "liveDoc">): Promise<void> {
  if (!isEncrypted(liveDoc().content)) {
    showAiToast(t("toast.documentIsNotEncrypted"), "error");
    return;
  }
  const password = await uiPrompt({ message: t("vault.prompt.decryptPassword") });
  if (!password) return;
  try {
    const decrypted = await decryptDocument(liveDoc().content, password);
    setContent(decrypted);
    showAiToast(t("toast.documentDecrypted"), "info");
  } catch {
    showAiToast(t("toast.wrongPassword"), "error");
  }

}
