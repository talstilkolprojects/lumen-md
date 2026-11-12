/** The bodies of the tag, link and product agents (./agents.ts), loaded on first use. */
import { t } from "../../i18n";
import { uiAlert, uiPrompt } from "../../ui/PromptDialog";
import { showAiToast } from "../../ui/AiToast";
import { isAbort } from "../../ai/aiAbort";
import { cancellable, type CommandContext } from "./context";
import { explainError } from "../../lib/userError";

type Ctx = Pick<CommandContext, "setContent" | "liveDoc">;

/** Suggest tags for the open note and merge the accepted ones into its front matter. */
export async function autoTag({ setContent, liveDoc }: Ctx): Promise<void> {
  try {
    showAiToast(t("toast.suggestingTags"), "info");
    const { suggestTags, mergeTagsIntoFrontmatter } = await import("../../agents/commands");
    const tags = await cancellable((signal) => suggestTags(liveDoc().content, signal));
    if (tags.length === 0) {
      showAiToast(t("toast.noTagSuggestionsReturned"), "info");
      return;
    }
    const accept = await uiPrompt({
      message: t("agent.tags.prompt", { tags: tags.join(", ") }),
      defaultValue: tags.join(", "),
    });
    if (accept === null) return;
    const final = accept
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 1);
    if (final.length === 0) return;
    setContent(mergeTagsIntoFrontmatter(liveDoc().content, final));
    showAiToast(t("toast.addedTag", { count: final.length }), "success");
  } catch (e) {
    if (isAbort(e)) return;
    if ((await import("../../agents/suggestions")).reportAgentFailure(e, "tools.autoTag")) return;
    showAiToast(t("toast.autoTagFailed", { error: explainError(e) }), "error");
  }
}

/** Suggest [[links]] to other notes of the workspace and apply the accepted ones. */
export async function suggestLinksFlow({ setContent, liveDoc }: Ctx): Promise<void> {
  if (!liveDoc().workspaceName) {
    await uiAlert({ message: t("agent.links.needWorkspace") });
    return;
  }
  try {
    showAiToast(t("toast.scanningWorkspaceForLinkSuggestions"), "info");
    const { suggestLinks, applyLinkSuggestion } = await import("../../agents/commands");
    const suggestions = await cancellable((signal) => suggestLinks(liveDoc().workspaceName!, liveDoc().content, signal));
    if (suggestions.length === 0) {
      showAiToast(t("toast.noLinkSuggestions"), "info");
      return;
    }
    const summary = suggestions
      .map((s, i) => `${i + 1}. "${s.phrase}" → [[${s.target}]] · ${s.reason}`)
      .join("\n");
    const accept = await uiPrompt({
      message: t("agent.links.prompt", { n: suggestions.length, summary, no: t("agent.links.no") }),
      defaultValue: t("agent.links.yes"),
    });
    // "no" in the UI language or in English skips.
    const answer = accept?.trim().toLowerCase() ?? "";
    if (!answer || answer.startsWith("n") || answer.startsWith(t("agent.links.no").toLowerCase())) return;
    let next = liveDoc().content;
    let applied = 0;
    for (const s of suggestions) {
      const updated = applyLinkSuggestion(next, s);
      if (updated !== next) {
        applied++;
        next = updated;
      }
    }
    setContent(next);
    showAiToast(t("toast.appliedLink", { count: applied }), "success");
  } catch (e) {
    if (isAbort(e)) return;
    if ((await import("../../agents/suggestions")).reportAgentFailure(e, "tools.suggestLinks")) return;
    showAiToast(t("toast.linkSuggestFailed", { error: explainError(e) }), "error");
  }
}

/** Make a whole project from a description (the product agent). */
export async function productAgentFlow({ setContent }: Pick<Ctx, "setContent">): Promise<void> {
  const idea = await uiPrompt({
    message: t("agent.product.prompt"),
  });
  if (!idea) return;
  try {
    showAiToast(t("toast.productAgentStarting"), "info");
    const { createProduct } = await import("../../ai/productAgent");
    const result = await cancellable((signal) =>
      createProduct(
        idea,
        (progress) => {
          showAiToast(`${progress.phase}: ${progress.message}`, "info");
        },
        signal,
      ),
    );
    if (result.success) {
      showAiToast(t("toast.productCreatedFilesGenerated", { count: result.files.size }), "success");
      const summary = `# Product Created\n\n${result.files.size} files generated:\n\n${[...result.files.keys()].map((f) => `- \`${f}\``).join("\n")}`;
      setContent(summary);
    } else {
      showAiToast(t("toast.productCreationFailed", { error: result.error ?? "" }), "error");
    }
  } catch (e) {
    if (isAbort(e)) return;
    if ((await import("../../agents/suggestions")).reportAgentFailure(e, "ai.productAgent")) return;
    showAiToast(t("toast.agentError", { error: explainError(e) }), "error");
  }
}
