/**
 * AI batch jobs over a folder of notes. The palette's list carries only the
 * names; the bodies (./batchActions.ts) load when a command runs.
 */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { t } from "../../i18n";

const run = (id: string) => async () => {
  const cmd = (await import("./batchActions")).buildBatchCommands().find((c) => c.id === id);
  await cmd?.action();
};

/** Submit a batch job over a folder of notes; check jobs and apply their results. */
export function buildBatchCommands(): Command[] {
  return ["ai.batch", "ai.batchCheck", "ai.autofill", "ai.summarize", "ai.fim", "ai.batchJobs"].map((id) => ({
    id,
    label: t(`cmd.${id}`),
    hint: t(`cmd.${id}.hint`),
    icon: cmdIcons.Sparkles,
    group: t("group.tools"),
    action: run(id),
  }));
}
