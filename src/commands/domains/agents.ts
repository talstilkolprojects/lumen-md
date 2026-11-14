/** AI actions on the open note: tags, links, diagrams, translation, grammar, alt text, prompt templates. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { t, tPlural } from "../../i18n";
import { uiAlert, uiPrompt } from "../../ui/PromptDialog";
import { AI_PROMPT_INDEX } from "../../ai/multiLangPromptIndex";
import { showAiToast } from "../../ui/AiToast";
import { isAbort } from "../../ai/aiAbort";
import { cancellable, type CommandContext } from "./context";
import { explainError } from "../../lib/userError";

/** Agents on the open note: tags, links, product, diagram, action items, translation, chart. */
export function buildDocumentAgentCommands({ setContent, liveDoc }: CommandContext): Command[] {
  return [
    {
      id: "tools.autoTag",
      label: t("cmd.tools.autoTag"),
      hint: t("cmd.tools.autoTag.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => void import("./agentsActions").then((m) => m.autoTag({ setContent, liveDoc })),
    },
    {
      id: "tools.suggestLinks",
      label: t("cmd.tools.suggestLinks"),
      hint: t("cmd.tools.suggestLinks.hint"),
      icon: cmdIcons.Link,
      group: t("group.tools"),
      action: () => void import("./agentsActions").then((m) => m.suggestLinksFlow({ setContent, liveDoc })),
    },
    {
      id: "ai.productAgent",
      label: t("cmd.ai.productAgent", { defaultValue: "AI: Create Product" }),
      hint: t("cmd.ai.productAgent.hint", { defaultValue: "Generate a complete project from a description" }),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => void import("./agentsActions").then((m) => m.productAgentFlow()),
    },
    {
      id: "ai.diagram",
      label: t("cmd.ai.diagram", { defaultValue: "AI: Diagram from Text" }),
      hint: t("cmd.ai.diagram.hint", { defaultValue: "Generate a Mermaid diagram from the document" }),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => void import("./agentsActions").then((m) => m.diagramFlow({ setContent, liveDoc })),
    },
    {
      id: "ai.actionItems",
      label: t("cmd.ai.actionItems", { defaultValue: "AI: Extract Action Items" }),
      hint: t("cmd.ai.actionItems.hint", { defaultValue: "Pull a task list out of meeting notes" }),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => void import("./agentsActions").then((m) => m.actionItemsFlow({ setContent, liveDoc })),
    },
    {
      id: "ai.translate",
      label: t("cmd.ai.translate", { defaultValue: "AI: Translate Document" }),
      hint: t("cmd.ai.translate.hint", { defaultValue: "Translate the whole document, preserving formatting" }),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => void import("./agentsActions").then((m) => m.translateFlow({ setContent, liveDoc })),
    },
    {
      id: "ai.chart",
      label: t("cmd.ai.chart", { defaultValue: "AI: Chart from Data" }),
      hint: t("cmd.ai.chart.hint", { defaultValue: "Turn CSV or table data into an ECharts chart" }),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        try {
          showAiToast(t("toast.generatingChart"), "info");
          const { generateChart } = await import("../../agents/commands");
          const block = await cancellable((signal) => generateChart(liveDoc().content, signal));
          setContent(`${liveDoc().content.trimEnd()}\n\n${block}\n`);
          showAiToast(t("toast.chartInserted"), "success");
        } catch (e) {
          if (isAbort(e)) return;
          if ((await import("../../agents/suggestions")).reportAgentFailure(e, "ai.chart")) return;
          showAiToast(t("toast.chartFailed", { error: explainError(e) }), "error");
        }
      },
    },
    {
      id: "ai.analyse",
      label: t("cmd.ai.analyse"),
      hint: t("cmd.ai.analyse.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        await import("../../agents/analystStrings");
        const question = await uiPrompt({ message: t("cmd.ai.analyse.ask") });
        if (!question || !question.trim()) return;
        try {
          const { analyseNote } = await import("../../agents/analyst");
          showAiToast(t("analyst.working"), "info");
          const { result, blocks } = await cancellable((signal) => analyseNote(liveDoc().content, question.trim(), signal));
          setContent(`${liveDoc().content.trimEnd()}\n\n${blocks}\n`);
          showAiToast(t("analyst.done", { answer: String(result.answer.answer) }), "success");
        } catch (e) {
          if (isAbort(e)) return;
          if ((await import("../../agents/suggestions")).reportAgentFailure(e, "ai.analyse")) return;
          const reason = (e as { name?: string; reason?: string }).name === "AnalystError" ? (e as { reason: string }).reason : null;
          showAiToast(reason ? t(`analyst.${reason}`, { error: explainError(e) }) : t("analyst.failed", { error: explainError(e) }), "error");
        }
      },
    },
  ];
}

/** Describe the note's images that have no alt text. */
export function buildAltTextCommands(): Command[] {
  return [
    {
      id: "image.altText",
      label: t("cmd.image.altText"),
      hint: t("cmd.image.altText.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.ai", { defaultValue: "AI Copilot" }),
      action: () => import("./agentsActions").then((m) => m.imageAltText()),
    },
  ];
}

/** Niqqud on the selection or the note (plans 6.3, W2.5): the whole flow is loaded on use. */
export function buildNikudCommands({ getEditorView, locale }: CommandContext): Command[] {
  const runNikud = async (mode: "add" | "partial" | "remove") => {
    const view = getEditorView?.();
    if (view) await (await import("../../editor/nikudPalette")).runNikudFromPalette(view, mode, locale);
  };
  return [
    {
      id: "nikud.add",
      label: t("cmd.nikud.add"),
      hint: t("cmd.nikud.add.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => runNikud("add"),
    },
    {
      id: "nikud.partial",
      label: t("cmd.nikud.partial"),
      hint: t("cmd.nikud.partial.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => runNikud("partial"),
    },
    {
      id: "nikud.remove",
      label: t("cmd.nikud.remove"),
      hint: t("cmd.nikud.remove.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => runNikud("remove"),
    },
  ];
}

/** Check the note's grammar. */
export function buildGrammarCommands({ locale, liveDoc }: CommandContext): Command[] {
  return [
    {
      id: "tools.checkGrammar",
      label: t("cmd.tools.grammar"),
      hint: t("cmd.tools.grammar.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const { checkGrammar } = await import("../../ai/grammar");
        try {
          showAiToast(t("toast.checkingGrammar"), "info");
          const text = liveDoc().content;
          const matches = await cancellable((signal) => checkGrammar(text, locale === "he" ? "he" : "en-US", { allowModel: true, signal }));
          if (matches.length === 0) {
            showAiToast(t("toast.noGrammarIssuesFound"), "success");
            return;
          }
          const top = matches.slice(0, 5).map((m, i) => `${i + 1}. ${m.message}`).join("\n");
          await uiAlert({ message: tPlural("agent.grammar.found", matches.length, { list: top }) });
        } catch (e) {
          if (isAbort(e)) return;
          if ((await import("../../agents/suggestions")).reportAgentFailure(e, "tools.checkGrammar")) return;
          showAiToast(t("toast.grammarCheckFailed", { error: explainError(e) }), "error");
        }
      },
    },
  ];
}

/** AI prompt templates in the UI language. */
export function buildPromptTemplateCommands({ locale, setContent, liveDoc }: CommandContext): Command[] {
  return [
    // The palette lists the templates from their index; the prompts load with the command.
    ...AI_PROMPT_INDEX.filter((tpl) => tpl.lang === locale).map((tpl) => ({
      id: `ai.prompt.${tpl.id}`,
      label: tpl.label,
      hint: tpl.category,
      icon: cmdIcons.Sparkles,
      group: t("group.ai"),
      action: async () => {
        const content = liveDoc().content;
        try {
          const { AI_PROMPT_TEMPLATES, applyTemplate } = await import("../../ai/multiLangPrompts");
          const template = AI_PROMPT_TEMPLATES.find((x) => x.id === tpl.id);
          if (!template) return;
          const prompt = applyTemplate(template, content);
          showAiToast(t("toast.processing", { name: tpl.label }), "info");
          const { runAgentOrThrow } = await import("../../agents/runtime");
          const { templaterAgent } = await import("../../agents/defs");
          const result = await cancellable((signal) => runAgentOrThrow(templaterAgent, { text: prompt, extra: { templateId: tpl.id } }, { document: liveDoc().content, signal }));
          setContent(liveDoc().content + "\n\n---\n\n" + result);
          showAiToast(t("toast.completed", { name: tpl.label }), "success");
        } catch (e) {
          if (isAbort(e)) return;
          if ((await import("../../agents/suggestions")).reportAgentFailure(e, `ai.prompt.${tpl.id}`)) return;
          showAiToast(t("toast.aiError", { error: explainError(e) }), "error");
        }
      },
    })),
  ];
}
