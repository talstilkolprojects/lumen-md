/**
 * Math inside Hebrew lines in the source editor (plan W5.14).
 *
 *  - Every inline formula (`$…$`, `$$…$$` on one line) is a left-to-right
 *    bidi isolate: a mark with `dir="ltr"` that CodeMirror also knows as an
 *    isolate (`bidiIsolatedRanges`), so "$1+2=3$" inside Hebrew keeps its
 *    order on screen and the cursor moves through it the way it is drawn.
 *  - Ctrl/⌘+M wraps the selection in `$…$` (or inserts `$$` with the cursor
 *    inside). CodeMirror reads the physical key, so it works with the
 *    Hebrew layout on.
 *  - Inside a formula, keys typed with the Hebrew layout insert the Latin
 *    character of the same physical key: "ס" on the X key types "x", "ש"
 *    types "a", "/" on the Q key types "q". No layout switch to write
 *    $x^2+y^2$ in the middle of a Hebrew sentence. The table is the Israeli
 *    standard layout (SI 1452), as in W2.8's lib/keyboardLayout.
 */

import { Decoration, Direction, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { EditorSelection, Prec, type Range } from "@codemirror/state";
import { inlineMathSpans } from "../lib/mathIsolate";
import { latinForHebrewKey } from "../lib/mathKeys";

const MARK = Decoration.mark({ class: "cm-math-inline", attributes: { dir: "ltr" }, bidiIsolate: Direction.LTR });

function build(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  let fence: string | null = null;
  // Fences are tracked from the top of the viewport; a fence opened above it is rare
  // enough that math decorations inside such a block are harmless.
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line.text);
      if (fence) {
        if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
      } else if (open) fence = open[1];
      else if (line.text.includes("$")) for (const [a, b] of inlineMathSpans(line.text)) out.push(MARK.range(line.from + a, line.from + b));
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  }
  return Decoration.set(out, true);
}

const mathMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (plugin) => EditorView.bidiIsolatedRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
);

/** The inline formula around `pos` on its line, as document offsets of its content, or null. */
export function mathAt(view: EditorView, pos: number): { from: number; to: number } | null {
  const line = view.state.doc.lineAt(pos);
  for (const [a, b] of inlineMathSpans(line.text)) {
    const fence = line.text.startsWith("$$", a) ? 2 : 1;
    if (pos >= line.from + a + fence && pos <= line.from + b - fence) return { from: line.from + a + fence, to: line.from + b - fence };
  }
  return null;
}

/** Ctrl/⌘+M: wrap the selection in `$…$`, or insert `$$` with the cursor between. */
export function insertInlineMath(view: EditorView): boolean {
  view.dispatch(
    view.state.changeByRange((r) => {
      const inner = view.state.sliceDoc(r.from, r.to);
      const insert = `$${inner}$`;
      return { changes: { from: r.from, to: r.to, insert }, range: inner ? EditorSelection.range(r.from + 1, r.from + 1 + inner.length) : EditorSelection.cursor(r.from + 1) };
    }),
    { userEvent: "input", scrollIntoView: true },
  );
  return true;
}

const hebrewLayoutInMath = EditorView.domEventHandlers({
  keydown(event, view) {
    const ch = latinForHebrewKey(event);
    if (!ch) return false;
    const sel = view.state.selection.main;
    if (!mathAt(view, sel.from) || !mathAt(view, sel.to)) return false;
    event.preventDefault();
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: ch }, selection: { anchor: sel.from + ch.length }, userEvent: "input.type" });
    return true;
  },
});

const theme = EditorView.baseTheme({
  ".cm-math-inline": { unicodeBidi: "isolate", direction: "ltr" },
});

export function mathBidiExtension() {
  return [theme, mathMarks, hebrewLayoutInMath, Prec.high(keymap.of([{ key: "Mod-m", run: insertInlineMath, preventDefault: true }]))];
}
