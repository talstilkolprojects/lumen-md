/**
 * Academic LaTeX export with Hebrew (plan W5.22) in the palette: the open
 * note as a ZIP with main.tex (babel, Hebrew right to left, math, natbib
 * citations from Pandoc [@key]), the cited BibTeX entries and the images.
 */
import { t } from "../../i18n";
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { useToastStore } from "../../store/useToastStore";
import type { CommandContext } from "./context";

export function buildLatexCommands({ liveDoc }: CommandContext): Command[] {
  return [
    {
      id: "export.latexProject",
      label: t("cmd.export.latexProject"),
      hint: t("cmd.export.latexProject.hint"),
      icon: cmdIcons.Download,
      group: t("group.file"),
      action: async () => {
        const { exportLatexProject } = await import("../../latex/app");
        const doc = liveDoc();
        try {
          const r = await exportLatexProject(doc.name, doc.content, doc.workspaceName ?? undefined);
          useToastStore.getState().push({ kind: "success", title: t("latex.exported", { file: r.file }), ...(r.missingKeys.length ? { body: t("latex.missingKeys", { keys: r.missingKeys.join(", ") }) } : {}) });
        } catch (e) {
          useToastStore.getState().push({ kind: "error", title: t("latex.failed", { error: (e as Error).message }) });
        }
      },
    },
  ];
}
