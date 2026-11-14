/**
 * Bodies of palette commands that load on use (perf, plan W4.9): the palette
 * lists the commands from the domain file; a body arrives when its command
 * runs, so none of this code is in the startup bundle.
 */
import { uiAlert, uiSelect, uiConfirm, uiPrompt } from "../../ui/PromptDialog";
import { t } from "../../i18n";
import { showAiToast } from "../../ui/AiToast";
import { useAppStore } from "../../store/useStore";
import { getSecret, setSecret } from "../../lib/secretStore";
import "./commandBodiesStrings";

/** `ai.usage` (moved from ai.ts, which loads this module when the command runs). */
export const aiUsage = async () => {
  const { usageSummary, formatUsageReport } = await import("../../ai/usage");
  await uiAlert({ title: t("ai.usage.title"), message: formatUsageReport(usageSummary()) });
};

/** `ai.mode` (moved from ai.ts, which loads this module when the command runs). */
export const aiMode = async () => {
  const { getAiMode, setAiMode } = await import("../../ai/contextPacker");
  const choice = await uiSelect({
    title: t("ai.mode.title"),
    message: t("cmd.ai.mode.hint"),
    defaultValue: getAiMode(),
    choices: [
      { value: "economy", label: t("ai.mode.economy") },
      { value: "balanced", label: t("ai.mode.balanced") },
      { value: "quality", label: t("ai.mode.quality") },
    ],
  });
  if (choice !== "economy" && choice !== "balanced" && choice !== "quality") return;
  setAiMode(choice);
  showAiToast(t(`ai.mode.${choice}`), "success");
};

/** `ai.rerankModel` (moved from ai.ts, which loads this module when the command runs). */
export const aiRerankModel = async () => {
  const { getRerankMode, setRerankMode, modelRerankSupported, RERANK_MODEL_MB } = await import("../../ai/reranker");
  const next = getRerankMode() === "model" ? "lexical" : "model";
  // Plan 7.6: only on WebGPU / the desktop app, and only after the user agrees to the download.
  if (next === "model") {
    if (!modelRerankSupported()) {
      showAiToast(t("toast.rerankUnsupported"), "info");
      return;
    }
    if (!(await uiConfirm({ message: t("rerank.consent", { mb: RERANK_MODEL_MB }) }))) return;
  }
  setRerankMode(next);
  showAiToast(t(next === "model" ? "toast.rerankModelOn" : "toast.rerankModelOff"), "info");
};

/** `ai.organize` (moved from ai.ts, which loads this module when the command runs). */
export const aiOrganize = async () => {
  // Plan W2.1: suggestions only; every change goes through the review screen.
  const { openOrganizerPanel } = await import("../../ui/OrganizerPanel");
  await openOrganizerPanel();
};

/** `related.folderOff` (moved from ai.ts, which loads this module when the command runs). */
export const relatedFolderOff = async () => {
  const path = useAppStore.getState().doc.workspaceName;
  const { offFolders, setFolderOff } = await import("../../related/prefs");
  const folder = path && path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : (path ?? "");
  const off = !offFolders().includes(folder);
  setFolderOff(folder, off);
  showAiToast(t(off ? "toast.related.folderOff" : "toast.related.folderOn", { folder: folder || "/" }), "info");
};

/** `ai.policy` (moved from ai.ts, which loads this module when the command runs). */
export const aiPolicy = async () => {
  const { getAiPolicy, setAiPolicy } = await import("../../ai/policy");
  const choice = await uiSelect({
    title: t("ai.policy.title"),
    message: t("cmd.ai.policy.hint"),
    defaultValue: getAiPolicy(),
    choices: [
      { value: "local-only", label: t("ai.policy.localOnly") },
      { value: "local-first", label: t("ai.policy.localFirst") },
      { value: "cloud", label: t("ai.policy.cloud") },
    ],
  });
  if (choice !== "local-only" && choice !== "local-first" && choice !== "cloud") return;
  setAiPolicy(choice);
  showAiToast(
    choice === "local-only" ? t("ai.policy.localOnly") : choice === "local-first" ? t("ai.policy.localFirst") : t("ai.policy.cloud"),
    "success",
  );
};

/** `ai.trace` (moved from ai.ts, which loads this module when the command runs). */
export const aiTrace = async () => {
  const { loadTrace, listRuns, formatTraceReport } = await import("../../agents/trace");
  await loadTrace();
  const runs = listRuns();
  await uiAlert({ title: t("ai.trace.title"), message: runs.length ? formatTraceReport(runs) : t("ai.trace.empty") });
};

/** `ai.cache` (moved from ai.ts, which loads this module when the command runs). */
export const aiCache = async () => {
  const { aiCacheEnabled, setAiCacheEnabled, clearAiCache } = await import("../../ai/responseCache");
  const choice = await uiSelect({
    title: t("ai.cache.title"),
    message: t("cmd.ai.cache.hint"),
    defaultValue: aiCacheEnabled() ? "on" : "off",
    choices: [
      { value: "on", label: t("ai.cache.on") },
      { value: "off", label: t("ai.cache.off") },
      { value: "clear", label: t("ai.cache.clear") },
    ],
  });
  if (!choice) return;
  if (choice === "clear") {
    const count = await clearAiCache();
    showAiToast(t("ai.cache.cleared", { count }), "success");
    return;
  }
  setAiCacheEnabled(choice === "on");
  showAiToast(choice === "on" ? t("ai.cache.on") : t("ai.cache.off"), "success");
};

/** `ai.switchProvider` (moved from ai.ts, which loads this module when the command runs). */
export const aiSwitchProvider = async () => {
  const { setActiveProvider, getActiveProvider } = await import("../../ai/llm");
  const current = getActiveProvider();
  const choice = await uiSelect({
    title: t("cmd.ai.provider", { defaultValue: "AI: Switch Provider" }),
    message: t("ai.provider.choose"),
    defaultValue: current,
    choices: [
      { value: "openai", label: "OpenAI \u2014 cloud (API key)" },
      { value: "anthropic", label: "Claude / Anthropic \u2014 cloud (API key)" },
      { value: "gemini", label: "Google Gemini \u2014 cloud (API key)" },
      { value: "mistral", label: "Mistral \u2014 cloud (API key)" },
      { value: "ollama", label: "Ollama \u2014 local server" },
      { value: "local-webgpu", label: "Local WebGPU \u2014 in-browser" },
    ],
  });
  if (!choice) return;
  const valid = choice.trim().toLowerCase();
  const known = ["openai", "anthropic", "gemini", "mistral", "ollama", "local-webgpu"];
  if (!known.includes(valid)) {
    await uiAlert({ message: t("ai.provider.invalid", { list: known.join(", ") }) });
    return;
  }
  setActiveProvider(
    valid as "openai" | "anthropic" | "gemini" | "mistral" | "ollama" | "local-webgpu",
  );
  // Cloud providers other than OpenAI keep their key under
  // lumen.ai.key.<provider>; prompt for it if missing.
  if (valid === "anthropic" || valid === "gemini" || valid === "mistral") {
    const existing = getSecret(`lumen.ai.key.${valid}`);
    if (!existing) {
      const label =
        valid === "anthropic"
          ? "Anthropic (Claude)"
          : valid === "gemini"
            ? "Google Gemini"
            : "Mistral";
      const key = await uiPrompt({
        message: t("ai.provider.enterKey", { provider: label }),
        defaultValue: "",
      });
      if (key && key.trim()) setSecret(`lumen.ai.key.${valid}`, key.trim());
    }
  }
  showAiToast(t("toast.aiProviderSetTo", { valid }), "success");
};
