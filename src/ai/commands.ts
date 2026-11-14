/**
 * AI-related command definitions extracted from App.tsx.
 * Reduces App.tsx size and centralizes AI command logic.
 */

import type { Command } from "../ui/CommandPalette";
import { cmdIcons } from "../ui/CommandPalette";
import { useAppStore } from "../store/useStore";
import { uiPrompt, uiAlert } from "../ui/PromptDialog";
import { t } from "../i18n";
import { log } from "../lib/logger";
import { showAiToast } from "../ui/AiToast";
import { generateOutline, applyOutline } from "./outline";
import { aiOperation, isAbort } from "./aiAbort";

/**
 * Build the AI Settings command for the palette.
 */
export function buildAiSettingsCommand(): Command {
  return {
    id: "ai.settings",
    label: t("cmd.ai.settings", { defaultValue: "AI: Configure Connection" }),
    hint: t("cmd.ai.settings.hint", { defaultValue: "Set OpenAI/WebLLM Key" }),
    icon: cmdIcons.Sparkles,
    group: t("group.ai", { defaultValue: "AI Copilot" }),
    action: async () => {
      const currentKey = useAppStore.getState().aiKey;
      const key = await uiPrompt({
        message: t("ai.prompt.key", {
          defaultValue:
            "Enter OpenAI / Anthropic API Key (or leave blank for local WebLLM)",
        }),
        defaultValue: currentKey || "",
      });
      if (key !== null) {
        useAppStore.getState().setAiKey(key.trim() || null);
        await uiAlert({
          message: t("ai.alert.keySaved", {
            defaultValue: "AI Key settings updated!",
          }),
        });
      }
    },
  };
}

/**
 * Generate an AI-powered commit message based on git status.
 * Returns empty string if AI is not available.
 */
export async function generateAiCommitMessage(
  repoFolder: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    // Loaded on use: keeps the git modules out of the startup bundle.
    const { gitStatusSummary } = await import("../sync/git");
    const summary = await gitStatusSummary(repoFolder);
    const changes = summary.entries
      .filter((e) => e.state !== "unmodified")
      .map((e) => `${e.state.toUpperCase()}: ${e.path}`)
      .join("\n");

    if (!changes) return "";

    // The `committer` agent on a light local model. Pays for itself when
    // sent (ownPrompt), never billed to a palette command that may be
    // waiting in a dialog at the same time.
    const { runAgentOrThrow } = await import("../agents/runtime");
    const { committerAgent } = await import("../agents/defs");
    return await runAgentOrThrow(committerAgent, { text: changes }, { ownPrompt: true, signal });
  } catch (e) {
    if (signal?.aborted || isAbort(e)) return ""; // cancelled: no suggestion, no toast
    log.warn("AI commit generation skipped", e);
    showAiToast(t("toast.aiCommitSuggestionUnavailable"), "info");
    return "";
  }
}

/**
 * Build the AI Generate Outline command for the palette.
 */
export function buildAiOutlineCommand(getContent: () => string, setContent: (s: string) => void): Command {
  return {
    id: "ai.outline",
    label: t("cmd.ai.outline", { defaultValue: "AI: Generate Outline" }),
    hint: t("cmd.ai.outline.hint", { defaultValue: "Add AI-suggested headings" }),
    icon: cmdIcons.Sparkles,
    group: t("group.ai", { defaultValue: "AI Copilot" }),
    action: async () => {
      try {
        const content = getContent();
        if (content.trim().length < 100) {
          showAiToast(t("toast.documentTooShortForOutline"), "info");
          return;
        }
        showAiToast(t("toast.generatingOutline"), "info");
        const op = aiOperation(); // T55: Esc / "AI: Cancel" stop it
        let headings;
        try {
          headings = await generateOutline(content, op.signal);
        } finally {
          op.end();
        }
        if (headings.length === 0) {
          showAiToast(t("toast.noOutlineGenerated"), "info");
          return;
        }
        const newContent = applyOutline(content, headings);
        setContent(newContent);
        showAiToast(t("toast.insertedHeadings", { count: headings.length }), "success");
      } catch (e) {
        if (isAbort(e)) return;
        log.warn("AI outline generation failed", e);
        showAiToast(t("toast.outlineGenerationFailed"), "error");
      }
    },
  };
}
