/** File commands: new / open / save, recent files, trash, templates and the sample workspace. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { useAppStore } from "../../store/useStore";
import { t, getLocale } from "../../i18n";
import { getRecents, removeRecent } from "../../storage/recent";
import { uiAlert } from "../../ui/PromptDialog";
import { TEMPLATES } from "../../editor/templates";
import { buildInstalledTemplateCommands } from "../installedTemplates";
import { showAiToast } from "../../ui/AiToast";
import { isOPFSAvailable, readWorkspaceFile } from "../../storage/workspace";
import { relativeTime } from "../../lib/relativeTime";
import { openTemplateDoc } from "../openDoc";
import type { CommandContext } from "./context";
import { explainError } from "../../lib/userError";

/** Recently opened files (the last 8): reopen one, or drop it from the list. */
export function buildRecentCommands({ recents, setRecents, handleReopenRecent }: CommandContext): Command[] {
  return recents.slice(0, 8).flatMap((r) => [
    {
      id: `recent.${r.id}`,
      label: t("cmd.file.openRecent", { name: r.name }),
      hint: relativeTime(r.openedAt),
      icon: cmdIcons.FolderOpen,
      group: t("group.recent"),
      action: () => handleReopenRecent(r),
    },
    {
      id: `recent.remove.${r.id}`,
      label: t("cmd.file.removeRecent", { name: r.name }),
      icon: cmdIcons.FolderOpen,
      group: t("group.recent"),
      action: async () => {
        await removeRecent(r.id);
        setRecents(await getRecents());
      },
    },
  ]);
}

/** New, open, save, save as. */
export function buildFileCommands({ handleNew, handleOpen, handleSave }: CommandContext): Command[] {
  return [
    {
      id: "file.new",
      label: t("cmd.file.new"),
      shortcut: "⌘N",
      icon: cmdIcons.FileText,
      group: t("group.file"),
      action: handleNew,
    },
    {
      id: "file.open",
      label: t("cmd.file.open"),
      shortcut: "⌘O",
      icon: cmdIcons.FolderOpen,
      group: t("group.file"),
      action: handleOpen,
    },
    {
      id: "file.save",
      label: t("cmd.file.save"),
      shortcut: "⌘S",
      icon: cmdIcons.Save,
      group: t("group.file"),
      action: () => handleSave(false),
    },
    {
      id: "file.saveAs",
      label: t("cmd.file.saveAs"),
      shortcut: "⇧⌘S",
      icon: cmdIcons.Save,
      group: t("group.file"),
      action: () => handleSave(true),
    },
  ];
}

/** Tasks across the vault (plan 4.13): Today / Upcoming. Loaded on use. */
export function buildTaskCommands(): Command[] {
  return [
    {
      id: "tasks.open",
      label: t("cmd.tasks.open"),
      hint: t("cmd.tasks.open.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => void import("../../tasks/TasksPanel").then((m) => m.openTasksPanel()),
    },
  ];
}

/** Open the note's properties panel, and the trash. */
export function buildTrashCommands(): Command[] {
  return [
    {
      id: "view.properties",
      label: t("cmd.view.properties"),
      hint: t("cmd.view.properties.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => {
        window.dispatchEvent(new CustomEvent("lumen-open-properties"));
      },
    },
    {
      // Plan W1.30: the hosts allowed with "Always allow", and revoking them.
      id: "privacy.imageHosts",
      label: t("cmd.privacy.imageHosts"),
      hint: t("cmd.privacy.imageHosts.hint"),
      icon: cmdIcons.Eye,
      group: t("group.tools"),
      action: () => window.dispatchEvent(new CustomEvent("lumen-open-image-hosts")),
    },
    {
      id: "file.trash",
      label: t("cmd.file.trash"),
      hint: t("cmd.file.trash.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => {
        window.dispatchEvent(new CustomEvent("lumen-open-trash"));
      },
    },
  ];
}

/** Encrypted sync (plan 3.5): the panel and its providers load on demand. */
export function buildSyncCommands(): Command[] {
  return [
    {
      id: "sync.open",
      label: t("cmd.sync.open"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => void import("../../sync/e2ee/ui/launch").then((m) => m.openSync()),
    },
    {
      // Plan W4.19: the guided setup for people who don't know what WebDAV is.
      id: "sync.setup",
      label: t("cmd.sync.setup"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => void import("../../sync/e2ee/ui/launch").then((m) => m.openSyncSetup()),
    },
    {
      // Plan W5.21: a teacher shares a template, students hand in sealed work; loaded on use.
      id: "classroom.open",
      label: t("cmd.classroom.open"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => void import("../../sync/e2ee/classroom/launch").then((m) => m.openClassroom()),
    },
  ];
}

/** New note from a built-in or an installed template. */
export function buildTemplateCommands({ installedTemplates }: CommandContext): Command[] {
  return [
    ...TEMPLATES.map((tpl) => ({
      id: `template.${tpl.id}`,
      label: `${t("group.templates")}: ${tpl.name}`,
      hint: tpl.category,
      icon: cmdIcons.FileText,
      group: t("group.templates"),
      action: () => openTemplateDoc(tpl.name, tpl.content),
    })),
    // Marketplace templates installed into the workspace (templates/<id>.md).
    ...buildInstalledTemplateCommands(installedTemplates, {
      groupLabel: t("group.templates"),
      hint: t("templates.installed.button"),
      apply: (name, content) => {
        // {{title}}, {{date}}, {{time}}, {{hebrewDate}}: as Obsidian's Templates plugin fills them.
        void import("../../editor/templateVars").then(({ expandTemplate }) =>
          openTemplateDoc(name, expandTemplate(content, { title: name, locale: getLocale() })),
        );
      },
      onError: (e) => showAiToast(t("templates.loadFailed", { error: e.message }), "error"),
    }),
    {
      id: "template.importFromFile",
      label: t("cmd.template.importFromFile"),
      hint: t("cmd.template.importFromFile.hint"),
      icon: cmdIcons.FileText,
      group: t("group.templates"),
      action: async () => {
        if (!isOPFSAvailable()) {
          await uiAlert({ message: t("doc.alert.workspaceUnavailable") });
          return;
        }
        const [{ pickMarkdownFile }, { importTemplateFile }] = await Promise.all([
          import("../installedTemplates"),
          import("../../storage/templateMarketplace"),
          import("../../storage/templateStrings"),
        ]);
        const file = await pickMarkdownFile();
        if (!file) return;
        if (!/\.(md|markdown)$/i.test(file.name)) {
          showAiToast(t("templates.importNotMarkdown"), "error");
          return;
        }
        try {
          const tpl = await importTemplateFile(file.name, await file.text());
          showAiToast(t("templates.imported", { name: tpl.name }), "success");
        } catch (e) {
          showAiToast(t("templates.importFailed", { error: explainError(e) }), "error");
        }
      },
    },
  ];
}

/** Open the sample workspace; save to the workspace. */
export function buildWorkspaceFileCommands({ handleSaveToWorkspace, toggleWorkspace }: CommandContext): Command[] {
  return [
    {
      id: "file.openSampleWorkspace",
      label: t("cmd.file.openSampleWorkspace"),
      hint: t("cmd.file.openSampleWorkspace.hint"),
      icon: cmdIcons.FolderOpen,
      group: t("group.file"),
      action: async () => {
        if (!isOPFSAvailable()) {
          await uiAlert({ message: t("doc.alert.workspaceUnavailable") });
          return;
        }
        try {
          const { createSampleWorkspace } = await import("../../storage/sampleWorkspace");
          const result = await createSampleWorkspace();
          window.dispatchEvent(new Event("lumen-workspace-changed"));
          if (!useAppStore.getState().showWorkspace) toggleWorkspace();
          const content = await readWorkspaceFile(result.entry);
          useAppStore.getState().openTab({
            name: result.entry,
            content,
            workspaceName: result.entry,
          });
          showAiToast(
            result.created.length > 0
              ? t("sample.toast.created", { count: result.created.length, folder: result.root })
              : t("sample.toast.exists", { folder: result.root }),
            "info",
          );
        } catch (e) {
          await uiAlert({
            message: t("sample.alert.failed", { error: explainError(e) }),
          });
        }
      },
    },
    {
      id: "help.setup",
      label: t("cmd.help.setup"),
      hint: t("cmd.help.setup.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.file"),
      action: () => window.dispatchEvent(new CustomEvent("lumen-open-setup")),
    },
    // Sample vaults for Israeli use cases (W3.6), in the UI's language.
    ...(["student", "researcher", "writer"] as const).map((vault) => ({
      id: `file.sampleVault.${vault}`,
      label: t(`cmd.file.sampleVault.${vault}`),
      hint: t("cmd.file.sampleVault.hint"),
      icon: cmdIcons.FolderOpen,
      group: t("group.file"),
      action: async () => {
        if (!isOPFSAvailable()) {
          await uiAlert({ message: t("doc.alert.workspaceUnavailable") });
          return;
        }
        try {
          const { createSampleVault } = await import("../../storage/sampleVaults");
          const result = await createSampleVault(vault, getLocale());
          window.dispatchEvent(new Event("lumen-workspace-changed"));
          if (!useAppStore.getState().showWorkspace) toggleWorkspace();
          const content = await readWorkspaceFile(result.entry);
          useAppStore.getState().openTab({ name: result.entry, content, workspaceName: result.entry });
          showAiToast(
            result.created.length > 0
              ? t("sample.toast.created", { count: result.created.length, folder: result.root })
              : t("sample.toast.exists", { folder: result.root }),
            "info",
          );
        } catch (e) {
          await uiAlert({ message: t("sample.alert.failed", { error: explainError(e) }) });
        }
      },
    })),
    {
      id: "file.saveToWorkspace",
      label: t("cmd.file.saveToWorkspace"),
      hint: t("cmd.file.saveToWorkspace.hint"),
      icon: cmdIcons.Save,
      group: t("group.file"),
      action: handleSaveToWorkspace,
    },
  ];
}
