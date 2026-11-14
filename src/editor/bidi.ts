/**
 * Per-line text direction for the source editor (MASTER_PLAN v3, T25).
 *
 * A note mixing Hebrew and English must read correctly line by line: a
 * Hebrew paragraph aligned to the right, an English one to the left, code
 * always left-to-right. The browser already knows how to do that for an
 * element with `dir="auto"` (first strong character, UAX #9), and
 * CodeMirror can follow it per line when `perLineTextDirection` is on and
 * every line element carries that attribute — it reads the line's
 * computed `direction` for cursor movement and selection drawing.
 *
 * So the extension is small and deterministic: a line decoration with
 * `dir` on every line in the viewport. Lines inside fenced code (and the
 * frontmatter) get `dir="ltr"`; a frontmatter `dir: rtl` / `dir: ltr` pins
 * the rest. Otherwise (plan 9.7) each line gets the direction of its first
 * strong character AFTER its Markdown markers, ignoring link URLs and code
 * spans (lib/bidiDirection, the golden set's rule) — `dir="auto"` would
 * let "> `iPhone` שלום" run left-to-right. A line with no strong character
 * (a time, a number) takes the note's direction.
 *
 * Arrow keys move in logical order (plan 9.7): the key that points toward
 * the end of the line — Left in a right-to-left line, Right in a
 * left-to-right one — goes to the next character in the text, through
 * embedded runs of the other direction, numbers and brackets, instead of
 * jumping around them visually. Shift extends the selection the same way,
 * and Ctrl (Alt on macOS) moves by word.
 */

import { Decoration, Direction, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { CharCategory, EditorSelection, Prec, findClusterBreak, type EditorState, type SelectionRange } from "@codemirror/state";
import { markdownLineDirection } from "../lib/bidiDirection";

export { firstStrongDirection } from "../lib/textDirection";

export type Dir = "auto" | "ltr" | "rtl";

/** End offset of a leading YAML frontmatter block (just past its closing fence), or -1. */
export function frontmatterEnd(doc: string): number {
  if (!doc.startsWith("---")) return -1;
  const end = doc.indexOf("\n---", 3);
  return end < 0 ? -1 : end + 4;
}

/** `dir: rtl|ltr|auto` from a note's YAML frontmatter, else null. */
export function frontmatterDir(doc: string): Dir | null {
  const end = frontmatterEnd(doc);
  if (end < 0) return null;
  const m = /^dir:\s*["']?(auto|ltr|rtl)["']?\s*$/m.exec(doc.slice(3, end - 4));
  return m ? (m[1] as Dir) : null;
}

const ATTR = {
  auto: Decoration.line({ attributes: { dir: "auto" } }),
  ltr: Decoration.line({ attributes: { dir: "ltr" } }),
  rtl: Decoration.line({ attributes: { dir: "rtl" } }),
};

/** Positions of fenced code blocks and the frontmatter: always LTR. */
function ltrRanges(state: EditorState, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (n) => {
      if (n.name === "FencedCode" || n.name === "CodeBlock" || n.name === "Frontmatter" || n.name === "HTMLBlock") {
        out.push([n.from, n.to]);
        return false;
      }
      return undefined;
    },
  });
  return out;
}

/**
 * The note's own direction, for lines without a strong character: the
 * first line outside fenced code and the frontmatter that has one, over
 * the whole note (fences are tracked textually: the syntax tree of a long
 * note may not be parsed that far yet). LTR otherwise. Cached per document.
 */
const noteDirCache = new WeakMap<object, "ltr" | "rtl">();
export function noteDirection(state: EditorState, fm: number): "ltr" | "rtl" {
  const doc = state.doc;
  const cached = noteDirCache.get(doc);
  if (cached) return cached;
  let fence: string | null = null;
  let found: "ltr" | "rtl" = "ltr";
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (line.from < fm) continue;
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line.text);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !line.text.trim().slice(open[1].length).length) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      continue;
    }
    const d = markdownLineDirection(line.text);
    if (d) {
      found = d;
      break;
    }
  }
  noteDirCache.set(doc, found);
  return found;
}

function build(view: EditorView): DecorationSet {
  const head = view.state.sliceDoc(0, Math.min(view.state.doc.length, 2000));
  const pinned = frontmatterDir(head);
  // The editor's markdown parser has no frontmatter node (the block parses
  // as a rule and a heading), so the YAML block is found textually.
  const fm = frontmatterEnd(head);
  let base: "ltr" | "rtl" | null = null;
  const ranges: ReturnType<typeof ATTR.auto.range>[] = [];
  for (const { from, to } of view.visibleRanges) {
    // Code and the frontmatter are LTR even when the note pins a
    // direction: a `dir: rtl` author still reads code left-to-right.
    const ltr = ltrRanges(view.state, from, to);
    if (fm > 0) ltr.push([0, fm]);
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const inCode = ltr.some(([a, b]) => line.from >= a && line.from < b);
      let dir: Dir;
      if (inCode) dir = "ltr";
      else if (pinned && pinned !== "auto") dir = pinned;
      else dir = markdownLineDirection(line.text) ?? (base ??= noteDirection(view.state, fm));
      ranges.push(ATTR[dir].range(line.from));
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

// ── Logical arrow keys (plan 9.7) ───────────────────────────────────────

/** One grapheme cluster forward or back in the text, across line breaks. */
function charLogical(state: EditorState, pos: number, forward: boolean): number {
  const line = state.doc.lineAt(pos);
  if (forward ? pos === line.to : pos === line.from) return forward ? Math.min(state.doc.length, pos + 1) : Math.max(0, pos - 1);
  return line.from + findClusterBreak(line.text, pos - line.from, forward);
}

/** One word forward or back in the text: skip spaces, then a run of one character category. */
function groupLogical(state: EditorState, pos: number, forward: boolean): number {
  const line = state.doc.lineAt(pos);
  if (forward ? pos === line.to : pos === line.from) return charLogical(state, pos, forward);
  const cat = state.charCategorizer(pos);
  const text = line.text;
  let at = pos - line.from;
  const next = () => (forward ? findClusterBreak(text, at, true) : findClusterBreak(text, at, false));
  const charAt = (i: number, j: number) => text.slice(Math.min(i, j), Math.max(i, j));
  // Spaces first.
  while (forward ? at < text.length : at > 0) {
    const n = next();
    if (cat(charAt(at, n)) !== CharCategory.Space) break;
    at = n;
  }
  let group: CharCategory | null = null;
  while (forward ? at < text.length : at > 0) {
    const n = next();
    const c = cat(charAt(at, n));
    if (c === CharCategory.Space || (group !== null && c !== group)) break;
    group = c;
    at = n;
  }
  return line.from + at;
}

type Step = (state: EditorState, pos: number, forward: boolean) => number;

/**
 * The command for a horizontal arrow: `towardRight` is the key's side.
 * Toward the end of the line is Left in an RTL line, Right in an LTR one.
 */
function arrow(towardRight: boolean, step: Step, extend: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const move = (r: SelectionRange): SelectionRange => {
      const rtl = view.textDirectionAt(r.head) === Direction.RTL;
      const forward = towardRight !== rtl;
      if (extend) return EditorSelection.range(r.anchor, step(state, r.head, forward));
      // A selection collapses to its start or end, the way the plain arrow keys do.
      if (!r.empty) return EditorSelection.cursor(forward ? r.to : r.from);
      return EditorSelection.cursor(step(state, r.head, forward));
    };
    view.dispatch(state.update({ selection: EditorSelection.create(state.selection.ranges.map(move), state.selection.mainIndex), scrollIntoView: true, userEvent: "select" }));
    return true;
  };
}

const logicalArrows = Prec.high(
  keymap.of([
    { key: "ArrowLeft", run: arrow(false, charLogical, false), shift: arrow(false, charLogical, true), preventDefault: true },
    { key: "ArrowRight", run: arrow(true, charLogical, false), shift: arrow(true, charLogical, true), preventDefault: true },
    { key: "Mod-ArrowLeft", mac: "Alt-ArrowLeft", run: arrow(false, groupLogical, false), shift: arrow(false, groupLogical, true), preventDefault: true },
    { key: "Mod-ArrowRight", mac: "Alt-ArrowRight", run: arrow(true, groupLogical, false), shift: arrow(true, groupLogical, true), preventDefault: true },
  ]),
);

/**
 * The extension: per-line direction from each line's own text, logical
 * arrow keys. Code and frontmatter stay LTR; a frontmatter `dir:` key pins
 * the whole note.
 */
export function bidiExtension() {
  return [
    EditorView.perLineTextDirection.of(true),
    logicalArrows,
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = build(view);
        }
        update(u: ViewUpdate) {
          if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view);
        }
      },
      { decorations: (v) => v.decorations },
    ),
  ];
}
