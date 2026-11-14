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

const actions = () => import("../../ui/vaultFolderActions");

export function buildVaultLocationCommands(): Command[] {
  return [
    {
      id: "vault.toFolder",
      label: t("cmd.vault.toFolder"),
      hint: t("cmd.vault.toFolder.hint"),
      icon: cmdIcons.FolderOpen,
      group: t("group.file"),
      action: async () => (await actions()).moveVaultToFolder(),
    },
    {
      id: "vault.openFolder",
      label: t("cmd.vault.openFolder"),
      hint: t("cmd.vault.openFolder.hint"),
      icon: cmdIcons.FolderOpen,
      group: t("group.file"),
      action: async () => (await actions()).openFolderAsVaultCommand(),
    },
    {
      id: "vault.toBrowser",
      label: t("cmd.vault.toBrowser"),
      hint: t("cmd.vault.toBrowser.hint"),
      icon: cmdIcons.Save,
      group: t("group.file"),
      action: async () => (await actions()).moveVaultToBrowser(),
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
      action: () => import("./updateActions").then((m) => m.checkUpdates()),
    },
    {
      // Plan 14.4: stable follows releases; beta also gets betas. Switching back
      // to stable keeps this version until a stable release passes it.
      id: "app.updateChannel",
      label: t("cmd.app.updateChannel"),
      hint: t("cmd.app.updateChannel.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: () => import("./updateActions").then((m) => m.chooseUpdateChannel()),
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
