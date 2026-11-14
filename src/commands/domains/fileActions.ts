/**
 * Bodies of palette commands that load on use (perf, plan W4.9): the palette
 * lists the commands from the domain file; a body arrives when its command
 * runs, so none of this code is in the startup bundle.
 */
import { isOPFSAvailable, readWorkspaceFile } from "../../storage/workspace";
import { uiAlert } from "../../ui/PromptDialog";
import { t } from "../../i18n";
import { showAiToast } from "../../ui/AiToast";
import { explainError } from "../../lib/userError";
import { useAppStore } from "../../store/useStore";
import type { CommandContext } from "./context";

/** `template.importFromFile` (moved from file.ts, which loads this module when the command runs). */
export const templateImportFromFile = async () => {
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
};

/** `file.openSampleWorkspace` (moved from file.ts, which loads this module when the command runs). */
export const fileOpenSampleWorkspace = async ({ toggleWorkspace }: Pick<CommandContext, "toggleWorkspace">) => {
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
};
