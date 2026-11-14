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
import { cancellable } from "./context";
import { isAbort } from "../../ai/aiAbort";
import { explainError } from "../../lib/userError";

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

/** `ai.ollamaModels` (moved from ai.ts, which loads this module when the command runs; W4.9). */
export const aiOllamaModels = async (): Promise<void> => {
const { listOllamaModels, isOllamaAvailable, setOllamaConfig } = await import("../../ai/ollamaProvider");
const { setActiveProvider } = await import("../../ai/llm");
if (!(await isOllamaAvailable())) {
  await uiAlert({ message: t("ai.ollama.notRunning") });
  return;
}
const models = await listOllamaModels();
if (models.length === 0) {
  // Names the open-licence default (DEFAULT_OLLAMA_MODEL), never a custom-licence model (plan 1.7).
  await uiAlert({ message: t("ai.settings.ollama.none") });
  return;
}
const { ollamaLicenceNotice } = await import("../../ai/modelCatalog");
// why: custom-licence and non-commercial models are named as such and confirmed (plan 1.7)
const modelList = models
  .map((m) => {
    const lic = ollamaLicenceNotice(m.name);
    return `${m.name} (${(m.size / 1e9).toFixed(1)}GB)${lic ? ` · ${lic.name}` : ""}`;
  })
  .join("\n");
const choice = await uiPrompt({
  message: t("ai.ollama.pickModel", { models: modelList }),
  defaultValue: models[0].name,
});
if (!choice) return;
const lic = ollamaLicenceNotice(choice.trim());
if (lic) {
  const ok = await uiConfirm({
    title: t("ai.localModels.licenceTitle"),
    message: t("ai.localModels.licenceBody", { model: choice.trim(), licence: lic.name }),
    okLabel: t("ai.localModels.licenceOk"),
  });
  if (!ok) return;
}
setOllamaConfig({ model: choice.trim() });
setActiveProvider("ollama");
showAiToast(t("toast.switchedToOllama", { model: choice.trim() }), "success");
};

/** `ai.styleProfile` (moved from ai.ts, which loads this module when the command runs; W4.9). */
export const aiStyleProfile = async (): Promise<void> => {
const sp = await import("../../ai/styleProfiles");
const current = sp.getStyleProfile();
const choice = await uiSelect({
  title: t("ai.style.title"),
  message: current ? t("ai.style.current", { notes: current.notes, tone: current.tone }) : t("ai.style.none"),
  defaultValue: current ? (sp.styleProfileActive() ? "off" : "on") : "build",
  choices: [
    { value: "build", label: t("ai.style.build") },
    ...(current
      ? [
          sp.styleProfileActive() ? { value: "off", label: t("ai.style.off") } : { value: "on", label: t("ai.style.on") },
          { value: "show", label: t("ai.style.show") },
          { value: "modelfile", label: t("ai.style.modelfile") },
          { value: "clear", label: t("ai.style.clear") },
        ]
      : []),
  ],
});
if (!choice) return;
try {
  if (choice === "build") {
    const folder = await uiPrompt({ message: t("ai.style.folder"), defaultValue: "" });
    if (folder === null) return;
    showAiToast(t("ai.style.building"), "info");
    const p = await cancellable((signal) => sp.buildStyleProfile(folder.trim(), signal));
    showAiToast(t("ai.style.built", { notes: p.notes, rules: p.rules.length }), "success");
  } else if (choice === "on" || choice === "off") {
    sp.setStyleProfileActive(choice === "on");
    showAiToast(choice === "on" ? t("ai.style.on") : t("ai.style.off"), "success");
  } else if (choice === "show" && current) {
    await uiAlert({ title: t("ai.style.title"), message: sp.styleInstruction(current) });
  } else if (choice === "modelfile" && current) {
    const { getOllamaConfigModel } = await import("../../ai/ollamaProvider");
    const { writeWorkspaceFile, workspaceHasFile } = await import("../../storage/workspace");
    // Never overwrite: an earlier (maybe edited) export or another file keeps its name.
    let path = "lumen-style.Modelfile";
    for (let n = 2; await workspaceHasFile(path); n++) path = `lumen-style-${n}.Modelfile`;
    await writeWorkspaceFile(path, sp.styleModelfile(getOllamaConfigModel()));
    showAiToast(t("ai.style.modelfileSaved", { path }), "success");
  } else if (choice === "clear") {
    // The profile took a read of the notes to build: ask before it goes (messages:check).
    if (!(await uiConfirm({ title: t("ai.style.title"), message: t("ai.style.clear"), okLabel: t("ai.style.clear") }))) return;
    sp.clearStyleProfile();
    showAiToast(t("ai.style.cleared"), "success");
  }
} catch (e) {
  if (isAbort(e)) return;
  if ((await import("../../agents/suggestions")).reportAgentFailure(e, "ai.styleProfile")) return;
  showAiToast(explainError(e), "error");
}
};
