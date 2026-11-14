/**
 * The UI side of moving the vault (plans 4.2 / 4.3), shared by the vault
 * commands and the vault banner: flush the open note, run the move, report
 * the result. Loaded on demand (not part of the startup bundle).
 */
import { t } from "../i18n";
import { showAiToast } from "./AiToast";
import { flushActiveWorkspaceDoc } from "../store/openDocs";

export async function flushOpenNote(): Promise<void> {
  await flushActiveWorkspaceDoc();
}

/** Toast for a failed move: conflicts, permission, or anything else. */
export async function reportMoveError(e: unknown, folder: string): Promise<void> {
  const { VaultMoveConflictError, VaultPermissionError } = await import("../storage/vault/location");
  if (e instanceof VaultMoveConflictError) {
    showAiToast(t("vault.folder.conflict", { n: String(e.paths.length), folder, path: e.paths[0] }), "error");
  } else if (e instanceof VaultPermissionError) {
    showAiToast(t("vault.folder.permissionDenied", { folder }), "error");
  } else {
    showAiToast(t("vault.folder.failed", { error: (e as Error).message }), "error");
  }
}

/**
 * Desktop (plan 4.3): pick the vault folder in the native dialog; notes in
 * the app storage are backed up, then moved there (copy → byte check →
 * switch). Used by the first-run prompt and by "Move the vault to a folder…".
 */
export async function chooseDesktopFolder(): Promise<void> {
  const loc = await import("../storage/vault/location");
  try {
    await flushOpenNote();
    const r = await loc.chooseDesktopVaultFolder();
    if (!r) return;
    const name = loc.getVaultStatus().location === "folder" ? (loc.getVaultStatus() as { name: string }).name : "";
    if (r.backup) showAiToast(t("vault.desktop.backedUp", { path: r.backup }), "info");
    showAiToast(r.files ? t("vault.folder.moved", { folder: name, n: String(r.files) }) : t("vault.folder.opened", { folder: name }), "info");
  } catch (e) {
    await reportMoveError(e, "");
  }
}


/**
 * Phone (plan 4.20): move the vault into a folder on the device — iOS: the
 * app's folder in the Files app; Android: a folder the user picks (or the
 * app's folder). Notes in the app storage are copied (copy → byte check →
 * switch); the app storage is kept.
 */
export async function chooseMobileFolder(): Promise<void> {
  const loc = await import("../storage/vault/location");
  try {
    await flushOpenNote();
    const r = await loc.chooseMobileVaultFolder();
    if (!r) return;
    const status = loc.getVaultStatus();
    const name = status.location === "folder" ? status.name : "";
    showAiToast(r.files ? t("vault.folder.moved", { folder: name, n: String(r.files) }) : t("vault.folder.opened", { folder: name }), "info");
  } catch (e) {
    await reportMoveError(e, "");
  }
}
