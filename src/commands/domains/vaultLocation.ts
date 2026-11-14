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
import { explainError } from "../../lib/userError";

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

/** Feature flags (plan 14.4): beta features on or off on this device. */
export function buildFeatureFlagCommands(): Command[] {
  return [
    {
      id: "app.featureFlags",
      label: t("cmd.app.featureFlags"),
      hint: t("cmd.app.featureFlags.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => window.dispatchEvent(new CustomEvent("lumen-open-feature-flags")),
    },
  ];
}

/** Desktop updates (plan 11.5): checked only on request, never in local-only. */
export function buildDesktopUpdateCommands(): Command[] {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return [];
  return [
    {
      // Plan W3.9: another editor window (⌘⇧N in the menu bar).
      id: "window.new",
      label: t("cmd.window.new"),
      hint: t("cmd.window.new.hint"),
      icon: cmdIcons.FileText,
      group: t("group.file"),
      action: async () => (await import("../../desktop/shell")).newWindow(),
    },
    {
      id: "app.checkUpdates",
      label: t("cmd.app.checkUpdates"),
      hint: t("cmd.app.checkUpdates.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: async () => {
        const { checkForUpdate, installUpdate } = await import("../../desktop/updates");
        const { uiConfirm } = await import("../../ui/PromptDialog");
        try {
          const r = await checkForUpdate();
          if (r.state === "blocked-local-only") return showAiToast(t("update.localOnly"), "info");
          if (r.state === "not-configured") return showAiToast(t("update.notConfigured"), "info");
          if (r.state === "up-to-date") return showAiToast(t("update.upToDate", { version: r.current }), "success");
          if (r.state !== "available") return;
          const ok = await uiConfirm({ title: t("update.available.title", { version: r.version }), message: r.notes || t("update.available.body", { current: r.current, version: r.version }), okLabel: t("update.install") });
          if (ok) await installUpdate();
        } catch (e) {
          showAiToast(t("update.failed", { message: explainError(e) }), "error");
        }
      },
    },
    {
      // Plan 14.4: stable follows releases; beta also gets betas. Switching back
      // to stable keeps this version until a stable release passes it.
      id: "app.updateChannel",
      label: t("cmd.app.updateChannel"),
      hint: t("cmd.app.updateChannel.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: async () => {
        const { setUpdateChannel, updateChannel } = await import("../../desktop/updates");
        const next = updateChannel() === "beta" ? "stable" : "beta";
        setUpdateChannel(next);
        showAiToast(next === "beta" ? t("update.channel.beta") : t("update.channel.stable"), "info");
      },
    },
  ];
}

/** "What's new" (plan 14.6): this version's notes, in the interface's language. */
export function buildWhatsNewCommands(): Command[] {
  return [
    {
      id: "help.whatsNew",
      label: t("cmd.help.whatsNew"),
      icon: cmdIcons.Sparkles,
      group: t("group.file"),
      action: () => void import("../../whatsNew/check").then((m) => m.openWhatsNew()),
    },
  ];
}
