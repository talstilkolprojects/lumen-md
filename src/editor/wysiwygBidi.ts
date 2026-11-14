/**
 * Per-block direction in the WYSIWYG editor (T25, plan 9.7): a node
 * decoration puts `dir` on every block, so each one reads in the direction
 * of its own text — the same rule as the source editor
 * (lib/bidiDirection): the first strong character, with inline code left
 * out ("`iPhone` שלום" is a Hebrew paragraph). A block without a strong
 * character (a time, a number) takes the document's direction. Container
 * blocks (lists, quotes, list items) get the direction of their own text,
 * because `auto` skips children that carry a `dir` of their own. Code
 * blocks stay `dir="ltr"`, and so does every inline formula, which the
 * direction rule leaves out like inline code (W5.14).
 *
 * Arrow keys move in logical order inside a block (plan 9.7): the key that
 * points toward the end of the block — Left in a right-to-left block,
 * Right in a left-to-right one — goes to the next character in the text,
 * through runs of the other direction, numbers and brackets; Shift extends
 * the selection. Crossing into the next block, vertical arrows and word
 * moves stay with the browser.
 */

import { Plugin, PluginKey, TextSelection, type EditorState } from "@milkdown/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/prose/view";
import type { Node as PMNode } from "@milkdown/prose/model";
import { firstStrong, type LineDirection } from "../lib/bidiDirection";
import { LRM, RLM, type Dir } from "../lib/paragraphDirection";

export const wysiwygBidiKey = new PluginKey<DecorationSet>("lumen-bidi");

const CONTAINER = new Set(["list_item", "bullet_list", "ordered_list", "blockquote"]);
const CODE_MARKS = new Set(["inlineCode", "code_inline", "code"]);
/** An inline formula node (@milkdown/plugin-math's `math_inline`): an LTR isolate, left out of the direction rule (W5.14). */
export const isInlineMath = (node: PMNode) => node.isInline && !node.isText && /math/i.test(node.type.name);

/** A block's text as its reader sees it for direction: inline code left out. */
function directionText(node: PMNode): string {
  let out = "";
  node.descendants((child) => {
    if (child.type.name === "code_block" || child.type.name === "math_block" || isInlineMath(child)) return false;
    if (child.isText && !child.marks.some((m) => CODE_MARKS.has(m.type.name))) out += child.text;
    return true;
  });
  return out;
}

function documentDirection(state: EditorState): LineDirection {
  let found: LineDirection | null = null;
  state.doc.descendants((node) => {
    if (found) return false;
    if (node.type.name === "code_block" || node.type.name === "math_block") return false;
    if (node.isTextblock) {
      found = firstStrong(directionText(node));
      return false;
    }
    return true;
  });
  return found ?? "ltr";
}

/** A block switched with "Switch paragraph direction" (W11.H4): its text starts with RLM or LRM. */
export function blockSwitch(node: PMNode): LineDirection | null {
  const c = node.textContent[0];
  return c === RLM ? "rtl" : c === LRM ? "ltr" : null;
}

function decorate(state: EditorState, pinned: Dir | null = null): DecorationSet {
  const decos: Decoration[] = [];
  let base: LineDirection | null = null;
  // The block's own switch, else the note's frontmatter pin (rtl / ltr), else its first strong character.
  const pin = pinned === "rtl" || pinned === "ltr" ? pinned : null;
  const dirOf = (node: PMNode) => blockSwitch(node) ?? pin ?? firstStrong(directionText(node)) ?? (base ??= documentDirection(state));
  state.doc.descendants((node, pos) => {
    if (node.type.name === "code_block" || node.type.name === "math_block") {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { dir: "ltr" }));
      return false;
    }
    if (isInlineMath(node)) {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { dir: "ltr" }));
      return false;
    }
    if (CONTAINER.has(node.type.name) || node.isTextblock) {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { dir: dirOf(node) }));
    }
    return true;
  });
  return DecorationSet.create(state.doc, decos);
}

/** The direction the block around `pos` was given. */
function blockDirection(view: EditorView, pos: number): LineDirection {
  const $pos = view.state.doc.resolve(pos);
  const dom = view.nodeDOM($pos.before($pos.depth));
  const el = dom instanceof HTMLElement ? dom : null;
  const css = el ? getComputedStyle(el).direction : "";
  if (css === "rtl" || css === "ltr") return css;
  return firstStrong(directionText($pos.parent)) ?? "ltr";
}

let segmenter: Intl.Segmenter | null = null;

/** The next grapheme boundary in `text` from `offset`, or null at the edge. */
function clusterStep(text: string, offset: number, forward: boolean): number | null {
  if (forward ? offset >= text.length : offset <= 0) return null;
  segmenter ??= typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  if (!segmenter) return forward ? offset + 1 : offset - 1;
  let prev = 0;
  for (const { index } of segmenter.segment(text)) {
    if (forward && index > offset) return index;
    if (!forward && index >= offset) return prev;
    prev = index;
  }
  return forward ? text.length : prev;
}

/** Left / Right inside a textblock, in logical order. False lets the browser handle it. */
export function logicalArrow(view: EditorView, towardRight: boolean, extend: boolean): boolean {
  const { state } = view;
  const sel = state.selection;
  if (!(sel instanceof TextSelection)) return false;
  const $head = sel.$head;
  if (!$head.parent.isTextblock || $head.parent.type.spec.code) return false;
  const forward = towardRight !== (blockDirection(view, $head.pos) === "rtl");
  if (!extend && !sel.empty) {
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, forward ? sel.to : sel.from)).scrollIntoView());
    return true;
  }
  // Offsets in the block's text match positions: every leaf counts as one character.
  const text = $head.parent.textBetween(0, $head.parent.content.size, undefined, "￼");
  const next = clusterStep(text, $head.parentOffset, forward);
  if (next === null) return false; // the block's edge: the browser moves into the next block
  const pos = $head.start() + next;
  const tr = state.tr.setSelection(extend ? TextSelection.create(state.doc, sel.anchor, pos) : TextSelection.create(state.doc, pos));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * "Switch paragraph direction" (W11.H4) on the textblock around the
 * selection: remove its mark, or write the one for the other direction at
 * the block's start. The Markdown serializer keeps the character, so the
 * source editor and the next opening read the same direction.
 */
export function toggleBlockDirection(view: EditorView, pinned: Dir | null = null): boolean {
  const { state } = view;
  const $from = state.selection.$from;
  const block = $from.parent;
  if (!block.isTextblock || block.type.spec.code) return false;
  const start = $from.start();
  const pin = pinned === "rtl" || pinned === "ltr" ? pinned : null;
  const now = blockSwitch(block) ?? pin ?? firstStrong(directionText(block)) ?? documentDirection(state);
  const target: LineDirection = now === "rtl" ? "ltr" : "rtl";
  let tr = state.tr;
  if (blockSwitch(block)) tr = tr.delete(start, start + 1);
  const after = tr.doc.resolve(tr.mapping.map(start)).parent;
  const natural = pin ?? firstStrong(directionText(after)) ?? documentDirection(state.apply(tr));
  if (natural !== target) tr = tr.insertText(target === "rtl" ? RLM : LRM, tr.mapping.map(start));
  if (!tr.docChanged) return false;
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** `pinned`: the note's frontmatter `dir` (the WYSIWYG surface does not see the frontmatter itself). */
export function wysiwygBidiPlugin(opts: { pinned?: () => Dir | null } = {}): Plugin<DecorationSet> {
  const pinned = () => opts.pinned?.() ?? null;
  return new Plugin<DecorationSet>({
    key: wysiwygBidiKey,
    state: {
      init: (_, state) => decorate(state, pinned()),
      apply: (tr, old, _oldState, newState) => (tr.docChanged || tr.getMeta(wysiwygBidiKey) ? decorate(newState, pinned()) : old),
    },
    view(view) {
      // The palette / Edit-menu command reaches this editor through a window event (the source editor is called directly).
      const onToggle = () => {
        if (view.hasFocus() || document.activeElement === document.body) toggleBlockDirection(view, pinned());
      };
      window.addEventListener("lumen-toggle-direction", onToggle);
      return { destroy: () => window.removeEventListener("lumen-toggle-direction", onToggle) };
    },
    props: {
      decorations: (state) => wysiwygBidiKey.getState(state) ?? null,
      handleKeyDown(view, event) {
        // Mod+Shift+X: switch the paragraph's direction (W11.H4).
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && (event.code === "KeyX" || event.key.toLowerCase() === "x")) {
          return toggleBlockDirection(view, pinned());
        }
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return false;
        if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
        return logicalArrow(view, event.key === "ArrowRight", event.shiftKey);
      },
    },
  });
}
