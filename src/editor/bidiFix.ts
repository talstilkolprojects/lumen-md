/**
 * The "Clean direction marks and fix brackets" run (plan W5.4): one undoable
 * change in whichever editor is open; in the preview the note text is
 * rewritten and the toast offers Undo. Loaded when the command runs, so the
 * fixer and the Unicode tables stay out of the startup bundle.
 */
import { t } from "../i18n";
import { fixBidi, applyEdits } from "../lib/bidiMarks";
import { firstStrong } from "../lib/bidiDirection";
import { useToastStore } from "../store/useToastStore";
import { proseBidiFixer } from "./bidiMarksSetting";
import type { BidiMarksCommandDeps } from "./bidiMarksCommands";

/** The note's direction for lines with no strong character: its first line that has one. */
function noteDir(text: string): "ltr" | "rtl" {
  for (const line of text.split("\n")) {
    const d = firstStrong(line);
    if (d) return d;
  }
  return "ltr";
}

function report(removed: number, swapped: number, undo?: () => void): void {
  const push = useToastStore.getState().push;
  if (!removed && !swapped) {
    push({ kind: "info", title: t("bidi.fix.none") });
    return;
  }
  push({
    kind: "success",
    title: t("bidi.fix.done"),
    body: t("bidi.fix.counts", { removed, swapped }),
    ...(undo ? { action: { label: t("bidi.fix.undo"), run: undo }, ttlMs: 8000 } : {}),
  });
}

/** Run the fix on whatever editor is mounted; returns the counts. */
export async function runBidiFix(deps: BidiMarksCommandDeps): Promise<{ removed: number; swapped: number }> {
  const view = deps.getView();
  if (view) {
    const text = view.state.doc.toString();
    const { edits, removed, swapped } = fixBidi(text, { noteDir: noteDir(text) });
    if (edits.length) view.dispatch({ changes: edits, userEvent: "input.bidifix", scrollIntoView: false });
    report(removed, swapped);
    view.focus();
    return { removed, swapped };
  }
  const prose = proseBidiFixer();
  if (prose) {
    const r = prose();
    report(r.removed, r.swapped);
    return r;
  }
  const before = deps.getContent();
  const { edits, removed, swapped } = fixBidi(before, { noteDir: noteDir(before) });
  if (edits.length) deps.setContent(applyEdits(before, edits));
  report(removed, swapped, edits.length ? () => deps.setContent(before) : undefined);
  return { removed, swapped };
}
