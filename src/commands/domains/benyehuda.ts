/**
 * The Ben-Yehuda library (plan W7.7), in the palette:
 *
 *  - "Download the Ben-Yehuda library…": the catalogue of the project's
 *    public-domain dump and the works of the authors you pick, once, from
 *    GitHub, after you confirm. Then everything is local.
 *  - "Search the Ben-Yehuda library…": author, work and text, on this device.
 *    A downloaded work opens as a note (the reading view, ==highlights==).
 *  - "Copy as a quote (Ben-Yehuda)": the selected passage of an open work
 *    as a quote with author, work, link and the public-domain mark.
 *  - "Highlight this passage": the selection goes to the highlights hub.
 */
import { t } from "../../i18n";
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import type { CommandContext } from "./context";

// The command bodies load on first use (benyehudaActions.ts): the palette lists these commands at start-up (W4.9).
export function buildBenYehudaCommands(ctx: CommandContext): Command[] {
  const group = t("group.insert");
  return [
    {
      id: "sources.benyehudaDownload",
      label: t("cmd.sources.benyehudaDownload"),
      hint: t("cmd.sources.benyehudaDownload.hint"),
      icon: cmdIcons.Download,
      group,
      action: () => import("./benyehudaActions").then((m) => m.benyehudaDownload(ctx)),
    },
    {
      id: "sources.benyehudaSearch",
      label: t("cmd.sources.benyehudaSearch"),
      hint: t("cmd.sources.benyehudaSearch.hint"),
      icon: cmdIcons.FileText,
      group,
      action: () => import("./benyehudaActions").then((m) => m.benyehudaSearch(ctx)),
    },
    {
      id: "sources.benyehudaQuote",
      label: t("cmd.sources.benyehudaQuote"),
      hint: t("cmd.sources.benyehudaQuote.hint"),
      icon: cmdIcons.Quote,
      group,
      action: () => import("./benyehudaActions").then((m) => m.benyehudaQuote(ctx)),
    },
    {
      id: "sources.benyehudaHighlight",
      label: t("cmd.sources.benyehudaHighlight"),
      hint: t("cmd.sources.benyehudaHighlight.hint"),
      icon: cmdIcons.Pencil,
      group,
      action: () => import("./benyehudaActions").then((m) => m.benyehudaHighlight(ctx)),
    },
  ];
}
