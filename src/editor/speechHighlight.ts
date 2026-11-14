/**
 * The sentence being read aloud (T32), highlighted as a decoration — never
 * as the editor selection, so typing during playback can't replace it.
 */
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { StateEffect, StateField, type Extension } from "@codemirror/state";

export const setSpokenRange = StateEffect.define<{ from: number; to: number } | null>();

const spokenMark = Decoration.mark({ class: "cm-spoken-sentence" });

export const spokenRangeField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setSpokenRange)) continue;
      const len = tr.state.doc.length;
      const from = e.value ? Math.max(0, Math.min(e.value.from, len)) : 0;
      const to = e.value ? Math.max(from, Math.min(e.value.to, len)) : 0;
      next = e.value && to > from ? Decoration.set([spokenMark.range(from, to)]) : Decoration.none;
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function speechHighlightExtension(): Extension {
  return [
    spokenRangeField,
    EditorView.baseTheme({
      ".cm-spoken-sentence": { backgroundColor: "rgba(250, 204, 21, 0.35)", borderRadius: "2px" },
      "&dark .cm-spoken-sentence": { backgroundColor: "rgba(250, 204, 21, 0.25)" },
    }),
  ];
}

/** Highlight (or, with null, clear) the spoken range and scroll it into view. */
export function showSpokenRange(view: EditorView, range: { from: number; to: number } | null): void {
  const effects: StateEffect<unknown>[] = [setSpokenRange.of(range)];
  if (range) effects.push(EditorView.scrollIntoView(Math.max(0, Math.min(range.from, view.state.doc.length)), { y: "center" }));
  view.dispatch({ effects });
}
