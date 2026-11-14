/**
 * Typewriter mode — keeps the active CodeMirror line vertically centred
 * inside the scroller as you type. Inspired by iA Writer / Ulysses.
 *
 * Implementation:
 *   • A ViewPlugin watches every selection / doc change.
 *   • If the head moved we measure the active line's `top` (via
 *     `view.coordsAtPos`) and dispatch an effect that scrolls the
 *     scroller so that line sits at 50% of the viewport.
 *   • A `paddingTop` / `paddingBottom` of `40vh` gives the first / last
 *     lines room to centre too — without it the cursor can't reach the
 *     midpoint near document boundaries.
 */

import { EditorView, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { scrollBehavior } from "../lib/motion";

const PADDING = "40vh";

export function typewriterModeExtension(): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        previousHead = -1;
        update(u: ViewUpdate) {
          const head = u.state.selection.main.head;
          // Only re-centre when the cursor actually moved or the doc grew —
          // otherwise we'd fight the user's scroll-wheel gestures.
          if (!u.docChanged && !u.selectionSet) return;
          if (head === this.previousHead) return;
          this.previousHead = head;
          const coords = u.view.coordsAtPos(head);
          if (!coords) return;
          const scroller = u.view.scrollDOM;
          const target =
            scroller.scrollTop +
            (coords.top - scroller.getBoundingClientRect().top) -
            scroller.clientHeight / 2;
          scroller.scrollTo({ top: target, behavior: scrollBehavior() });
        }
      },
    ),
    EditorView.theme({
      "&": {
        scrollPaddingTop: PADDING,
        scrollPaddingBottom: PADDING,
      },
      ".cm-scroller": {
        paddingBlock: PADDING,
      },
    }),
  ];
}
