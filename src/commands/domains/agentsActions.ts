/** The bodies of the tag, link, product, diagram, action-item and translation agents (./agents.ts), loaded on first use. */
import { t, getLocale } from "../../i18n";
import { uiAlert, uiConfirm, uiPrompt } from "../../ui/PromptDialog";
import { useAppStore } from "../../store/useStore";
import { showAiToast } from "../../ui/AiToast";
import { isAbort } from "../../ai/aiAbort";
import { cancellable, type CommandContext } from "./context";
import { explainError } from "../../lib/userError";
import "./commandBodiesStrings";

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

/** Append a Mermaid diagram made from the open note. */
export async function diagramFlow({ setContent, liveDoc }: Ctx): Promise<void> {
  try {
    showAiToast(t("toast.generatingDiagram"), "info");
    const { generateDiagram } = await import("../../agents/commands");
    const block = await cancellable((signal) => generateDiagram(liveDoc().content, signal));
    setContent(`${liveDoc().content.trimEnd()}\n\n${block}\n`);
    showAiToast(t("toast.diagramInserted"), "success");
  } catch (e) {
    if (isAbort(e)) return;
    if ((await import("../../agents/suggestions")).reportAgentFailure(e, "ai.diagram")) return;
    showAiToast(t("toast.diagramFailed", { error: explainError(e) }), "error");
  }
}

/** Append the open note's action items as a task list. */
export async function actionItemsFlow({ setContent, liveDoc }: Ctx): Promise<void> {
  try {
    showAiToast(t("toast.extractingActionItems"), "info");
    const { extractActionItems } = await import("../../agents/commands");
    const list = await cancellable((signal) => extractActionItems(liveDoc().content, signal));
    setContent(`${liveDoc().content.trimEnd()}\n\n## Action Items\n\n${list}\n`);
    showAiToast(t("toast.actionItemsAdded"), "success");
  } catch (e) {
    if (isAbort(e)) return;
    if ((await import("../../agents/suggestions")).reportAgentFailure(e, "ai.actionItems")) return;
    showAiToast(t("toast.actionItemsFailed", { error: explainError(e) }), "error");
  }
}

/** Translate the open note (the target language asked first), keeping its formatting. */
export async function translateFlow({ setContent, liveDoc }: Ctx): Promise<void> {
  const target = await uiPrompt({
    message: t("agent.translate.prompt"),
    defaultValue: "",
  });
  if (!target || !target.trim()) return;
  try {
    showAiToast(t("toast.translatingTo", { target }), "info");
    const { translateMarkdownDetailed, translationToasts } = await import("../../agents/commands");
    const r = await cancellable((signal) => translateMarkdownDetailed(liveDoc().content, target.trim(), signal));
    setContent(r.text);
    for (const [msg, kind] of translationToasts(r, t)) showAiToast(msg, kind);
  } catch (e) {
    if (isAbort(e)) return;
    if ((await import("../../agents/suggestions")).reportAgentFailure(e, "ai.translate")) return;
    showAiToast(t("toast.translationFailed", { error: explainError(e) }), "error");
  }
}

/** `image.altText` (moved from agents.ts, which loads this module when the command runs; W4.9). */
export const imageAltText = async (): Promise<void> => {
const { imageText, withImageText, imagesNeedingAlt, documentLanguage } = await import("../../ai/vision");
const { readWorkspaceBlob } = await import("../../storage/workspace");
const doc = useAppStore.getState().doc.content;
// Images with no alt, or still named after their file — a real
// one-word description ("logo") is kept.
const targets = imagesNeedingAlt(doc);
if (!targets.length) {
  showAiToast(t("toast.imageAlt.none"), "info");
  return;
}
showAiToast(t("toast.imageAlt.working", { count: targets.length }), "info");
let next = doc;
let done = 0;
// The user asked: the browser captioner may offer its download (plan 6.6).
const lang = await documentLanguage(doc, getLocale());
const consent = { confirm: uiConfirm, t, locale: getLocale() };
for (const m of targets) {
  const blob = await readWorkspaceBlob(m.url).catch(() => null);
  if (!blob) continue;
  const res = await imageText(blob, lang, { name: m.url, consent }).catch(() => null);
  if (!res || res.source === "none") continue;
  next = withImageText(next, m.url, m.alt, res);
  done++;
}
if (next !== useAppStore.getState().doc.content && useAppStore.getState().doc.content === doc) useAppStore.getState().setContent(next);
showAiToast(t("toast.imageAlt.done", { done, count: targets.length }), done ? "success" : "info");
};
