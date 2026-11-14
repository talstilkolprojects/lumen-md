/**
 * Inline bidi isolates in the source editor (plan W11.H2): every island
 * lib/inlineIsolates finds — inline code, URLs, link destinations, footnote
 * references (left to right), wiki links and tags (their own direction) —
 * becomes a mark that renders as an isolate (`bidiIsolate`) and is handed
 * to CodeMirror through `EditorView.bidiIsolatedRanges`, so cursor motion,
 * Home/End and selection follow what is drawn. Lines inside fenced code are
 * skipped (they are left-to-right as a whole, src/editor/bidi.ts).
 *
 * Next to it the editor also enables `bidiIsolates()` from
 * @codemirror/language, which isolates the syntax nodes a language marks
 * with the `isolate` node prop (Editor.tsx).
 */
import { Decoration, Direction, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import { inlineIsolates } from "../lib/inlineIsolates";

const MARKS = {
  ltr: Decoration.mark({ class: "cm-bidi-isolate", attributes: { dir: "ltr" }, bidiIsolate: Direction.LTR }),
  // bidiIsolate null: an isolate whose direction the browser takes from its first strong character.
  auto: Decoration.mark({ class: "cm-bidi-isolate", attributes: { dir: "auto" }, bidiIsolate: null }),
};

/** The isolate decorations of the visible lines. */
export function isolateDecorations(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  let fence: string | null = null;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line.text);
      if (fence) {
        if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
      } else if (open) fence = open[1];
      else for (const iso of inlineIsolates(line.text)) out.push(MARKS[iso.dir].range(line.from + iso.from, line.from + iso.to));
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  }
  return Decoration.set(out, true);
}

export const inlineIsolatesPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = isolateDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = isolateDecorations(u.view);
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (plugin) => EditorView.bidiIsolatedRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
);
