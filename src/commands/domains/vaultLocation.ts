/**
 * Where the vault lives (plan 4.2): move it into a real folder, open an
 * existing folder as the vault, or move it back to browser storage. In the
 * desktop app (4.3) the folder comes from the native dialog; in the phone
 * app (4.20) it is the Files-app folder (iOS) or a picked folder (Android). Browsers
 * without `showDirectoryPicker` (Firefox, Safari) get a clear message that
 * the vault stays in browser storage.
 */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { t } from "../../i18n";
import { showAiToast } from "../../ui/AiToast";

const actions = () => import("../../ui/vaultFolderActions");

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
        const { isDesktopApp } = await import("../../storage/vault/tauri");
        if (isDesktopApp()) return (await actions()).chooseDesktopFolder();
        if (loc.isMobileApp()) return (await actions()).chooseMobileFolder();
        if (!loc.isFolderVaultSupported()) return showAiToast(t("vault.folder.unsupported"), "info");
        const handle = await loc.pickVaultFolder();
        if (!handle) return;
        try {
          await (await actions()).flushOpenNote();
          const r = await loc.moveVault({ kind: "folder", handle, name: handle.name });
          showAiToast(t("vault.folder.moved", { folder: handle.name, n: String(r.files) }), "info");
        } catch (e) {
          await (await actions()).reportMoveError(e, handle.name);
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
        const { isDesktopApp } = await import("../../storage/vault/tauri");
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
          await (await actions()).flushOpenNote();
          const r = await loc.moveVault({ kind: "opfs" });
          showAiToast(t("vault.folder.movedBack", { folder: status.name, n: String(r.files) }), "info");
        } catch (e) {
          await (await actions()).reportMoveError(e, status.name);
        }
      },
    },
  ];
}
