/** File commands: new / open / save, recent files, trash, templates and the sample workspace. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { useAppStore } from "../../store/useStore";
import { t } from "../../i18n";
import { getRecents, removeRecent } from "../../storage/recent";
import { uiAlert } from "../../ui/PromptDialog";
import { TEMPLATES } from "../../editor/templates";
import { buildInstalledTemplateCommands } from "../installedTemplates";
import { showAiToast } from "../../ui/AiToast";
import { isOPFSAvailable, readWorkspaceFile } from "../../storage/workspace";
import { relativeTime } from "../../lib/relativeTime";
import { openTemplateDoc } from "../openDoc";
import type { CommandContext } from "./context";

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

/** Open the trash. */
export function buildTrashCommands(): Command[] {
  return [
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
      apply: (name, content) => openTemplateDoc(name, content),
      onError: (e) => showAiToast(t("templates.loadFailed", { error: e.message }), "error"),
    }),
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
            message: t("sample.alert.failed", { error: (e as Error).message }),
          });
        }
      },
    },
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
