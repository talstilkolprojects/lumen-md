/** Accessibility commands (plan W1.23): what the editor announces, "where am I", the accessibility statement. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { getLocale, t } from "../../i18n";
import { announce, nextVerbosity, setVerbosity, verbosity } from "../../a11y/announce";
import { docsUrl } from "../../lib/docsLinks";
import type { CommandContext } from "./context";

/** The accessibility issue form (.github/ISSUE_TEMPLATE/accessibility.yml). */
export const A11Y_REPORT_URL = "https://github.com/talstilkol/lumen-md/issues/new?template=accessibility.yml&labels=accessibility";

export function buildAccessibilityCommands({ getEditorView }: CommandContext): Command[] {
  return [
    {
      id: "a11y.srVerbosity",
      label: t("cmd.a11y.srVerbosity", { mode: t(`sr.mode.${verbosity()}`) }),
      hint: t("cmd.a11y.srVerbosity.hint"),
      icon: cmdIcons.Eye,
      group: t("group.view"),
      action: () => {
        const next = nextVerbosity(verbosity());
        setVerbosity(next);
        announce(t("cmd.a11y.srVerbosity", { mode: t(`sr.mode.${next}`) }));
      },
    },
    {
      id: "a11y.whereAmI",
      label: t("cmd.a11y.whereAmI"),
      hint: t("cmd.a11y.whereAmI.hint"),
      icon: cmdIcons.Eye,
      group: t("group.view"),
      action: async () => {
        const view = getEditorView?.();
        if (!view) return;
        // Loaded on use: the palette is in the startup bundle, CodeMirror is not.
        const { describePosition } = await import("../../editor/srAnnouncements");
        announce(describePosition(view));
      },
    },
    {
      id: "help.a11yStatement",
      label: t("cmd.help.a11yStatement"),
      hint: t("cmd.help.a11yStatement.hint"),
      icon: cmdIcons.FileText,
      group: t("group.file"),
      action: () => window.open(docsUrl("a11yStatement", undefined, getLocale() === "he" ? "he" : undefined), "_blank", "noopener,noreferrer"),
    },
    {
      id: "help.acr",
      label: t("cmd.help.acr"),
      hint: t("cmd.help.acr.hint"),
      icon: cmdIcons.FileText,
      group: t("group.file"),
      action: () => window.open(docsUrl("acr", undefined, getLocale() === "he" ? "he" : undefined), "_blank", "noopener,noreferrer"),
    },
    {
      // The accessibility contact channel (plan W3.8): a GitHub issue form, labelled and triaged first.
      id: "help.a11yReport",
      label: t("cmd.help.a11yReport"),
      hint: t("cmd.help.a11yReport.hint"),
      icon: cmdIcons.FileText,
      group: t("group.file"),
      action: () => window.open(A11Y_REPORT_URL, "_blank", "noopener,noreferrer"),
    },
  ];
}
