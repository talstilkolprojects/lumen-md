/**
 * "AI: Local models (in-browser)" — choosing, licence-checking and
 * downloading a web-llm model. Loaded on use from the command palette, so
 * none of it is in the startup bundle.
 */
import { t } from "../i18n";
import { showAiToast } from "../ui/AiToast";
import { uiConfirm, uiSelect } from "../ui/PromptDialog";
import { explainError } from "../lib/userError";
import "./localModelsCommandStrings";

export async function runLocalModelsCommand(): Promise<void> {
  const { detectHardware, WEBLLM_CATALOG, webLlmModelId, vramBudgetMB, recommendWebLlmModel, selectedWebLlmModel, setWebLlmModel } = await import("./modelManager");
  const { webLlmModelCached, loadWebLlmModel, onWebLlmProgress } = await import("./webllmEngine");
  const hw = await detectHardware();
  if (!hw.webgpu) {
    showAiToast(t("ai.localModels.noWebgpu"), "error");
    return;
  }
  const budget = vramBudgetMB(hw);
  const recommended = recommendWebLlmModel("small", hw);
  const selected = selectedWebLlmModel();
  const cached = await Promise.all(WEBLLM_CATALOG.map((e) => webLlmModelCached(webLlmModelId(e, hw.f16))));
  const choices = WEBLLM_CATALOG.map((e, i) => {
    const id = webLlmModelId(e, hw.f16);
    const gb = Math.round(((hw.f16 ? e.vramMB.f16 : e.vramMB.f32) / 1024) * 10) / 10;
    const marks = [
      id === selected ? t("ai.localModels.selected") : "",
      id === recommended ? t("ai.localModels.recommended") : "",
      cached[i] ? t("ai.localModels.cached") : "",
      (hw.f16 ? e.vramMB.f16 : e.vramMB.f32) > budget ? t("ai.localModels.tooBig") : "",
    ].filter(Boolean);
    // why: custom-licence models (Llama, Gemma…) are opt-in and named as such (plan 1.7)
    const lic = e.licence ? ` · ${e.licence}` : "";
    return { value: id, label: `${e.label} · ${gb} GB · ${e.tier}${lic}${marks.length ? " — " + marks.join(", ") : ""}` };
  });
  choices.push({ value: "__auto__", label: t("ai.localModels.auto") });
  const choice = await uiSelect({
    title: t("ai.localModels.title"),
    message: t("ai.localModels.message", { budget: Math.round(budget / 1024), f16: hw.f16 ? "q4f16" : "q4f32" }),
    defaultValue: selected ?? recommended,
    choices,
  });
  if (!choice) return;
  if (choice === "__auto__") {
    setWebLlmModel(null);
    showAiToast(t("ai.localModels.autoSet", { model: recommended }), "success");
    return;
  }
  const picked = WEBLLM_CATALOG.find((e) => webLlmModelId(e, hw.f16) === choice);
  if (picked?.licence && choice !== selected) {
    const ok = await uiConfirm({
      title: t("ai.localModels.licenceTitle"),
      message: t("ai.localModels.licenceBody", { model: picked.label, licence: picked.licence }),
      okLabel: t("ai.localModels.licenceOk"),
    });
    if (!ok) return;
  }
  setWebLlmModel(choice);
  const idx = choices.findIndex((c) => c.value === choice);
  if (idx >= 0 && cached[idx]) {
    showAiToast(t("ai.localModels.set", { model: choice }), "success");
    return;
  }
  const download = await uiConfirm({ message: t("ai.localModels.downloadNow", { model: choice }) });
  if (!download) {
    showAiToast(t("ai.localModels.set", { model: choice }), "success");
    return;
  }
  let lastPct = -1;
  const off = onWebLlmProgress(({ progress, text }) => {
    const pct = Math.round(progress * 100);
    if (pct >= lastPct + 5 || pct === 100) {
      lastPct = pct;
      showAiToast(t("ai.toast.localLoading.body", { pct, status: text || t("ai.toast.localLoading.preparing") }), "info");
    }
  });
  try {
    await loadWebLlmModel(choice);
    showAiToast(t("ai.localModels.ready", { model: choice }), "success");
  } catch (err) {
    showAiToast(t("ai.localModels.failed", { error: explainError(err) }), "error");
  } finally {
    off();
  }
}
