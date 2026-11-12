/** The body of the LaTeX export command (plan W5.22), loaded on first use (./latex.ts). */
import { t } from "../../i18n";
import { useToastStore } from "../../store/useToastStore";

export async function exportLatexFor(doc: { name: string; content: string; workspaceName?: string | null }): Promise<void> {
  try {
    const { exportLatexProject } = await import("../../latex/app");
    const r = await exportLatexProject(doc.name, doc.content, doc.workspaceName ?? undefined);
    useToastStore.getState().push({ kind: "success", title: t("latex.exported", { file: r.file }), ...(r.missingKeys.length ? { body: t("latex.missingKeys", { keys: r.missingKeys.join(", ") }) } : {}) });
  } catch (e) {
    useToastStore.getState().push({ kind: "error", title: t("latex.failed", { error: (e as Error).message }) });
  }
}
