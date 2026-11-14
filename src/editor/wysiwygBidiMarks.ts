/**
 * Direction controls in the WYSIWYG editor (plan W5.4): the same tags as
 * the source editor (editor/bidiMarks), the same paste warning, and
 * "clean marks / fix brackets" as one ProseMirror transaction (one undo).
 *
 * Offsets inside a textblock match positions when every inline leaf counts
 * as one character, as in wysiwygBidi's logical arrows.
 */

import { Plugin, PluginKey, type EditorState, type Transaction } from "@milkdown/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/prose/view";
import type { Node as PMNode } from "@milkdown/prose/model";
import { BIDI_CONTROLS, bidiRisks, fixBidi, hasBidiRisk, removeRiskyEdits, type TextEdit } from "../lib/bidiMarks";
import { firstStrong } from "../lib/bidiDirection";
import { bidiTagLabel, warnRiskyPaste } from "./bidiMarks";
import { bidiMarksShown, onBidiMarksChange, registerProseBidiFixer } from "./bidiMarksSetting";

export const wysiwygBidiMarksKey = new PluginKey<DecorationSet>("lumen-bidi-marks");

const CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const isCode = (node: PMNode) => node.type.name === "code_block" || node.type.name === "math_block" || !!node.type.spec.code;

/** Each non-code textblock with its text and the position of its first character. */
function textblocks(doc: PMNode): Array<{ node: PMNode; start: number; text: string }> {
  const out: Array<{ node: PMNode; start: number; text: string }> = [];
  doc.descendants((node, pos) => {
    if (isCode(node)) return false;
    if (!node.isTextblock) return true;
    out.push({ node, start: pos + 1, text: node.textBetween(0, node.content.size, undefined, "\ufffc") });
    return false;
  });
  return out;
}

function tag(name: string, risky: boolean) {
  return () => {
    const c = [...BIDI_CONTROLS.values()].find((x) => x.name === name)!;
    const el = document.createElement("span");
    el.className = risky ? "cm-bidi-tag cm-bidi-tag-risk" : "cm-bidi-tag";
    el.dir = "ltr";
    el.contentEditable = "false";
    el.textContent = name;
    el.title = bidiTagLabel(c, risky);
    el.setAttribute("aria-label", el.title);
    el.dataset.bidi = name;
    return el;
  };
}

function decorate(state: EditorState): DecorationSet {
  const shown = bidiMarksShown();
  const decos: Decoration[] = [];
  for (const { start, text } of textblocks(state.doc)) {
    if (!CONTROL.test(text)) continue;
    const risky = new Set(bidiRisks(text).map((r) => r.index));
    for (let i = 0; i < text.length; i++) {
      const c = BIDI_CONTROLS.get(text.charCodeAt(i));
      if (!c) continue;
      const isRisk = risky.has(i);
      if (!shown && !isRisk) continue;
      decos.push(Decoration.widget(start + i, tag(c.name, isRisk), { side: -1, key: `${c.name}${isRisk ? "!" : ""}`, ignoreSelection: true }));
    }
  }
  return DecorationSet.create(state.doc, decos);
}

/** Apply per-block text edits (offsets within each block) as one transaction. */
function applyBlockEdits(state: EditorState, perBlock: Array<{ start: number; edits: TextEdit[] }>): Transaction | null {
  const all = perBlock.flatMap(({ start, edits }) => edits.map((e) => ({ ...e, from: start + e.from, to: start + e.to })));
  if (!all.length) return null;
  const tr = state.tr;
  for (const e of all.sort((a, b) => b.from - a.from)) {
    if (e.insert) tr.insertText(e.insert, e.from, e.to);
    else tr.delete(e.from, e.to);
  }
  return tr;
}

/** Remove risky controls everywhere in the document; returns how many. */
export function removeRiskyInProse(view: EditorView): number {
  const blocks = textblocks(view.state.doc).map(({ start, text }) => ({ start, edits: removeRiskyEdits(text) }));
  const tr = applyBlockEdits(view.state, blocks);
  if (!tr) return 0;
  view.dispatch(tr.setMeta("addToHistory", true));
  return blocks.reduce((n, b) => n + b.edits.length, 0);
}

/** "Clean unneeded marks and fix reversed brackets" in the WYSIWYG document, one undo step. */
export function fixBidiInProse(view: EditorView): { removed: number; swapped: number } {
  let removed = 0;
  let swapped = 0;
  const blocks = textblocks(view.state.doc);
  const noteDir = blocks.map((b) => firstStrong(b.text)).find(Boolean) ?? "ltr";
  const perBlock = blocks.map(({ start, text }) => {
    // A textblock is one bidi paragraph: hard breaks are leaves here, not newlines.
    const r = fixBidi(text, { noteDir });
    removed += r.removed;
    swapped += r.swapped;
    return { start, edits: r.edits };
  });
  const tr = applyBlockEdits(view.state, perBlock);
  if (tr) view.dispatch(tr);
  return { removed, swapped };
}

export function wysiwygBidiMarksPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: wysiwygBidiMarksKey,
    state: {
      init: (_, state) => decorate(state),
      apply: (tr, old, _o, next) => (tr.docChanged || tr.getMeta(wysiwygBidiMarksKey) ? decorate(next) : old),
    },
    view: (view) => {
      const off = onBidiMarksChange(() => view.dispatch(view.state.tr.setMeta(wysiwygBidiMarksKey, true)));
      const unregister = registerProseBidiFixer(() => {
        const r = fixBidiInProse(view);
        view.focus();
        return r;
      });
      return {
        destroy: () => {
          off();
          unregister();
        },
      };
    },
    props: {
      decorations: (state) => wysiwygBidiMarksKey.getState(state) ?? null,
      handlePaste(view, event, slice) {
        const text = event.clipboardData?.getData("text/plain") || slice.content.textBetween(0, slice.content.size, "\n", "\ufffc");
        if (hasBidiRisk(text)) {
          const count = bidiRisks(text).length;
          // After ProseMirror has inserted the slice.
          setTimeout(() =>
            warnRiskyPaste(count, () => {
              removeRiskyInProse(view);
              view.focus();
            }),
          );
        }
        return false;
      },
    },
  });
}
