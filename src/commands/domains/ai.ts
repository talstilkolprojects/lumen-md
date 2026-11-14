/** AI settings and controls: Privacy Mode, providers and models, policy, cache, cancel. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { useAppStore } from "../../store/useStore";
import { t } from "../../i18n";
import { uiAlert, uiConfirm, uiPrompt, uiSelect } from "../../ui/PromptDialog";
import { buildAiSettingsCommand, buildAiOutlineCommand } from "../../ai/commands";
import { showAiToast } from "../../ui/AiToast";
import { getSecret, setSecret } from "../../lib/secretStore";
import { cancelAllAi, isAbort } from "../../ai/aiAbort";
import { cancellable, type CommandContext } from "./context";

/** Privacy Mode: run every AI prompt in the browser (WebGPU). */
export function buildPrivacyModeCommands({ useLocalAi, toggleLocalAi }: CommandContext): Command[] {
  return [
    {
      id: "ai.localToggle",
      label: useLocalAi
        ? (t("cmd.ai.privacy.off") ?? "Privacy Mode: turn off (use cloud AI)")
        : (t("cmd.ai.privacy.on") ?? "Privacy Mode: run AI on this device (WebGPU)"),
      hint:
        t("cmd.ai.privacy.hint") ??
        "When ON, every AI prompt runs locally via @mlc-ai/web-llm. No data leaves your browser.",
      icon: cmdIcons.Sparkles,
      group: t("group.ai"),
      action: async () => {
        // why: the value when the command runs, not when the list was built
        if (!useAppStore.getState().useLocalAi) {
          // Going Local — verify WebGPU support before flipping.
          const { localLlmAvailable } = await import("../../ai/localLlm");
          const status = localLlmAvailable();
          if (!status.available) {
            showAiToast(t("toast.privacyModeUnavailableFallsBack", { reason: status.reason ?? "" }),
              "error",
            );
            return;
          }
          showAiToast(t("toast.privacyModeOnTheFirst"),
            "info",
          );
        } else {
          showAiToast(t("toast.privacyModeOffSwitchedBack"), "info");
        }
        toggleLocalAi();
      },
    },
  ];
}

/** Ollama models and AI usage. */
export function buildAiProviderCommands(): Command[] {
  return [
    {
      id: "ai.ollamaModels",
      label: t("cmd.ai.ollama", { defaultValue: "AI: Ollama Models" }),
      hint: t("cmd.ai.ollama.hint", { defaultValue: "Switch to a local Ollama model" }),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const { listOllamaModels, isOllamaAvailable, setOllamaConfig } = await import("../../ai/ollamaProvider");
        const { setActiveProvider } = await import("../../ai/llm");
        if (!(await isOllamaAvailable())) {
          await uiAlert({ message: "Ollama is not running.\n\nStart it with: ollama serve\nThen try again." });
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
          message: `Available Ollama models:\n\n${modelList}\n\nType the model name to use:`,
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
      },
    },
    {
      id: "ai.usage",
      label: t("cmd.ai.usage"),
      hint: t("cmd.ai.usage.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const { usageSummary, formatUsageReport } = await import("../../ai/usage");
        await uiAlert({ title: t("ai.usage.title"), message: formatUsageReport(usageSummary()) });
      },
    },
  ];
}

/** AI mode, in-browser models, writing-style profile, agent settings. */
export function buildAiModelCommands(): Command[] {
  return [
    {
      id: "ai.mode",
      label: t("cmd.ai.mode"),
      hint: t("cmd.ai.mode.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
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
      },
    },
    {
      id: "ai.localModels",
      label: t("cmd.ai.localModels"),
      hint: t("cmd.ai.localModels.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const { detectHardware, WEBLLM_CATALOG, webLlmModelId, vramBudgetMB, recommendWebLlmModel, selectedWebLlmModel, setWebLlmModel } = await import("../../ai/modelManager");
        const { webLlmModelCached, loadWebLlmModel, onWebLlmProgress } = await import("../../ai/webllmEngine");
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
          showAiToast(t("ai.localModels.failed", { error: err instanceof Error ? err.message : String(err) }), "error");
        } finally {
          off();
        }
      },
    },
    {
      id: "ai.styleProfile",
      label: t("cmd.ai.styleProfile"),
      hint: t("cmd.ai.styleProfile.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.ai"),
      action: async () => {
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
            sp.clearStyleProfile();
            showAiToast(t("ai.style.cleared"), "success");
          }
        } catch (e) {
          if (isAbort(e)) return;
          if ((await import("../../agents/suggestions")).reportAgentFailure(e, "ai.styleProfile")) return;
          showAiToast((e as Error).message, "error");
        }
      },
    },
    {
      id: "ai.agentSettings",
      label: t("cmd.ai.agentSettings"),
      hint: t("cmd.ai.agentSettings.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => {
        window.dispatchEvent(new CustomEvent("lumen-open-ai-settings"));
      },
    },
  ];
}

/** Cancel every running AI call. */
export function buildAiCancelCommands(): Command[] {
  return [
    {
      id: "ai.cancel",
      label: t("cmd.ai.cancel"),
      hint: t("cmd.ai.cancel.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.ai", { defaultValue: "AI Copilot" }),
      action: () => {
        const n = cancelAllAi();
        showAiToast(n ? t("toast.aiCancelled", { count: n }) : t("toast.aiNothingRunning"), "info");
      },
    },
  ];
}

/** Reranker, privacy ledger, AI doctor, policy, trace, response cache, provider. */
export function buildAiControlCommands(): Command[] {
  return [
    {
      id: "ai.rerankModel",
      label: t("cmd.ai.rerankModel"),
      hint: t("cmd.ai.rerankModel.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.ai", { defaultValue: "AI Copilot" }),
      action: async () => {
        const { getRerankMode, setRerankMode } = await import("../../ai/reranker");
        const next = getRerankMode() === "model" ? "lexical" : "model";
        setRerankMode(next);
        showAiToast(t(next === "model" ? "toast.rerankModelOn" : "toast.rerankModelOff"), "info");
      },
    },
    {
      id: "ai.privacyLedger",
      label: t("cmd.ai.privacyLedger"),
      hint: t("cmd.ai.privacyLedger.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.ai", { defaultValue: "AI Copilot" }),
      action: () => {
        window.dispatchEvent(new CustomEvent("lumen-open-privacy-ledger"));
      },
    },
    {
      id: "ai.doctor",
      label: t("cmd.ai.doctor"),
      hint: t("cmd.ai.doctor.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => {
        window.dispatchEvent(new CustomEvent("lumen-open-ai-doctor"));
      },
    },
    {
      id: "ai.policy",
      label: t("cmd.ai.policy"),
      hint: t("cmd.ai.policy.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
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
      },
    },
    {
      id: "ai.trace",
      label: t("cmd.ai.trace"),
      hint: t("cmd.ai.trace.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const { loadTrace, listRuns, formatTraceReport } = await import("../../agents/trace");
        await loadTrace();
        const runs = listRuns();
        await uiAlert({ title: t("ai.trace.title"), message: runs.length ? formatTraceReport(runs) : t("ai.trace.empty") });
      },
    },
    {
      id: "ai.cache",
      label: t("cmd.ai.cache"),
      hint: t("cmd.ai.cache.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
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
      },
    },
    {
      id: "ai.switchProvider",
      label: t("cmd.ai.provider", { defaultValue: "AI: Switch Provider" }),
      hint: t("cmd.ai.provider.hint", { defaultValue: "Choose between OpenAI, Ollama, or local WebGPU" }),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const { setActiveProvider, getActiveProvider } = await import("../../ai/llm");
        const current = getActiveProvider();
        const choice = await uiSelect({
          title: t("cmd.ai.provider", { defaultValue: "AI: Switch Provider" }),
          message: "Choose your AI provider:",
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
          await uiAlert({ message: `Invalid provider. Choose: ${known.join(", ")}` });
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
              message: `Enter your ${label} API key:`,
              defaultValue: "",
            });
            if (key && key.trim()) setSecret(`lumen.ai.key.${valid}`, key.trim());
          }
        }
        showAiToast(t("toast.aiProviderSetTo", { valid }), "success");
      },
    },
  ];
}

/** AI settings and outline. */
export function buildAiCapabilityCommands(): Command[] {
  return [
    buildAiSettingsCommand(),
    buildAiOutlineCommand(
      () => useAppStore.getState().doc.content,
      (s: string) => useAppStore.getState().setContent(s),
    ),
  ];
}
