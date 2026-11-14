/** AI actions on the open note: tags, links, diagrams, translation, grammar, alt text, prompt templates. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { useAppStore } from "../../store/useStore";
import { t, getLocale, tPlural } from "../../i18n";
import { uiAlert, uiConfirm, uiPrompt } from "../../ui/PromptDialog";
import { AI_PROMPT_TEMPLATES, applyTemplate } from "../../ai/multiLangPrompts";
import { showAiToast } from "../../ui/AiToast";
import { isAbort } from "../../ai/aiAbort";
import { cancellable, type CommandContext } from "./context";

/** Agents on the open note: tags, links, product, diagram, action items, translation, chart. */
export function buildDocumentAgentCommands({ setContent, liveDoc }: CommandContext): Command[] {
  return [
    {
      id: "tools.autoTag",
      label: t("cmd.tools.autoTag"),
      hint: t("cmd.tools.autoTag.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
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
          showAiToast(t("toast.autoTagFailed", { error: (e as Error).message }), "error");
        }
      },
    },
    {
      id: "tools.suggestLinks",
      label: t("cmd.tools.suggestLinks"),
      hint: t("cmd.tools.suggestLinks.hint"),
      icon: cmdIcons.Link,
      group: t("group.tools"),
      action: async () => {
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
          showAiToast(t("toast.linkSuggestFailed", { error: (e as Error).message }), "error");
        }
      },
    },
    {
      id: "ai.productAgent",
      label: t("cmd.ai.productAgent", { defaultValue: "AI: Create Product" }),
      hint: t("cmd.ai.productAgent.hint", { defaultValue: "Generate a complete project from a description" }),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
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
          showAiToast(t("toast.agentError", { error: (e as Error).message }), "error");
        }
      },
    },
    {
      id: "ai.diagram",
      label: t("cmd.ai.diagram", { defaultValue: "AI: Diagram from Text" }),
      hint: t("cmd.ai.diagram.hint", { defaultValue: "Generate a Mermaid diagram from the document" }),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        try {
          showAiToast(t("toast.generatingDiagram"), "info");
          const { generateDiagram } = await import("../../agents/commands");
          const block = await cancellable((signal) => generateDiagram(liveDoc().content, signal));
          setContent(`${liveDoc().content.trimEnd()}\n\n${block}\n`);
          showAiToast(t("toast.diagramInserted"), "success");
        } catch (e) {
          if (isAbort(e)) return;
          if ((await import("../../agents/suggestions")).reportAgentFailure(e, "ai.diagram")) return;
          showAiToast(t("toast.diagramFailed", { error: (e as Error).message }), "error");
        }
      },
    },
    {
      id: "ai.actionItems",
      label: t("cmd.ai.actionItems", { defaultValue: "AI: Extract Action Items" }),
      hint: t("cmd.ai.actionItems.hint", { defaultValue: "Pull a task list out of meeting notes" }),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        try {
          showAiToast(t("toast.extractingActionItems"), "info");
          const { extractActionItems } = await import("../../agents/commands");
          const list = await cancellable((signal) => extractActionItems(liveDoc().content, signal));
          setContent(`${liveDoc().content.trimEnd()}\n\n## Action Items\n\n${list}\n`);
          showAiToast(t("toast.actionItemsAdded"), "success");
        } catch (e) {
          if (isAbort(e)) return;
          if ((await import("../../agents/suggestions")).reportAgentFailure(e, "ai.actionItems")) return;
          showAiToast(t("toast.actionItemsFailed", { error: (e as Error).message }), "error");
        }
      },
    },
    {
      id: "ai.translate",
      label: t("cmd.ai.translate", { defaultValue: "AI: Translate Document" }),
      hint: t("cmd.ai.translate.hint", { defaultValue: "Translate the whole document, preserving formatting" }),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
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
          showAiToast(t("toast.translationFailed", { error: (e as Error).message }), "error");
        }
      },
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
          showAiToast(t("toast.chartFailed", { error: (e as Error).message }), "error");
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
          showAiToast(reason ? t(`analyst.${reason}`, { error: (e as Error).message }) : t("analyst.failed", { error: (e as Error).message }), "error");
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
      action: async () => {
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
      },
    },
  ];
}

/** Niqqud on the selection or the note (plan 6.3): Nakdimon in a worker, with consent. */
export function buildNikudCommands({ getEditorView, locale }: CommandContext): Command[] {
  const runNikud = async (mode: "add" | "partial" | "remove") => {
    const view = getEditorView?.();
    if (!view) return;
    try {
      const [{ runNikudCommand }, svc] = await Promise.all([import("../../editor/nikudCommand"), import("../../ai/nikudService")]);
      if (mode !== "remove") showAiToast(t("toast.nikud.working"), "info");
      const changed = await cancellable((signal) =>
        runNikudCommand(view, mode, {
          point: (text, partial) => svc.pointHebrew(text, { consent: { confirm: uiConfirm, t, locale }, signal }, { partial }),
          unpoint: svc.unpointHebrew,
        }),
      );
      if (!changed) showAiToast(t("toast.nikud.nothing"), "info");
    } catch (e) {
      if (isAbort(e)) return;
      const reason = (e as { name?: string; reason?: string }).name === "NikudUnavailableError" ? (e as { reason: string }).reason : null;
      showAiToast(reason ? t(`toast.nikud.${reason}`) : t("toast.nikud.failed", { error: (e as Error).message }), reason ? "info" : "error");
    }
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
          showAiToast(t("toast.grammarCheckFailed", { error: (e as Error).message }), "error");
        }
      },
    },
  ];
}

/** AI prompt templates in the UI language. */
export function buildPromptTemplateCommands({ locale, setContent, liveDoc }: CommandContext): Command[] {
  return [
    ...AI_PROMPT_TEMPLATES.filter((tpl) => tpl.lang === locale).map((tpl) => ({
      id: `ai.prompt.${tpl.id}`,
      label: tpl.label,
      hint: tpl.category,
      icon: cmdIcons.Sparkles,
      group: t("group.ai"),
      action: async () => {
        const prompt = applyTemplate(tpl, liveDoc().content);
        try {
          showAiToast(t("toast.processing", { name: tpl.label }), "info");
          const { runAgentOrThrow } = await import("../../agents/runtime");
          const { templaterAgent } = await import("../../agents/defs");
          const result = await cancellable((signal) => runAgentOrThrow(templaterAgent, { text: prompt, extra: { templateId: tpl.id } }, { document: liveDoc().content, signal }));
          setContent(liveDoc().content + "\n\n---\n\n" + result);
          showAiToast(t("toast.completed", { name: tpl.label }), "success");
        } catch (e) {
          if (isAbort(e)) return;
          if ((await import("../../agents/suggestions")).reportAgentFailure(e, `ai.prompt.${tpl.id}`)) return;
          showAiToast(t("toast.aiError", { error: (e as Error).message }), "error");
        }
      },
    })),
  ];
}
