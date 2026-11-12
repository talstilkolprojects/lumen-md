/** Vault commands: Vault Doctor, export / import, digest and encryption. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { t } from "../../i18n";
import type { CommandContext } from "./context";

/** Vault Doctor: a report on the workspace, and fixing its broken wiki links. */
export function buildVaultDoctorCommands(): Command[] {
  return [
    {
      id: "tools.vaultDoctor",
      label: t("cmd.tools.vaultDoctor"),
      hint: t("cmd.tools.vaultDoctor.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => (await import("./vaultDoctorActions")).runDoctor(),
    },
    {
      id: "tools.vaultDoctorFix",
      destructive: "confirm",
      label: t("cmd.tools.vaultDoctorFix"),
      hint: t("cmd.tools.vaultDoctorFix.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => (await import("./vaultDoctorActions")).fixDoctorLinks(),
    },
    {
      id: "vault.check",
      label: t("cmd.vault.check"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => (await import("../../storage/vault/integrityCommand")).runVaultCheck(),
    },
  ];
}


/** Export the whole vault (zip or folder) and import one. */
export function buildVaultTransferCommands(): Command[] {
  return [
    {
      id: "vault.backups",
      label: t("cmd.vault.backups"),
      hint: t("cmd.vault.backups.hint"),
      icon: cmdIcons.Save,
      group: t("group.file"),
      // Plan W1.6: lazy, with its own root.
      action: () => void import("../../backup/BackupPanel").then((m) => m.openBackupPanel()),
    },
    {
      id: "vault.export",
      label: t("cmd.vault.export"),
      hint: t("cmd.vault.export.hint"),
      icon: cmdIcons.Save,
      group: t("group.file"),
      action: async () => (await import("./vaultActions")).exportVault(),
    },
    {
      id: "vault.import",
      label: t("cmd.vault.import"),
      hint: t("cmd.vault.import.hint"),
      icon: cmdIcons.Save,
      group: t("group.file"),
      action: () => {
        window.dispatchEvent(new Event("lumen-open-import"));
      },
    },
    {
      id: "vault.importUndo",
      label: t("cmd.vault.importUndo"),
      hint: t("cmd.vault.importUndo.hint"),
      icon: cmdIcons.Save,
      group: t("group.file"),
      action: async () => (await import("./vaultActions")).undoLastImport(),
    },
    {
      // Plan W5.7: an exported WhatsApp / Telegram chat → notes, on this device.
      id: "vault.importChat",
      label: t("cmd.chat.import"),
      hint: t("cmd.chat.import.hint"),
      icon: cmdIcons.Save,
      group: t("group.file"),
      action: async () => {
        if (!(await import("../../storage/workspace")).isOPFSAvailable()) return;
        await (await import("../../capture/chats/runImport")).runChatImport();
      },
    },
    {
      // Plan W5.18: .eml / .mbox and a Google Takeout zip → notes, from files only.
      id: "vault.importMail",
      label: t("cmd.mail.import"),
      hint: t("cmd.mail.import.hint"),
      icon: cmdIcons.Save,
      group: t("group.file"),
      action: async () => {
        if (!(await import("../../storage/workspace")).isOPFSAvailable()) return;
        await (await import("../../capture/mail/runImport")).runMailImport();
      },
    },
  ];
}

/** Digest of the notes changed since the last one. */
export function buildDigestCommands(): Command[] {
  return [
    {
      id: "vault.digest",
      label: t("cmd.vault.digest"),
      hint: t("cmd.vault.digest.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => (await import("./vaultActions")).writeDigest(),
    },
  ];
}

/** Encrypt or decrypt the open note. */
export function buildEncryptionCommands({ setContent, liveDoc }: CommandContext): Command[] {
  return [
    {
      id: "vault.encrypt",
      label: t("cmd.security.encrypt"),
      hint: t("cmd.security.encrypt.hint"),
      icon: cmdIcons.Save,
      group: t("group.security"),
      action: async () => (await import("./vaultActions")).encryptOpenNote({ setContent, liveDoc }),
    },
    {
      id: "vault.decrypt",
      label: t("cmd.security.decrypt"),
      hint: t("cmd.security.decrypt.hint"),
      icon: cmdIcons.Save,
      group: t("group.security"),
      action: async () => (await import("./vaultActions")).decryptOpenNote({ setContent, liveDoc }),
    },
    {
      // The whole vault, encrypted where it is stored (plan 11.4).
      id: "vault.encryptAtRest",
      label: t("cmd.vault.encryptAtRest"),
      hint: t("cmd.vault.encryptAtRest.hint"),
      icon: cmdIcons.Save,
      group: t("group.security"),
      action: () => void import("../../ui/VaultEncryptionDialog").then((m) => m.showVaultEncryptionDialog()),
    },
  ];
}
