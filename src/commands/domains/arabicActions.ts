/** The bodies of the Arabic commands (plan W5.17), loaded on first use (./tools.ts). */
import type { EditorView } from "@codemirror/view";
import { t } from "../../i18n";
import { uiConfirm } from "../../ui/PromptDialog";
import { showAiToast } from "../../ui/AiToast";

/** Download the Arabic word list, or remove it when it is installed. */
export async function toggleArabicDictionary(): Promise<void> {
  const svc = await import("../../ai/arabicSpellService");
  if (await svc.arabicDictionaryInstalled()) {
    if (!(await uiConfirm({ message: t("spell.ar.removeConfirm") }))) return;
    await svc.removeArabicDictionary();
    showAiToast(t("spell.ar.removed"), "info");
    return;
  }
  if (!(await uiConfirm({ message: t("spell.ar.downloadConfirm") }))) return;
  try {
    const n = await svc.downloadArabicDictionary();
    showAiToast(t("spell.ar.installed", { n: n.toLocaleString() }), "info");
  } catch (e) {
    showAiToast(t("spell.ar.failed", { error: (e as Error).message }), "error");
  }
}

export async function toggleTashkeelView(view: EditorView | null): Promise<void> {
  if (!view) return;
  const { toggleTashkeel } = await import("../../editor/tashkeelView");
  showAiToast(t(toggleTashkeel(view) ? "tashkeel.hidden" : "tashkeel.shown"), "info");
}

export async function removeTashkeel(view: EditorView | null): Promise<void> {
  if (!view) return;
  const { removeTashkeelIn } = await import("../../editor/tashkeelView");
  if (!removeTashkeelIn(view)) showAiToast(t("tashkeel.nothing"), "info");
}
