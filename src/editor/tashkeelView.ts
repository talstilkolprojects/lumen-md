/**
 * Tashkeel in the editor (plan W5.17), like niqqud for Hebrew: hide it from
 * view without touching the text, or remove it from the selection or the
 * note (one undoable change).
 *
 * Hiding replaces each run of marks with nothing in the visible ranges; the
 * document, copy and save keep every mark. The extension is added to an
 * editor the first time the user hides tashkeel there.
 */
import "../ai/arabicStrings";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import { TASHKEEL_CHARS, hasTashkeel, removeTashkeel } from "../text/arabic";

const setHidden = StateEffect.define<boolean>();

const hiddenField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHidden)) value = e.value;
    return value;
  },
});

const RUN = new RegExp(`[${TASHKEEL_CHARS}]+`, "g");
const hide = Decoration.replace({});

/** The marks in the visible ranges, as replace decorations (none when shown). */
export function tashkeelDecorations(view: EditorView): DecorationSet {
  if (!view.state.field(hiddenField, false)) return Decoration.none;
  const b = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (const m of view.state.sliceDoc(from, to).matchAll(RUN)) b.add(from + m.index!, from + m.index! + m[0].length, hide);
  }
  return b.finish();
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = tashkeelDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.startState.field(hiddenField, false) !== u.state.field(hiddenField, false)) this.decorations = tashkeelDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

/** Hide or show tashkeel in this editor; returns whether it is now hidden. */
export function toggleTashkeel(view: EditorView): boolean {
  const current = view.state.field(hiddenField, false);
  if (current === undefined) {
    view.dispatch({ effects: StateEffect.appendConfig.of([hiddenField.init(() => true), plugin]) });
    return true;
  }
  view.dispatch({ effects: setHidden.of(!current) });
  return !current;
}

/** Remove tashkeel from the selection, or the whole note when nothing is selected. Returns whether anything changed. */
export function removeTashkeelIn(view: EditorView): boolean {
  const sel = view.state.selection.main;
  const from = sel.empty ? 0 : sel.from;
  const to = sel.empty ? view.state.doc.length : sel.to;
  const text = view.state.sliceDoc(from, to);
  if (!hasTashkeel(text)) return false;
  const out = removeTashkeel(text);
  view.dispatch({ changes: { from, to, insert: out }, selection: sel.empty ? undefined : { anchor: from, head: from + out.length } });
  return true;
}
