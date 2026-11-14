/**
 * No-code automations (plan W5.24) in the palette: build a "when … then …"
 * rule in a few choices, a dry run on the open note (nothing is written),
 * and undo of the last run. Everything, the bodies included
 * (./automationsActions.ts), is loaded on first use.
 */
import { t } from "../../i18n";
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import type { CommandContext } from "./context";

const actions = () => import("./automationsActions");

export function buildAutomationCommands({ liveDoc }: CommandContext): Command[] {
  const group = t("group.tools");
  return [
    {
      id: "automations.new",
      label: t("cmd.automations.new"),
      hint: t("cmd.automations.new.hint"),
      icon: cmdIcons.Workflow,
      group,
      action: async () => (await actions()).newAutomation(),
    },
    {
      id: "automations.dryRun",
      label: t("cmd.automations.dryRun"),
      hint: t("cmd.automations.dryRun.hint"),
      icon: cmdIcons.Workflow,
      group,
      action: async () => {
        // Snapshot before the import: a tab switch while the chunk loads must not dry-run another note.
        const doc = liveDoc();
        await (await actions()).dryRunAutomations(doc);
      },
    },
    {
      id: "automations.undo",
      label: t("cmd.automations.undo"),
      hint: t("cmd.automations.undo.hint"),
      icon: cmdIcons.Workflow,
      group,
      action: async () => (await actions()).undoLastAutomation(),
    },
  ];
}
