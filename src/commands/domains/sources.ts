/**
 * Jewish sources from Sefaria (plan W5.1), in the palette:
 *
 *  - "Insert a source from Sefaria…": the selection (or a typed reference —
 *    "בראשית א:א", "ב״ר א, א", "Berakhot 2a") becomes a quote with the
 *    Hebrew and its translation where their licences are free, each
 *    version's licence, a Sefaria link, and a verse link for the graph.
 *    A saved (offline) copy is used first, with no request; otherwise the
 *    reference — and only the reference — goes to sefaria.org, after the
 *    user confirms, through the privacy ledger.
 *  - "Save this source for offline": the user-initiated offline copy
 *    (free text only) in Sources/Sefaria/.
 *  - "My notes on this verse": every note that cites the same verse.
 */
import { t } from "../../i18n";
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import type { CommandContext } from "./context";

// The command bodies load on first use (sourcesActions.ts): the palette lists these commands at start-up (W4.9).
export function buildSourceCommands(ctx: CommandContext): Command[] {
  const group = t("group.insert");
  return [
    {
      id: "sources.insertSefaria",
      label: t("cmd.sources.insert"),
      hint: t("cmd.sources.insert.hint"),
      icon: cmdIcons.Quote,
      group,
      action: () => import("./sourcesActions").then((m) => m.insertSefaria(ctx)),
    },
    {
      id: "sources.saveOffline",
      label: t("cmd.sources.saveOffline"),
      hint: t("cmd.sources.saveOffline.hint"),
      icon: cmdIcons.Download,
      group,
      action: () => import("./sourcesActions").then((m) => m.saveOffline(ctx)),
    },
    {
      id: "sources.notesOnVerse",
      label: t("cmd.sources.notesOnVerse"),
      hint: t("cmd.sources.notesOnVerse.hint"),
      icon: cmdIcons.Link,
      group,
      action: () => import("./sourcesActions").then((m) => m.notesOnVerse(ctx)),
    },
  ];
}
