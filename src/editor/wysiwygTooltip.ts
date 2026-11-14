/**
 * The WYSIWYG selection tooltip: inline formatting buttons and the AI
 * rewrite (plan W6.25: moved out of WysiwygEditor.tsx unchanged).
 */
import type { EditorView } from "@milkdown/prose/view";
import { toggleMark } from "@milkdown/prose/commands";
import { showAiToast } from "../ui/AiToast";
import { openAiPrompt } from "../ui/AiInlinePrompt";
import { log } from "../lib/logger";
import { t } from "../i18n";

interface TooltipBtn {
  label: string;
  title: string;
  run: (v: EditorView) => void;
}

export function buildTooltip(getView: () => EditorView | null): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "milkdown-tooltip";
  el.dataset.show = "false";

  const buttons: TooltipBtn[] = [
    {
      label: "B",
      title: "Bold",
      run: (v) => {
        const m = v.state.schema.marks.strong;
        if (m) toggleMark(m)(v.state, v.dispatch);
      },
    },
    {
      label: "I",
      title: "Italic",
      run: (v) => {
        const m = v.state.schema.marks.emphasis;
        if (m) toggleMark(m)(v.state, v.dispatch);
      },
    },
    {
      label: "S",
      title: "Strikethrough",
      run: (v) => {
        const m = v.state.schema.marks.strike_through;
        if (m) toggleMark(m)(v.state, v.dispatch);
      },
    },
    {
      label: "</>",
      title: "Inline code",
      run: (v) => {
        const m = v.state.schema.marks.code_inline ?? v.state.schema.marks.inlineCode;
        if (m) toggleMark(m)(v.state, v.dispatch);
      },
    },
    {
      label: "🔗",
      title: "Link",
      run: async (v) => {
        const m = v.state.schema.marks.link;
        if (!m) return;
        const url = await openAiPrompt("URL:");
        if (!url) return;
        toggleMark(m, { href: url })(v.state, v.dispatch);
      },
    },
    {
      label: "✨",
      title: "AI Rewrite",
      run: async (v) => {
        const { state, dispatch } = v;
        const { from, to } = state.selection;
        if (from === to) return;
        
        const selectedText = state.doc.textBetween(from, to, "\n");
        const instructions = await openAiPrompt("How should the AI rewrite this? (e.g. 'Make it professional', 'Translate to Spanish')");
        if (!instructions) return;
        
        const { aiOperation, isAbort } = await import("../ai/aiAbort");
        const op = aiOperation();
        try {
          // Plan 5.5: the `rewriter` agent (with the style profile), through the runtime.
          const [{ runAgentOrThrow }, { rewriterAgent }] = await Promise.all([import("../agents/runtime"), import("../agents/defs")]);
          const rewritten = await runAgentOrThrow(rewriterAgent, { text: selectedText, extra: { instruction: instructions } }, { ownPrompt: true, signal: op.signal, selection: selectedText });
          dispatch(state.tr.replaceWith(from, to, state.schema.text(rewritten)));
        } catch (e) {
          if (isAbort(e)) return;
          log.error("WYSIWYG AI rewrite failed", e);
          if (await import("../agents/suggestions").then((m) => m.reportAgentFailure(e, "wysiwyg.aiRewrite"))) return;
          // A spent quota already showed its own toast.
          if (!(e instanceof Error && e.name === "AiQuotaExceededError")) showAiToast(t("toast.aiRewriteFailed"), "error");
        } finally {
          op.end();
        }
      },
    },
  ];

  for (const btn of buttons) {
    const b = document.createElement("button");
    b.type = "button";
    b.title = btn.title;
    b.textContent = btn.label;
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const view = getView();
      if (!view) return;
      btn.run(view);
      view.focus();
    });
    b.addEventListener("mousedown", (e) => e.preventDefault());
    el.appendChild(b);
  }
  return el;
}
