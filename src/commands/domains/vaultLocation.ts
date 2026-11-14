/**
 * Where the vault lives (plan 4.2): move it into a real folder, open an
 * existing folder as the vault, or move it back to browser storage. Browsers
 * without `showDirectoryPicker` (Firefox, Safari) get a clear message that
 * the vault stays in browser storage.
 */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { t } from "../../i18n";
import { showAiToast } from "../../ui/AiToast";

async function flushOpenNote(): Promise<void> {
  const { flushActiveWorkspaceDoc } = await import("../../store/openDocs");
  await flushActiveWorkspaceDoc();
}

/** Toast for a failed move: conflicts, permission, or anything else. */
async function reportMoveError(e: unknown, folder: string): Promise<void> {
  const { VaultMoveConflictError, VaultPermissionError } = await import("../../storage/vault/location");
  if (e instanceof VaultMoveConflictError) {
    showAiToast(t("vault.folder.conflict", { n: String(e.paths.length), folder, path: e.paths[0] }), "error");
  } else if (e instanceof VaultPermissionError) {
    showAiToast(t("vault.folder.permissionDenied", { folder }), "error");
  } else {
    showAiToast(t("vault.folder.failed", { error: (e as Error).message }), "error");
  }
}

export function buildVaultLocationCommands(): Command[] {
  return [
    {
      id: "vault.toFolder",
      label: t("cmd.vault.toFolder"),
      hint: t("cmd.vault.toFolder.hint"),
      icon: cmdIcons.FolderOpen,
      group: t("group.file"),
      action: async () => {
        const loc = await import("../../storage/vault/location");
        if (!loc.isFolderVaultSupported()) return showAiToast(t("vault.folder.unsupported"), "info");
        const handle = await loc.pickVaultFolder();
        if (!handle) return;
        try {
          await flushOpenNote();
          const r = await loc.moveVault({ kind: "folder", handle, name: handle.name });
          showAiToast(t("vault.folder.moved", { folder: handle.name, n: String(r.files) }), "info");
        } catch (e) {
          await reportMoveError(e, handle.name);
        }
      },
    },
    {
      id: "vault.openFolder",
      label: t("cmd.vault.openFolder"),
      hint: t("cmd.vault.openFolder.hint"),
      icon: cmdIcons.FolderOpen,
      group: t("group.file"),
      action: async () => {
        const loc = await import("../../storage/vault/location");
        if (!loc.isFolderVaultSupported()) return showAiToast(t("vault.folder.unsupported"), "info");
        const handle = await loc.pickVaultFolder();
        if (!handle) return;
        await flushOpenNote();
        if (await loc.openFolderAsVault(handle)) showAiToast(t("vault.folder.opened", { folder: handle.name }), "info");
        else showAiToast(t("vault.folder.permissionDenied", { folder: handle.name }), "error");
      },
    },
    {
      id: "vault.toBrowser",
      label: t("cmd.vault.toBrowser"),
      hint: t("cmd.vault.toBrowser.hint"),
      icon: cmdIcons.Save,
      group: t("group.file"),
      action: async () => {
        const loc = await import("../../storage/vault/location");
        const status = loc.getVaultStatus();
        if (status.location === "opfs") return showAiToast(t("vault.folder.alreadyBrowser"), "info");
        if (status.location === "folder-disconnected") return showAiToast(t("vault.folder.reconnectBody", { folder: status.name }), "info");
        if (status.location === "restoring") return showAiToast(t("vault.folder.restoring"), "info");
        try {
          await flushOpenNote();
          const r = await loc.moveVault({ kind: "opfs" });
          showAiToast(t("vault.folder.movedBack", { folder: status.name, n: String(r.files) }), "info");
        } catch (e) {
          await reportMoveError(e, status.name);
        }
      },
    },
  ];
}
