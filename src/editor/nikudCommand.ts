/**
 * The niqqud editor actions (plan 6.3.3): on the selection, or on the whole
 * note when nothing is selected. Adding needs the model (consent first);
 * removing does not. The text is replaced only if it did not change while
 * the model was working.
 */
import type { EditorView } from "@codemirror/view";

export type NikudMode = "add" | "partial" | "remove";

export interface NikudCommandDeps {
  point: (text: string, partial: boolean) => Promise<string>;
  unpoint: (text: string) => string;
}

/** Returns whether the text was changed. */
export async function runNikudCommand(view: EditorView, mode: NikudMode, deps: NikudCommandDeps): Promise<boolean> {
  const sel = view.state.selection.main;
  const from = sel.empty ? 0 : sel.from;
  const to = sel.empty ? view.state.doc.length : sel.to;
  const text = view.state.sliceDoc(from, to);
  if (!/[א-ת]/.test(text)) return false;
  const out = mode === "remove" ? deps.unpoint(text) : await deps.point(text, mode === "partial");
  if (out === text || view.state.sliceDoc(from, to) !== text) return false;
  view.dispatch({ changes: { from, to, insert: out }, selection: sel.empty ? undefined : { anchor: from, head: from + out.length } });
  return true;
}
