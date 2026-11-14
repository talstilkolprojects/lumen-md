/**
 * The niqqud palette commands' flow (plans 6.3, W2.5), loaded on use so
 * that none of it is in the startup bundle: the toasts, the consent-gated
 * model, the editor action, and the readings list after pointing.
 */
import type { EditorView } from "@codemirror/view";
import { t } from "../i18n";
import { aiOperation, isAbort } from "../ai/aiAbort";
import { showAiToast } from "../ui/AiToast";
import { uiConfirm } from "../ui/PromptDialog";
import type { NikudMode } from "./nikudCommand";
import { explainError } from "../lib/userError";

export async function runNikudFromPalette(view: EditorView, mode: NikudMode, locale: string): Promise<void> {
  const op = aiOperation(); // Esc / "Cancel AI" stop it (T55)
  try {
    const [{ runNikudCommand }, svc, alt] = await Promise.all([import("./nikudCommand"), import("../ai/nikudService"), import("./nikudAlternatives")]);
    if (mode !== "remove") showAiToast(t("toast.nikud.working"), "info");
    let engine = "";
    const changed = await runNikudCommand(view, mode, {
      point: async (text, partial) => {
        const r = await svc.pointHebrewDetailed(text, { consent: { confirm: uiConfirm, t, locale }, signal: op.signal }, { partial });
        engine = r.engine;
        return r;
      },
      unpoint: svc.unpointHebrew,
      // W2.5: each pointed word keeps its other readings (click an underlined word).
      onPointed: (v, from, words) => alt.rememberNikudAlternatives(v, from, words, t),
    });
    if (!changed) showAiToast(t("toast.nikud.nothing"), "info");
    else if (engine) showAiToast(t(engine === "menaked" ? "toast.nikud.doneHigh" : "toast.nikud.done"), "success");
  } catch (e) {
    if (isAbort(e)) return;
    const reason = (e as { name?: string; reason?: string }).name === "NikudUnavailableError" ? (e as { reason: string }).reason : null;
    showAiToast(reason ? t(`toast.nikud.${reason}`) : t("toast.nikud.failed", { error: explainError(e) }), reason ? "info" : "error");
  } finally {
    op.end();
  }
}
