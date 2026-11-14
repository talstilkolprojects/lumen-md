/**
 * The editor side of related notes (plan W2.2). Nothing runs on a
 * keystroke but resetting a timer: `delay` ms after typing (or moving the
 * cursor) stops, the paragraph at the cursor goes to the host (the
 * related panel), and the host's link hints come back as a dotted
 * underline on each mention. The text is never changed by this plugin; a
 * hint becomes a link only when the user accepts it (`acceptHint`), as one
 * undoable edit.
 *
 * Attached to the live editor by the panel (StateEffect.appendConfig), so
 * it is not part of the editor's startup bundle.
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { linkText, paragraphAt, type LinkHint, type Paragraph } from "./related";

export interface RelatedHost {
  /** Called after a pause with the paragraph at the cursor; returns the link hints for it. */
  pause(view: EditorView, paragraph: Paragraph, cursor: number): LinkHint[];
  /** The tooltip of a hint (localised). */
  label(hint: LinkHint): string;
}

const setHints = StateEffect.define<LinkHint[]>();

interface HintsState {
  hints: LinkHint[];
  deco: DecorationSet;
}

function build(hints: LinkHint[], label: (h: LinkHint) => string): DecorationSet {
  return Decoration.set(
    hints.filter((h) => h.to > h.from).map((h) => Decoration.mark({ class: "cm-related-hint", attributes: { title: label(h), "data-related-path": h.path } }).range(h.from, h.to)),
    true,
  );
}

let labelOf: (h: LinkHint) => string = (h) => h.name;

export const relatedHintsField = StateField.define<HintsState>({
  create: () => ({ hints: [], deco: Decoration.none }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHints)) return { hints: e.value, deco: build(e.value, labelOf) };
    if (!tr.docChanged) return value;
    // Typing moves the hints with the text; one the edit touched is dropped until the next pause.
    const hints: LinkHint[] = [];
    for (const h of value.hints) {
      const from = tr.changes.mapPos(h.from, 1);
      const to = tr.changes.mapPos(h.to, -1);
      let touched = false;
      tr.changes.iterChangedRanges((a, b) => {
        if (a < h.to && b > h.from) touched = true;
      });
      if (!touched && to - from === h.to - h.from) hints.push({ ...h, from, to });
    }
    return { hints, deco: value.deco.map(tr.changes).update({ filter: (f, t) => hints.some((h) => h.from === f && h.to === t) }) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

const theme = EditorView.baseTheme({
  ".cm-related-hint": { textDecoration: "underline dotted hsl(var(--accent, 220 90% 56%))", textUnderlineOffset: "3px" },
});

/** The plugin: debounce, then ask the host. */
export function relatedExtension(host: RelatedHost, delay = 100): Extension {
  labelOf = host.label;
  const plugin = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | undefined;
      constructor(readonly view: EditorView) {
        this.schedule();
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet) this.schedule();
      }
      schedule() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.run(), delay);
      }
      run() {
        const doc = this.view.state.doc.toString();
        const cursor = this.view.state.selection.main.head;
        let hints: LinkHint[] = [];
        try {
          hints = host.pause(this.view, paragraphAt(doc, cursor), cursor);
        } catch {
          hints = [];
        }
        const now = this.view.state.field(relatedHintsField, false)?.hints ?? [];
        if (JSON.stringify(now) !== JSON.stringify(hints)) this.view.dispatch({ effects: setHints.of(hints) });
      }
      destroy() {
        clearTimeout(this.timer);
      }
    },
  );
  return [relatedHintsField, plugin, theme];
}

/** The hints shown now. */
export function currentHints(view: EditorView): LinkHint[] {
  return view.state.field(relatedHintsField, false)?.hints ?? [];
}

/** Turn a hint into a link: one undoable edit, only if the text is still the mention. */
export function acceptHint(view: EditorView, hint: LinkHint): boolean {
  const written = view.state.sliceDoc(hint.from, hint.to);
  if (written.toLowerCase() !== hint.name.toLowerCase()) return false;
  const insert = linkText(hint, written);
  view.dispatch({ changes: { from: hint.from, to: hint.to, insert }, userEvent: "input.link", effects: setHints.of(currentHints(view).filter((h) => h !== hint)) });
  return true;
}

export function hasRelatedExtension(view: EditorView): boolean {
  return view.state.field(relatedHintsField, false) !== undefined;
}
