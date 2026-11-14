/** Tools: the writing goal, the Hebrew dictionary and plugin commands. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { t } from "../../i18n";
import { uiConfirm, uiPrompt } from "../../ui/PromptDialog";
import { getPluginCommands } from "../../plugins/pluginSystem";
import { showAiToast } from "../../ui/AiToast";
import type { CommandContext } from "./context";

/** Daily writing goal. */
export function buildWritingGoalCommands({ writingGoalWords, setWritingGoal }: CommandContext): Command[] {
  return [
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

/** Download or remove the Hebrew spelling dictionary. */
export function buildHebrewDictionaryCommands(): Command[] {
  return [
    {
      id: "spell.hebrewDictionary",
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
          showAiToast(t("spell.he.failed", { error: (e as Error).message }), "error");
        }
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
