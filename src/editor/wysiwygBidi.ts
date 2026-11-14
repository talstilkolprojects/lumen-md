/**
 * Per-block direction in the WYSIWYG editor (T25, plan 9.7): a node
 * decoration puts `dir` on every block, so each one reads in the direction
 * of its own text — the same rule as the source editor
 * (lib/bidiDirection): the first strong character, with inline code left
 * out ("`iPhone` שלום" is a Hebrew paragraph). A block without a strong
 * character (a time, a number) takes the document's direction. Container
 * blocks (lists, quotes, list items) get the direction of their own text,
 * because `auto` skips children that carry a `dir` of their own. Code
 * blocks stay `dir="ltr"`.
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

export const wysiwygBidiKey = new PluginKey<DecorationSet>("lumen-bidi");

const CONTAINER = new Set(["list_item", "bullet_list", "ordered_list", "blockquote"]);
const CODE_MARKS = new Set(["inlineCode", "code_inline", "code"]);

/** A block's text as its reader sees it for direction: inline code left out. */
function directionText(node: PMNode): string {
  let out = "";
  node.descendants((child) => {
    if (child.type.name === "code_block" || child.type.name === "math_block") return false;
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

function decorate(state: EditorState): DecorationSet {
  const decos: Decoration[] = [];
  let base: LineDirection | null = null;
  const dirOf = (node: PMNode) => firstStrong(directionText(node)) ?? (base ??= documentDirection(state));
  state.doc.descendants((node, pos) => {
    if (node.type.name === "code_block" || node.type.name === "math_block") {
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

export function wysiwygBidiPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: wysiwygBidiKey,
    state: {
      init: (_, state) => decorate(state),
      apply: (tr, old, _oldState, newState) => (tr.docChanged ? decorate(newState) : old),
    },
    props: {
      decorations: (state) => wysiwygBidiKey.getState(state) ?? null,
      handleKeyDown(view, event) {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return false;
        if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
        return logicalArrow(view, event.key === "ArrowRight", event.shiftKey);
      },
    },
  });
}
