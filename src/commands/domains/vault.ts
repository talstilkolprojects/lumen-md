/** Vault commands: Vault Doctor, export / import, digest and encryption. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { useAppStore } from "../../store/useStore";
import { t, getLocale } from "../../i18n";
import { uiConfirm, uiPrompt, uiSelect } from "../../ui/PromptDialog";
import { showAiToast } from "../../ui/AiToast";
import { encryptDocument, decryptDocument, isEncrypted } from "../../storage/encryption";
import { isOPFSAvailable, readWorkspaceFile } from "../../storage/workspace";
import { openTemplateDoc } from "../openDoc";
import type { CommandContext } from "./context";

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

/** Vault Doctor: a report on the workspace, and fixing its broken wiki links. */
export function buildVaultDoctorCommands(): Command[] {
  return [
    {
      id: "tools.vaultDoctor",
      label: t("cmd.tools.vaultDoctor"),
      hint: t("cmd.tools.vaultDoctor.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const notes = await loadDoctorNotes();
        if (!notes) return;
        showAiToast(t("doctor.checking", { count: notes.length }), "info");
        const { runVaultDoctor, formatDoctorReport } = await import("../../lint/vaultDoctor");
        const findings = runVaultDoctor(notes);
        openTemplateDoc("Vault Doctor report", formatDoctorReport(findings, notes.length));
        showAiToast(t("doctor.done", { count: findings.length }), findings.length ? "info" : "success");
      },
    },
    {
      id: "tools.vaultDoctorFix",
      label: t("cmd.tools.vaultDoctorFix"),
      hint: t("cmd.tools.vaultDoctorFix.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
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
      },
    },
  ];
}

/** Export the whole vault (zip or folder) and import one. */
export function buildVaultTransferCommands(): Command[] {
  return [
    {
      id: "vault.export",
      label: t("cmd.vault.export"),
      hint: t("cmd.vault.export.hint"),
      icon: cmdIcons.Save,
      group: t("group.file"),
      action: async () => {
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
          showAiToast(t("vault.export.failed", { error: (e as Error).message }), "error");
        }
      },
    },
    {
      id: "vault.import",
      label: t("cmd.vault.import"),
      hint: t("cmd.vault.import.hint"),
      icon: cmdIcons.Save,
      group: t("group.file"),
      action: async () => {
        const choice = await uiSelect({ message: t("vault.import.what"), choices: [{ value: "zip", label: t("vault.import.zip") }, { value: "folder", label: t("vault.import.folder") }] });
        if (!choice) return;
        const input = document.createElement("input");
        input.type = "file";
        if (choice === "zip") input.accept = ".zip,application/zip";
        else (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
        input.onchange = async () => {
          const files = input.files;
          if (!files?.length) return;
          const { importZip, importFileList } = await import("../../storage/exportAll");
          try {
            const r = choice === "zip" ? await importZip(await files[0].arrayBuffer(), files[0].name) : await importFileList(files);
            window.dispatchEvent(new Event("lumen-workspace-changed"));
            showAiToast(t("vault.import.done", { notes: String(r.notes), files: String(r.attachments), folder: r.folder, source: r.source }), "info");
          } catch (e) {
            showAiToast(t("vault.import.failed", { error: (e as Error).message }), "error");
          }
        };
        input.click();
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
      action: async () => {
        const { listWorkspace, readWorkspaceFile, writeWorkspaceFile, isOPFSAvailable } = await import("../../storage/workspace");
        if (!isOPFSAvailable()) return;
        const { writeDigest } = await import("../../agents/defs/digester");
        const KEY = "lumen.digest.last";
        const now = Date.now();
        let since = now - 24 * 3600_000;
        try {
          since = Number(localStorage.getItem(KEY)) || since;
        } catch {
          /* default: last 24 h */
        }
        const lang = getLocale();
        const folder = lang === "he" ? "סיכומים" : "Digests";
        const fmtDate = (ms: number) => new Date(ms).toLocaleString(getLocale(), { dateStyle: "medium", timeStyle: "short" });
        const res = await writeDigest(
          { list: () => listWorkspace({ includeAssets: false }), read: readWorkspaceFile, write: writeWorkspaceFile },
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
        } catch {
          /* next digest covers 24 h again */
        }
        window.dispatchEvent(new Event("lumen-workspace-changed"));
        useAppStore.getState().openTab({ name: path.split("/").pop()!, content: body, workspaceName: path });
      },
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
      action: async () => {
        const password = await uiPrompt({ message: "Enter encryption password:" });
        if (!password) return;
        const encrypted = await encryptDocument(liveDoc().content, password);
        setContent(encrypted);
        showAiToast(t("toast.documentEncrypted"), "info");
      },
    },
    {
      id: "vault.decrypt",
      label: t("cmd.security.decrypt"),
      hint: t("cmd.security.decrypt.hint"),
      icon: cmdIcons.Save,
      group: t("group.security"),
      action: async () => {
        if (!isEncrypted(liveDoc().content)) {
          showAiToast(t("toast.documentIsNotEncrypted"), "error");
          return;
        }
        const password = await uiPrompt({ message: "Enter decryption password:" });
        if (!password) return;
        try {
          const decrypted = await decryptDocument(liveDoc().content, password);
          setContent(decrypted);
          showAiToast(t("toast.documentDecrypted"), "info");
        } catch {
          showAiToast(t("toast.wrongPassword"), "error");
        }
      },
    },
  ];
}
