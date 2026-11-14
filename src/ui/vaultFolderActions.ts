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

/** Say so when notes saved during the switch went to the new vault as conflict copies (2.9). */
export function reportLateCopies(r: { conflictCopies?: string[] }): void {
  const copies = r.conflictCopies ?? [];
  if (copies.length) showAiToast(t("vault.folder.lateCopies", { n: String(copies.length), path: copies[0] }), "info");
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

// The vault-location commands' bodies (plan 4.2), here so the palette's startup list carries only their names.
const actions = async () => ({ flushOpenNote, reportMoveError, chooseDesktopFolder, chooseMobileFolder });

/** Move the vault into a real folder (desktop dialog, phone folder or the browser's folder picker). */
export async function moveVaultToFolder(): Promise<void> {
  const loc = await import("../storage/vault/location");
  const { isDesktopApp } = await import("../storage/vault/tauri");
  if (isDesktopApp()) return (await actions()).chooseDesktopFolder();
  if (loc.isMobileApp()) return (await actions()).chooseMobileFolder();
  if (!loc.isFolderVaultSupported()) return showAiToast(t("vault.folder.unsupported"), "info");
  const handle = await loc.pickVaultFolder();
  if (!handle) return;
  try {
    await (await actions()).flushOpenNote();
    const r = await loc.moveVault({ kind: "folder", handle, name: handle.name });
    showAiToast(t("vault.folder.moved", { folder: handle.name, n: String(r.files) }), "info");
    reportLateCopies(r);
  } catch (e) {
    await (await actions()).reportMoveError(e, handle.name);
  }
}

/** Open an existing folder as the vault. */
export async function openFolderAsVaultCommand(): Promise<void> {
  const loc = await import("../storage/vault/location");
  const { isDesktopApp } = await import("../storage/vault/tauri");
  if (isDesktopApp()) {
    await (await actions()).flushOpenNote();
    const name = await loc.openDesktopFolderAsVault();
    if (name) showAiToast(t("vault.folder.opened", { folder: name }), "info");
    return;
  }
  if (loc.isMobileApp()) {
    await (await actions()).flushOpenNote();
    try {
      const name = await loc.openMobileFolderAsVault();
      if (name) showAiToast(t("vault.folder.opened", { folder: name }), "info");
    } catch (e) {
      await (await actions()).reportMoveError(e, "");
    }
    return;
  }
  if (!loc.isFolderVaultSupported()) return showAiToast(t("vault.folder.unsupported"), "info");
  const handle = await loc.pickVaultFolder();
  if (!handle) return;
  await (await actions()).flushOpenNote();
  if (await loc.openFolderAsVault(handle)) showAiToast(t("vault.folder.opened", { folder: handle.name }), "info");
  else showAiToast(t("vault.folder.permissionDenied", { folder: handle.name }), "error");
}

/** Move the vault back to browser storage. */
export async function moveVaultToBrowser(): Promise<void> {
  const loc = await import("../storage/vault/location");
  const status = loc.getVaultStatus();
  if (status.location === "opfs") return showAiToast(t("vault.folder.alreadyBrowser"), "info");
  if (status.location === "folder-disconnected") return showAiToast(t("vault.folder.reconnectBody", { folder: status.name }), "info");
  if (status.location === "restoring") return showAiToast(t("vault.folder.restoring"), "info");
  try {
    await (await actions()).flushOpenNote();
    const r = await loc.moveVault({ kind: "opfs" });
    showAiToast(t("vault.folder.movedBack", { folder: status.name, n: String(r.files) }), "info");
    reportLateCopies(r);
  } catch (e) {
    await (await actions()).reportMoveError(e, status.name);
  }
}
