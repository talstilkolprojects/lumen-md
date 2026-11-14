/**
 * The editing toolbar above the on-screen keyboard (plan W1.25): which
 * actions exist, the default row, and what each one does to the text.
 *
 * Every action is a pure function of (text, selection) so it is the same in
 * the source editor and in tests; the editor turns the result into one
 * CodeMirror transaction (one undo step). The row itself is the user's: any
 * subset of the actions, in any order (Settings → Mobile toolbar, or the
 * ⋯ button at the end of the row), stored as a list of ids.
 */

import type { ToolbarActionId } from "./toolbarRow";

// The ids, the default row and its clean-up live in ./toolbarRow (the store needs them at startup).
export { DEFAULT_TOOLBAR, sanitizeToolbar, TOOLBAR_ACTION_IDS, type ToolbarActionId } from "./toolbarRow";

export interface ToolbarAction {
  id: ToolbarActionId;
  /** What the button shows. Symbols, not words, so the row fits a phone. */
  glyph: string;
  /** i18n key of the accessible name (and the label in the customise sheet). */
  labelKey: string;
  /**
   * `text`: handled by `applyTextAction`. The others need the editor:
   * `history` (undo/redo), `image` (file picker → asset), `keyboard` (blur).
   */
  kind: "text" | "history" | "image" | "keyboard";
  /** Mirror the glyph in RTL (arrows that mean "towards the line start"). */
  mirror?: boolean;
}

export const TOOLBAR_ACTIONS: readonly ToolbarAction[] = [
  { id: "indent", glyph: "⇥", labelKey: "mobileBar.indent", kind: "text", mirror: true },
  { id: "outdent", glyph: "⇤", labelKey: "mobileBar.outdent", kind: "text", mirror: true },
  { id: "task", glyph: "☐", labelKey: "mobileBar.task", kind: "text" },
  { id: "link", glyph: "🔗", labelKey: "mobileBar.link", kind: "text" },
  { id: "image", glyph: "🖼", labelKey: "mobileBar.image", kind: "image" },
  { id: "heading", glyph: "H", labelKey: "mobileBar.heading", kind: "text" },
  { id: "bold", glyph: "B", labelKey: "mobileBar.bold", kind: "text" },
  { id: "italic", glyph: "I", labelKey: "mobileBar.italic", kind: "text" },
  { id: "bullet", glyph: "•", labelKey: "mobileBar.bullet", kind: "text" },
  { id: "numbered", glyph: "1.", labelKey: "mobileBar.numbered", kind: "text" },
  { id: "wikilink", glyph: "[[", labelKey: "mobileBar.wikilink", kind: "text" },
  { id: "tag", glyph: "#", labelKey: "mobileBar.tag", kind: "text" },
  { id: "code", glyph: "</>", labelKey: "mobileBar.code", kind: "text" },
  { id: "quote", glyph: "❝", labelKey: "mobileBar.quote", kind: "text" },
  { id: "undo", glyph: "↶", labelKey: "mobileBar.undo", kind: "history", mirror: true },
  { id: "redo", glyph: "↷", labelKey: "mobileBar.redo", kind: "history", mirror: true },
  { id: "hideKeyboard", glyph: "⌄", labelKey: "mobileBar.hideKeyboard", kind: "keyboard" },
];

const BY_ID = new Map(TOOLBAR_ACTIONS.map((a) => [a.id, a]));
export const actionById = (id: string): ToolbarAction | undefined => BY_ID.get(id as ToolbarActionId);

/** Move one action in the row (the customise sheet's ↑/↓ buttons). */
export function moveAction(row: readonly ToolbarActionId[], id: ToolbarActionId, delta: -1 | 1): ToolbarActionId[] {
  const i = row.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= row.length) return [...row];
  const next = [...row];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** Add an action to the row's end, or take it off. */
export function toggleAction(row: readonly ToolbarActionId[], id: ToolbarActionId): ToolbarActionId[] {
  if (row.includes(id)) {
    const next = row.filter((x) => x !== id);
    return next.length ? next : [...row];
  }
  return [...row, id];
}

export interface TextEdit {
  changes: Array<{ from: number; to: number; insert: string }>;
  /** The selection after the edit, in the new text's offsets. */
  anchor: number;
  head: number;
}

/** One indent step: what the editor's Tab key uses for lists (CommonMark nests at 2+ spaces under "- "). */
export const INDENT_UNIT = "  ";

interface Line {
  from: number;
  to: number;
  text: string;
}

function linesOf(text: string, from: number, to: number): Line[] {
  const start = text.lastIndexOf("\n", from - 1) + 1;
  const out: Line[] = [];
  let pos = start;
  for (;;) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    out.push({ from: pos, to: end, text: text.slice(pos, end) });
    // A multi-line selection ending at a line's very start leaves that line alone.
    if (end >= to || end >= text.length || (to === end + 1 && to > from)) break;
    pos = end + 1;
  }
  return out;
}

const LIST_RE = /^(\s*)([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)?/;

/**
 * Rewrite each selected line's prefix. `fn` gets the line's indent and its
 * current list/quote marker and returns the new prefix (indent + marker).
 * The selection follows the text it was on.
 */
function rewritePrefixes(text: string, from: number, to: number, fn: (indent: string, marker: string, line: Line) => string): TextEdit {
  const changes: TextEdit["changes"] = [];
  for (const line of linesOf(text, from, to)) {
    const m = LIST_RE.exec(line.text)!;
    const next = fn(m[1], m[2] ?? "", line);
    if (next !== m[0]) changes.push({ from: line.from, to: line.from + m[0].length, insert: next });
  }
  return { changes, anchor: mapPos(from, changes), head: mapPos(to, changes) };
}

/** Where `pos` lands after `changes` (ascending, original offsets). A position inside a replaced prefix moves to its end. */
export function mapPos(pos: number, changes: TextEdit["changes"]): number {
  let shift = 0;
  for (const c of changes) {
    if (c.to <= pos) {
      if (c.from <= pos) shift += c.insert.length - (c.to - c.from);
      continue;
    }
    if (c.from < pos) return c.from + c.insert.length + shift;
    break;
  }
  return pos + shift;
}

/** Wrap the selection in `open`/`close`, or insert the pair with the cursor inside; unwrap when already wrapped. */
function wrap(text: string, from: number, to: number, open: string, close: string): TextEdit {
  if (text.slice(from - open.length, from) === open && text.slice(to, to + close.length) === close) {
    return {
      changes: [
        { from: from - open.length, to: from, insert: "" },
        { from: to, to: to + close.length, insert: "" },
      ],
      anchor: from - open.length,
      head: to - open.length,
    };
  }
  return {
    changes: [
      { from, to: from, insert: open },
      { from: to, to, insert: close },
    ],
    anchor: from + open.length,
    head: to + open.length,
  };
}

/** What a `text` action does to `text` with the selection `from..to`. Null for actions that need the editor. */
export function applyTextAction(id: ToolbarActionId, text: string, from: number, to: number): TextEdit | null {
  if (from > to) [from, to] = [to, from];
  const sel = text.slice(from, to);
  switch (id) {
    case "indent":
      return rewritePrefixes(text, from, to, (indent, marker) => INDENT_UNIT + indent + marker);
    case "outdent":
      return rewritePrefixes(text, from, to, (indent, marker) => indent.replace(/^( {1,2}|\t)/, "") + marker);
    case "task":
      // none → "- [ ] ", "- " → "- [ ] ", "- [ ] " → "- [x] ", "- [x] " → plain text.
      return rewritePrefixes(text, from, to, (indent, marker) => {
        if (/^[-*+]\s+\[[xX]\]/.test(marker)) return indent;
        if (/^[-*+]\s+\[ \]/.test(marker)) return indent + marker.replace("[ ]", "[x]");
        return `${indent}- [ ] `;
      });
    case "bullet":
      return rewritePrefixes(text, from, to, (indent, marker) => (/^[-*+]\s+(?!\[)/.test(marker) ? indent : `${indent}- `));
    case "numbered": {
      let n = 0;
      return rewritePrefixes(text, from, to, (indent, marker) => (/^\d+[.)]/.test(marker) ? indent : `${indent}${++n}. `));
    }
    case "quote":
      return rewritePrefixes(text, from, to, (indent, marker) => (marker.startsWith(">") ? indent : `${indent}> ${marker}`));
    case "heading": {
      // Cycle the first line: none → # → ## → ### → none.
      const line = linesOf(text, from, from)[0];
      const m = /^(#{1,6})\s+/.exec(line.text);
      const level = m ? m[1].length : 0;
      const next = level >= 3 ? "" : `${"#".repeat(level + 1)} `;
      const old = m ? m[0] : "";
      const changes = [{ from: line.from, to: line.from + old.length, insert: next }];
      return { changes, anchor: mapPos(from, changes), head: mapPos(to, changes) };
    }
    case "bold":
      return wrap(text, from, to, "**", "**");
    case "italic":
      return wrap(text, from, to, "_", "_");
    case "code":
      return sel.includes("\n") ? wrap(text, from, to, "```\n", "\n```") : wrap(text, from, to, "`", "`");
    case "wikilink":
      return wrap(text, from, to, "[[", "]]");
    case "link": {
      // A selected URL becomes the target; other selected text the label.
      if (/^https?:\/\/\S+$/.test(sel)) {
        const insert = `[](${sel})`;
        return { changes: [{ from, to, insert }], anchor: from + 1, head: from + 1 };
      }
      const insert = `[${sel}]()`;
      const cursor = sel ? from + insert.length - 1 : from + 1;
      return { changes: [{ from, to, insert }], anchor: cursor, head: cursor };
    }
    case "tag": {
      const before = from > 0 ? text[from - 1] : "\n";
      const insert = `${/\s/.test(before) ? "" : " "}#${sel.replace(/\s+/g, "-")}`;
      return { changes: [{ from, to, insert }], anchor: from + insert.length, head: from + insert.length };
    }
    default:
      return null;
  }
}

/** Apply a `TextEdit` to a string (tests, and editors that are not CodeMirror). Changes are in original offsets. */
export function applyEdit(text: string, edit: TextEdit): string {
  // Ascending and stable, like a CodeMirror change set: two inserts at one position keep their order.
  let out = "";
  let pos = 0;
  for (const c of [...edit.changes].sort((a, b) => a.from - b.from)) {
    out += text.slice(pos, c.from) + c.insert;
    pos = c.to;
  }
  return out + text.slice(pos);
}
