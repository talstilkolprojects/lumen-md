/** The open-sources dialog (plan W7.24) in the palette, on ⌥⌘S / Ctrl+Alt+S. */
import { t } from "../../i18n";
import { cmdIcons, type Command } from "../../ui/CommandPalette";

export function buildOpenSourceCommands(): Command[] {
  return [
    {
      id: "sources.open",
      label: t("cmd.sources.open"),
      hint: t("cmd.sources.open.hint"),
      icon: cmdIcons.Quote,
      group: t("group.insert"),
      shortcut: "⌥⌘S",
      action: () => void import("../../sources/open/OpenSourcesDialog").then((m) => m.openSourcesDialog()),
    },
  ];
}
