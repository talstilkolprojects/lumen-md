/** Tools: the writing goal, the Hebrew dictionary and plugin commands. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { t } from "../../i18n";
import { uiConfirm, uiPrompt } from "../../ui/PromptDialog";
import { getPluginCommands } from "../../plugins/pluginSystem";
import { showAiToast } from "../../ui/AiToast";
import type { CommandContext } from "./context";
import { explainError } from "../../lib/userError";

/** Daily writing goal. */
export function buildWritingGoalCommands({ writingGoalWords, setWritingGoal }: CommandContext): Command[] {
  return [
    {
      id: "view.hebrewGrammarLevel",
      label: t("cmd.view.hebrewGrammarLevel"),
      hint: t("cmd.view.hebrewGrammarLevel.hint"),
      icon: cmdIcons.Pencil,
      group: t("group.view"),
      action: async () => {
        const { getGrammarLevel, setGrammarLevel } = await import("../../ai/hebrewSpellService");
        const { GRAMMAR_LEVELS } = await import("../../ai/hebrewGrammar");
        const next = GRAMMAR_LEVELS[(GRAMMAR_LEVELS.indexOf(getGrammarLevel()) + 1) % GRAMMAR_LEVELS.length];
        setGrammarLevel(next);
        const name = { everyday: t("grammar.he.level.everyday"), academic: t("grammar.he.level.academic"), legal: t("grammar.he.level.legal") }[next];
        showAiToast(t("grammar.he.levelSet", { level: name }), "success");
      },
    },
    {
      id: "tools.writingGoal",
      label: writingGoalWords > 0
        ? t("cmd.tools.writingGoal.set", { words: writingGoalWords })
        : t("cmd.tools.writingGoal.unset"),
      hint: t("cmd.tools.writingGoal.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const ans = await uiPrompt({
          message: t("writingGoal.prompt"),
          defaultValue: String(writingGoalWords || 500),
        });
        if (ans === null) return;
        setWritingGoal(Number(ans) || 0);
      },
    },
  ];
}

/** Download or remove the Hebrew spelling dictionary; the Hebrew lexicon (plan W5.26). */
export function buildHebrewDictionaryCommands({ getEditorView }: CommandContext): Command[] {
  return [
    {
      id: "spell.hebrewDictionary",
      destructive: "confirm",
      label: t("cmd.spell.hebrewDictionary"),
      hint: t("cmd.spell.hebrewDictionary.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const svc = await import("../../ai/hebrewSpellService");
        if (await svc.hebrewDictionaryInstalled()) {
          if (!(await uiConfirm({ message: t("spell.he.removeConfirm") }))) return;
          await svc.removeHebrewDictionary();
          showAiToast(t("spell.he.removed"), "info");
          return;
        }
        if (!(await uiConfirm({ message: t("spell.he.downloadConfirm") }))) return;
        try {
          const n = await svc.downloadHebrewDictionary();
          showAiToast(t("spell.he.installed", { n: n.toLocaleString() }), "info");
        } catch (e) {
          showAiToast(t("spell.he.failed", { error: explainError(e) }), "error");
        }
      },
    },
    {
      id: "lexicon.pack",
      label: t("cmd.lexicon.pack"),
      hint: t("cmd.lexicon.pack.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const { runLexiconPackCommand } = await import("../../lexicon/commands");
        await runLexiconPackCommand();
      },
    },
    {
      id: "lexicon.lookup",
      label: t("cmd.lexicon.lookup"),
      hint: t("cmd.lexicon.lookup.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const view = getEditorView?.();
        if (!view) return;
        const { runLexiconLookupCommand } = await import("../../lexicon/commands");
        await runLexiconLookupCommand(view);
      },
    },
  ];
}

/** Plan W1.29: the moderator's usability-session recorder (local only, consent first). */
export function buildUsabilityStudyCommands(): Command[] {
  return [
    {
      id: "research.usability",
      label: t("cmd.research.usability"),
      hint: t("cmd.research.usability.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => window.dispatchEvent(new CustomEvent("lumen-open-usability")),
    },
  ];
}

/**
 * Arabic (plan W5.17): download or remove the Arabic word list, hide or show
 * tashkeel in the editor, remove it from the selection or the note. The
 * modules and their messages load on use.
 */
export function buildArabicCommands({ getEditorView }: CommandContext): Command[] {
  return [
    {
      id: "spell.arabicDictionary",
      label: t("cmd.spell.arabicDictionary"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const svc = await import("../../ai/arabicSpellService");
        if (await svc.arabicDictionaryInstalled()) {
          if (!(await uiConfirm({ message: t("spell.ar.removeConfirm") }))) return;
          await svc.removeArabicDictionary();
          showAiToast(t("spell.ar.removed"), "info");
          return;
        }
        if (!(await uiConfirm({ message: t("spell.ar.downloadConfirm") }))) return;
        try {
          const n = await svc.downloadArabicDictionary();
          showAiToast(t("spell.ar.installed", { n: n.toLocaleString() }), "info");
        } catch (e) {
          showAiToast(t("spell.ar.failed", { error: (e as Error).message }), "error");
        }
      },
    },
    {
      id: "arabic.toggleTashkeel",
      label: t("cmd.arabic.toggleTashkeel"),
      icon: cmdIcons.Eye,
      group: t("group.view"),
      action: async () => {
        const view = getEditorView?.();
        if (!view) return;
        const { toggleTashkeel } = await import("../../editor/tashkeelView");
        showAiToast(t(toggleTashkeel(view) ? "tashkeel.hidden" : "tashkeel.shown"), "info");
      },
    },
    {
      id: "arabic.removeTashkeel",
      label: t("cmd.arabic.removeTashkeel"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => {
        const view = getEditorView?.();
        if (!view) return;
        const { removeTashkeelIn } = await import("../../editor/tashkeelView");
        if (!removeTashkeelIn(view)) showAiToast(t("tashkeel.nothing"), "info");
      },
    },
  ];
}

/** Commands registered by plugins. */
export function buildPluginCommands(): Command[] {
  return [
    ...getPluginCommands().map((cmd) => ({
      id: cmd.id,
      label: cmd.label,
      hint: cmd.hint ?? t("group.plugins"),
      icon: cmdIcons.Sparkles,
      group: t("group.plugins"),
      action: cmd.action,
    })),
  ];
}
