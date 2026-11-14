/** Yiddish and Ladino (plan W7.9): transliterate the selection; the Yiddish spelling list. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { t } from "../../i18n";
import type { CommandContext } from "./context";

export function buildJewishLanguageCommands({ getEditorView }: CommandContext): Command[] {
  return [
    {
      id: "text.transliterate",
      label: t("cmd.text.transliterate"),
      hint: t("cmd.text.transliterate.hint"),
      icon: cmdIcons.Pencil,
      group: t("group.edit"),
      action: async () => {
        const view = getEditorView?.();
        if (!view) return;
        const { runTransliterateCommand } = await import("../../text/jewishLanguageCommands");
        await runTransliterateCommand(view);
      },
    },
    {
      id: "spell.yiddishDictionary",
      destructive: "confirm",
      label: t("cmd.spell.yiddishDictionary"),
      hint: t("cmd.spell.yiddishDictionary.hint"),
      icon: cmdIcons.Download,
      group: t("group.tools"),
      action: async () => {
        const { runYiddishDictionaryCommand } = await import("../../text/jewishLanguageCommands");
        await runYiddishDictionaryCommand();
      },
    },
  ];
}
