/**
 * Bodies of palette commands that load on use (perf, plan W4.9): the palette
 * lists the commands from the domain file; a body arrives when its command
 * runs, so none of this code is in the startup bundle.
 */
import { showAiToast } from "../../ui/AiToast";
import { t } from "../../i18n";
import { explainError } from "../../lib/userError";
import { useAppStore } from "../../store/useStore";

/** `research.litReview` (moved from view.ts, which loads this module when the command runs). */
export const researchLitReview = async () => {
  const { buildLiteratureReview, REVIEW_FOLDER } = await import("../../research/litReview");
  showAiToast(t("litReview.started"), "info");
  try {
    const { papers } = await buildLiteratureReview({ onProgress: (p) => p.current && showAiToast(t("litReview.progress", { done: p.done + 1, total: p.total, title: p.current }), "info") });
    const values = papers.reduce((n, p) => n + p.fields.filter((f) => f.value).length, 0);
    showAiToast(t("litReview.done", { papers: papers.length, values, folder: REVIEW_FOLDER }), "success");
  } catch (e) {
    showAiToast(t("litReview.failed", { error: explainError(e) }), "error");
  }
};

/** `note.morning` (moved from view.ts, which loads this module when the command runs). */
export const noteMorning = async () => {
  const store = useAppStore.getState();
  const settings = { ...store.dailyNotes, morning: true };
  if (!store.dailyNotes.morning) store.setDailyNotes({ morning: true });
  const [{ dayOf, dailyPath, ensureDailyNote }, m] = await Promise.all([import("../../daily/dailyNote"), import("../../daily/morning")]);
  const day = dayOf(new Date());
  const path = dailyPath(day, settings);
  try {
    const t0 = performance.now();
    if (store.doc.workspaceName === path) store.setContent(await m.applyToText(store.doc.content, day, settings, store.locale));
    else {
      await ensureDailyNote(day, settings, store.locale);
      await m.refreshMorningFile(day, settings, store.locale);
      window.dispatchEvent(new CustomEvent("lumen-open-today"));
    }
    showAiToast(t("morning.done", { ms: Math.round(performance.now() - t0) }), "success");
  } catch (e) {
    showAiToast(t("morning.failed", { error: explainError(e) }), "error");
  }
};
