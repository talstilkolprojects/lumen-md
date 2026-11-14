/** Tools: the writing goal, the Hebrew dictionary and plugin commands. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { t } from "../../i18n";
import { uiPrompt } from "../../ui/PromptDialog";
import { getPluginCommands } from "../../plugins/pluginSystem";
import type { CommandContext } from "./context";

/** Daily writing goal. */
export function buildWritingGoalCommands({ writingGoalWords, setWritingGoal }: CommandContext): Command[] {
  return [
    {
      id: "view.hebrewGrammarLevel",
      label: t("cmd.view.hebrewGrammarLevel"),
      hint: t("cmd.view.hebrewGrammarLevel.hint"),
      icon: cmdIcons.Pencil,
      group: t("group.view"),
      action: () => import("./toolsActions").then((m) => m.cycleHebrewGrammarLevel()),
    },
    {
      // Plan W10.B9: the local model step of the grammar checker, off by default.
      id: "view.hebrewGrammarModel",
      label: t("cmd.view.hebrewGrammarModel"),
      hint: t("cmd.view.hebrewGrammarModel.hint"),
      icon: cmdIcons.Pencil,
      group: t("group.view"),
      action: () => import("./toolsActions").then((m) => m.toggleHebrewGrammarModel()),
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
      action: () => import("./toolsActions").then((m) => m.toggleHebrewDictionary()),
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

/** Plan W1.29: the moderator's usability-session recorder; W4.25: the self-guided session (local only, consent first). */
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
    // Plan W4.25: the participant runs the same tasks alone (opt-in, consent first, local only).
    {
      id: "research.usabilitySelf",
      label: t("cmd.research.usabilitySelf"),
      hint: t("cmd.research.usabilitySelf.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: () => window.dispatchEvent(new CustomEvent("lumen-open-usability-self")),
    },
  ];
}

/**
 * Arabic (plan W5.17): download or remove the Arabic word list, hide or show
 * tashkeel in the editor, remove it from the selection or the note. The
 * bodies (./arabicActions.ts), the modules and their messages load on use.
 */
export function buildArabicCommands({ getEditorView }: CommandContext): Command[] {
  const view = () => getEditorView?.() ?? null;
  const actions = () => import("./arabicActions");
  return [
    {
      id: "spell.arabicDictionary",
      label: t("cmd.spell.arabicDictionary"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => (await actions()).toggleArabicDictionary(),
    },
    {
      id: "arabic.toggleTashkeel",
      label: t("cmd.arabic.toggleTashkeel"),
      icon: cmdIcons.Eye,
      group: t("group.view"),
      action: async () => (await actions()).toggleTashkeelView(view()),
    },
    {
      id: "arabic.removeTashkeel",
      label: t("cmd.arabic.removeTashkeel"),
      icon: cmdIcons.Sparkles,
      group: t("group.tools"),
      action: async () => (await actions()).removeTashkeel(view()),
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
