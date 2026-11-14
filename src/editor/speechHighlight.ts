/**
 * The sentence being read aloud (T32), highlighted as a decoration — never
 * as the editor selection, so typing during playback can't replace it —
 * and inside it the word the voice is saying (plan W5.6), when the speech
 * engine reports word boundaries.
 */
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { StateEffect, StateField, type Extension } from "@codemirror/state";

export const setSpokenRange = StateEffect.define<{ from: number; to: number } | null>();
export const setSpokenWord = StateEffect.define<{ from: number; to: number } | null>();

const spokenMark = Decoration.mark({ class: "cm-spoken-sentence" });
const spokenWordMark = Decoration.mark({ class: "cm-spoken-word" });

function clampRange(len: number, r: { from: number; to: number } | null): { from: number; to: number } | null {
  if (!r) return null;
  const from = Math.max(0, Math.min(r.from, len));
  const to = Math.max(from, Math.min(r.to, len));
  return to > from ? { from, to } : null;
}

/** The spoken word: cleared with the sentence (a new sentence, or the end of the reading). */
export const spokenWordField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setSpokenRange)) next = Decoration.none;
      if (!e.is(setSpokenWord)) continue;
      const r = clampRange(tr.state.doc.length, e.value);
      next = r ? Decoration.set([spokenWordMark.range(r.from, r.to)]) : Decoration.none;
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

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
    spokenWordField,
    EditorView.baseTheme({
      ".cm-spoken-sentence": { backgroundColor: "rgba(250, 204, 21, 0.35)", borderRadius: "2px" },
      "&dark .cm-spoken-sentence": { backgroundColor: "rgba(250, 204, 21, 0.25)" },
      // why: an underline as well as a colour, so the word stands out without relying on colour alone (WCAG 1.4.1)
      ".cm-spoken-word": { backgroundColor: "rgba(250, 204, 21, 0.75)", textDecoration: "underline 2px", textUnderlineOffset: "3px", borderRadius: "2px" },
      "&dark .cm-spoken-word": { backgroundColor: "rgba(250, 204, 21, 0.5)" },
    }),
  ];
}

/** Highlight (or, with null, clear) the spoken range and scroll it into view. */
export function showSpokenRange(view: EditorView, range: { from: number; to: number } | null): void {
  const effects: StateEffect<unknown>[] = [setSpokenRange.of(range)];
  if (range) effects.push(EditorView.scrollIntoView(Math.max(0, Math.min(range.from, view.state.doc.length)), { y: "center" }));
  view.dispatch({ effects });
}

/** Mark (or, with null, clear) the word being spoken. The sentence highlight already scrolled it into view. */
export function showSpokenWord(view: EditorView, range: { from: number; to: number } | null): void {
  view.dispatch({ effects: setSpokenWord.of(range) });
}
