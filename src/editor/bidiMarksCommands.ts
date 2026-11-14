/**
 * Palette commands for direction controls (plan W5.4):
 *   - "Show direction marks" / "Hide direction marks";
 *   - "Clean direction marks and fix brackets": one undoable change in
 *     whichever editor is open; in the preview the note text is rewritten
 *     and the toast offers Undo.
 */
import type { EditorView } from "@codemirror/view";
import { t } from "../i18n";
import { bidiMarksShown, toggleBidiMarks } from "./bidiMarksSetting";

export interface BidiMarksCommandDeps {
  getView: () => EditorView | null;
  getContent: () => string;
  setContent: (s: string) => void;
}

export interface BidiMarksPaletteCommand {
  id: string;
  label: string;
  hint?: string;
  group?: string;
  action: () => void | Promise<void>;
}

/** Run the fix on whatever editor is mounted; returns the counts. The fixer loads on first use. */
export async function runBidiFix(deps: BidiMarksCommandDeps): Promise<{ removed: number; swapped: number }> {
  return (await import("./bidiFix")).runBidiFix(deps);
}

export function buildBidiMarksCommands(deps: BidiMarksCommandDeps): BidiMarksPaletteCommand[] {
  const group = t("group.edit");
  const shown = bidiMarksShown();
  return [
    {
      id: "view.bidiMarks",
      label: shown ? t("cmd.view.bidiMarks.off") : t("cmd.view.bidiMarks.on"),
      hint: t("cmd.view.bidiMarks.hint"),
      group: t("group.view"),
      action: () => {
        toggleBidiMarks();
      },
    },
    {
      id: "edit.bidiFix",
      label: t("cmd.edit.bidiFix"),
      hint: t("cmd.edit.bidiFix.hint"),
      group,
      action: async () => {
        await runBidiFix(deps);
      },
    },
  ];
}
