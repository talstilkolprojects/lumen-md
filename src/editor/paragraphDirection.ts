/**
 * "Switch paragraph direction" in the source editor (plan W11.H4): every
 * line the selection touches is switched to the other direction from the
 * one it is shown in, by its invisible mark (lib/paragraphDirection), in one
 * undoable change. Mod+Shift+X, the Edit menu, the command palette.
 * Lines inside fenced code and the frontmatter are left alone (always LTR).
 */
import { EditorSelection, type ChangeSpec, type EditorState } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import { firstStrong, markdownLineDirection, type LineDirection } from "../lib/bidiDirection";
import { frontmatterDir, frontmatterEnd, toggledLine } from "../lib/paragraphDirection";

/** Lines (1-based) inside fenced code blocks, fences included. */
function fencedLines(state: EditorState): Set<number> {
  const out = new Set<number>();
  let fence: string | null = null;
  for (let n = 1; n <= state.doc.lines; n++) {
    const text = state.doc.line(n).text;
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
    if (fence) {
      out.add(n);
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
    } else if (open) {
      fence = open[1];
      out.add(n);
    }
  }
  return out;
}

/** The note's direction for neutral lines: its first line with a strong character (as editor/bidi). */
function noteFallback(state: EditorState, fm: number): LineDirection {
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (line.from < fm) continue;
    const d = markdownLineDirection(line.text) ?? firstStrong(line.text);
    if (d) return d;
  }
  return "ltr";
}

/** The change that switches the selected lines (null when none can be switched). */
export function toggleDirectionChanges(state: EditorState): ChangeSpec[] | null {
  const head = state.sliceDoc(0, Math.min(state.doc.length, 2000));
  const pinned = frontmatterDir(head);
  const fm = frontmatterEnd(head);
  const code = fencedLines(state);
  const fallback = noteFallback(state, Math.max(fm, 0));
  const seen = new Set<number>();
  const changes: ChangeSpec[] = [];
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      if (seen.has(n) || code.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      if (fm > 0 && line.from < fm) continue;
      const next = toggledLine(line.text, { pinned, fallback });
      if (next === line.text) continue;
      // The smallest change (one mark in or out), so carets and marks around it map cleanly.
      let a = 0;
      while (a < next.length && a < line.text.length && next[a] === line.text[a]) a++;
      let b = 0;
      while (b < next.length - a && b < line.text.length - a && next[next.length - 1 - b] === line.text[line.text.length - 1 - b]) b++;
      changes.push({ from: line.from + a, to: line.to - b, insert: next.slice(a, next.length - b) });
    }
  }
  return changes.length ? changes : null;
}

export function toggleParagraphDirection(view: EditorView): boolean {
  const changes = toggleDirectionChanges(view.state);
  if (!changes) return false;
  const cs = view.state.changes(changes);
  // A caret at the text's start stays after the inserted mark, on the text it was on.
  const selection = EditorSelection.create(view.state.selection.ranges.map((r) => r.map(cs, 1)), view.state.selection.mainIndex);
  view.dispatch({ changes: cs, selection, userEvent: "input.direction" });
  return true;
}

export const paragraphDirectionKeymap = keymap.of([{ key: "Mod-Shift-x", run: toggleParagraphDirection }]);
