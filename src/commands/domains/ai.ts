/** AI settings and controls: Privacy Mode, providers and models, policy, cache, cancel. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { useAppStore } from "../../store/useStore";
import { t } from "../../i18n";
import { buildAiSettingsCommand, buildAiOutlineCommand } from "../../ai/commands";
import { showAiToast } from "../../ui/AiToast";
import { cancelAllAi } from "../../ai/aiAbort";
import type { CommandContext } from "./context";

/** Privacy Mode: run every AI prompt in the browser (WebGPU). */
export function buildPrivacyModeCommands({ useLocalAi, toggleLocalAi }: CommandContext): Command[] {
  return [
    {
      id: "ai.localToggle",
      label: useLocalAi
        ? (t("cmd.ai.privacy.off"))
        : (t("cmd.ai.privacy.on")),
      hint:
        t("cmd.ai.privacy.hint"),
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
      action: () => import("./aiActions").then((m) => m.aiOllamaModels()),
    },
    {
      id: "ai.usage",
      label: t("cmd.ai.usage"),
      hint: t("cmd.ai.usage.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => import("./aiActions").then((m) => m.aiUsage()),
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
      action: () => import("./aiActions").then((m) => m.aiMode()),
    },
    {
      id: "ai.localModels",
      label: t("cmd.ai.localModels"),
      hint: t("cmd.ai.localModels.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      // The picker, the licence check and the download live in a lazy module.
      action: async () => (await import("../../ai/localModelsCommand")).runLocalModelsCommand(),
    },
    {
      id: "ai.styleProfile",
      destructive: "confirm",
      label: t("cmd.ai.styleProfile"),
      hint: t("cmd.ai.styleProfile.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.ai"),
      action: () => import("./aiActions").then((m) => m.aiStyleProfile()),
    },
    {
      id: "settings.open",
      label: t("settings.title"),
      hint: t("settings.search"),
      icon: cmdIcons.Sparkles,
      group: t("group.view"),
      action: () => {
        window.dispatchEvent(new CustomEvent("lumen-open-settings"));
      },
    },
    {
      id: "ai.marks.toggle",
      label: t("cmd.ai.marks.toggle"),
      hint: t("cmd.ai.marks.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.view"),
      action: async () => {
        const { marksShown, setMarksShown } = await import("../../ai/authorship");
        setMarksShown(!marksShown());
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
export function buildAiControlCommands({ getEditorView }: CommandContext): Command[] {
  return [
    {
      id: "ai.rerankModel",
      label: t("cmd.ai.rerankModel"),
      hint: t("cmd.ai.rerankModel.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.ai", { defaultValue: "AI Copilot" }),
      action: () => import("./aiActions").then((m) => m.aiRerankModel()),
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
      id: "ai.organize",
      label: t("cmd.ai.organize"),
      hint: t("cmd.ai.organize.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.ai", { defaultValue: "AI Copilot" }),
      action: () => import("./aiActions").then((m) => m.aiOrganize()),
    },
    {
      id: "ai.reviewChanges",
      label: t("cmd.ai.reviewChanges"),
      hint: t("cmd.ai.reviewChanges.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.ai", { defaultValue: "AI Copilot" }),
      action: () => {
        window.dispatchEvent(new CustomEvent("lumen-open-agent-review"));
      },
    },
    {
      id: "related.toggle",
      label: t("cmd.related.toggle"),
      hint: t("cmd.related.toggle.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.ai", { defaultValue: "AI Copilot" }),
      action: async () => {
        // Plan W2.2: lazy panel + editor plugin; nothing runs per keystroke.
        const { toggleRelatedPanel } = await import("../../ui/RelatedPanel");
        await toggleRelatedPanel(() => getEditorView?.() ?? null);
      },
    },
    {
      id: "related.folderOff",
      label: t("cmd.related.folderOff"),
      icon: cmdIcons.Sparkles,
      group: t("group.ai", { defaultValue: "AI Copilot" }),
      action: () => import("./aiActions").then((m) => m.relatedFolderOff()),
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
      // 14.2: feedback without a server — the dialog (and its strings) load on use.
      id: "help.feedback",
      label: t("cmd.feedback"),
      hint: t("cmd.feedback.hint"),
      icon: cmdIcons.Link,
      group: t("group.tools"),
      action: () => {
        void import("../../ui/FeedbackDialog").then((m) => m.openFeedback());
      },
    },
    {
      // W3.7: the docs, packed into the app and searched on the device.
      id: "help.open",
      label: t("cmd.help.open"),
      hint: t("cmd.help.open.hint"),
      shortcut: "F1",
      icon: cmdIcons.FileText,
      group: t("group.tools"),
      action: () => void import("../../ui/HelpButton").then((m) => m.openHelp()),
    },
    {
      id: "help.diagnostics",
      label: t("cmd.help.diagnostics"),
      hint: t("cmd.help.diagnostics.hint"),
      icon: cmdIcons.FileText,
      group: t("group.tools"),
      action: () => void import("../../ui/diagnosticsActions").then((m) => m.saveDiagnostics()),
    },
    {
      // W4.26: local usage counters and the weekly report the user sends by hand.
      id: "help.usage",
      label: t("cmd.usage"),
      hint: t("cmd.usage.hint"),
      icon: cmdIcons.Link,
      group: t("group.tools"),
      action: () => {
        window.dispatchEvent(new CustomEvent("lumen-open-usage"));
      },
    },
    {
      // W6.31: join the beta on this device, send beta feedback and the opt-in weekly report.
      id: "help.beta",
      label: t("cmd.beta"),
      hint: t("cmd.beta.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => {
        window.dispatchEvent(new CustomEvent("lumen-open-beta"));
      },
    },
    {
      id: "ai.policy",
      label: t("cmd.ai.policy"),
      hint: t("cmd.ai.policy.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => import("./aiActions").then((m) => m.aiPolicy()),
    },
    {
      id: "ai.trace",
      label: t("cmd.ai.trace"),
      hint: t("cmd.ai.trace.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => import("./aiActions").then((m) => m.aiTrace()),
    },
    {
      id: "ai.cache",
      label: t("cmd.ai.cache"),
      hint: t("cmd.ai.cache.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => import("./aiActions").then((m) => m.aiCache()),
    },
    {
      id: "ai.switchProvider",
      label: t("cmd.ai.provider", { defaultValue: "AI: Switch Provider" }),
      hint: t("cmd.ai.provider.hint", { defaultValue: "Choose between OpenAI, Ollama, or local WebGPU" }),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => import("./aiActions").then((m) => m.aiSwitchProvider()),
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
