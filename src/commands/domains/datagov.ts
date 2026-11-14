/**
 * Government data in a note (plan W7.6), in the palette:
 *
 *  - "Insert government data (data.gov.il)…": search datasets, pick one and
 *    a resource; its rows are saved as a CSV snapshot in the vault and a
 *    ```dataset block plus its attribution line go into the note.
 *  - "Insert a CBS series…": the same for a CBS time series by its id.
 *  - "Refresh this dataset": fetch the block under the cursor again and
 *    show what changed before the note switches to the new snapshot.
 *
 * Nothing is fetched until the user confirms; the source starts off and the
 * first use asks to turn it on.
 */
import { t } from "../../i18n";
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import type { CommandContext } from "./context";

// The command bodies load on first use (datagovActions.ts): the palette lists these commands at start-up (W4.9).
export function buildDataGovCommands(ctx: CommandContext): Command[] {
  const group = t("group.insert");
  return [
    {
      id: "sources.datagovInsert",
      label: t("cmd.sources.datagovInsert"),
      hint: t("cmd.sources.datagovInsert.hint"),
      icon: cmdIcons.Table,
      group,
      action: () => import("./datagovActions").then((m) => m.datagovInsert(ctx)),
    },
    {
      id: "sources.cbsSeries",
      label: t("cmd.sources.cbsSeries"),
      hint: t("cmd.sources.cbsSeries.hint"),
      icon: cmdIcons.BarChart3,
      group,
      action: () => import("./datagovActions").then((m) => m.cbsSeries(ctx)),
    },
    {
      id: "sources.datasetRefresh",
      label: t("cmd.sources.datasetRefresh"),
      hint: t("cmd.sources.datasetRefresh.hint"),
      icon: cmdIcons.Download,
      group,
      action: () => import("./datagovActions").then((m) => m.datasetRefresh(ctx)),
    },
  ];
}
