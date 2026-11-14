/**
 * CodeMirror extension that paints inline-comment anchors as a yellow
 * highlight in the source-mode editor. The truth lives in the Yjs
 * `lumen-comments` map (see `src/collab/comments.ts`); we resolve each
 * `Y.RelativePosition` to absolute offsets every time the doc or comment
 * map changes and re-render decorations from there.
 *
 * Click → fires a window event (`lumen-comment-focus` with the comment id)
 * so the existing CommentsPanel can scroll itself to the matching thread.
 */
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import * as Y from "yjs";
import { listComments, onCommentsChanged, resolveAnchor } from "../collab/comments";

interface AnchoredComment {
  id: string;
  from: number;
  to: number;
  resolved: boolean;
}

/**
 * Resolve every comment's RelativePosition pair into absolute offsets, drop
 * any that no longer map (the entire range was deleted by another peer),
 * and clamp to the current doc length so we never produce an out-of-range
 * Decoration. Returns sorted, non-overlapping markers.
 */
function resolveAll(doc: Y.Doc, commentsDoc: Y.Doc, docLen: number): AnchoredComment[] {
  const out: AnchoredComment[] = [];
  for (const c of listComments(commentsDoc)) {
    const range = resolveAnchor(doc, c);
    if (!range) continue;
    const from = Math.max(0, Math.min(range.from, docLen));
    const to = Math.max(from, Math.min(range.to, docLen));
    if (from === to) continue;
    out.push({ id: c.id, from, to, resolved: !!c.resolvedAt });
  }
  return out.sort((a, b) => a.from - b.from);
}

function decorationsFor(anchored: AnchoredComment[]): DecorationSet {
  const ranges = anchored.map((a) =>
    Decoration.mark({
      class: a.resolved ? "cm-lumen-comment cm-lumen-comment-resolved" : "cm-lumen-comment",
      attributes: {
        "data-comment-id": a.id,
        title: a.resolved ? "Resolved comment" : "Comment",
        style: a.resolved
          ? "background: hsl(140 60% 50% / 0.10); border-bottom: 2px dotted hsl(140 60% 50% / 0.4); cursor: pointer"
          : "background: hsl(48 95% 60% / 0.20); border-bottom: 2px solid hsl(48 95% 50% / 0.7); cursor: pointer",
      },
    }).range(a.from, a.to),
  );
  return Decoration.set(ranges, /* sort */ true);
}

export interface CommentDecorationsOptions {
  /** Yjs doc currently driving the editor. May be null when offline. */
  doc: Y.Doc | null;
  /** The doc holding the comment threads when it is not `doc` (a room with share links, plan W1.19). */
  commentsDoc?: Y.Doc | null;
}

/**
 * Build the live extension. Pass `null` when there's no active collab
 * session — the extension becomes a no-op until a doc is supplied.
 */
export function commentDecorations(opts: CommentDecorationsOptions): Extension {
  if (!opts.doc) return [];
  // Capture as a non-null local so the view-plugin closure keeps the narrow.
  const ydoc: Y.Doc = opts.doc;
  const cdoc: Y.Doc = opts.commentsDoc ?? opts.doc;

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private unsubscribe: (() => void) | null = null;
      private clickHandler: ((e: MouseEvent) => void) | null = null;

      constructor(view: EditorView) {
        this.refresh(view);
        this.unsubscribe = onCommentsChanged(cdoc, () => this.refresh(view));
        this.clickHandler = (e) => {
          const target = e.target as HTMLElement | null;
          const el = target?.closest?.("[data-comment-id]") as HTMLElement | null;
          if (!el) return;
          const id = el.getAttribute("data-comment-id");
          if (!id) return;
          // Notify listeners (CommentsPanel scrolls to the matching thread).
          // Fire twice so the second dispatch lands after App opens the
          // panel and CommentsPanel registers its own listener — otherwise
          // a click while the panel is closed misses the highlight.
          const fireFocus = () =>
            window.dispatchEvent(
              new CustomEvent("lumen-comment-focus", { detail: { id } }),
            );
          fireFocus();
          window.setTimeout(fireFocus, 80);
          // Visual flash: animate the clicked comment span so the user
          // gets immediate "yes, you clicked here" feedback. The class
          // is removed automatically when the animation finishes.
          el.classList.add("cm-lumen-comment-flash");
          el.addEventListener(
            "animationend",
            () => el.classList.remove("cm-lumen-comment-flash"),
            { once: true },
          );
        };
        view.dom.addEventListener("click", this.clickHandler);
      }

      update(u: ViewUpdate) {
        // Anchors translate into different absolute offsets on every doc
        // change (insertions/deletions shift positions), so re-resolve.
        if (u.docChanged) this.refresh(u.view);
      }

      refresh(view: EditorView) {
        const anchored = resolveAll(ydoc, cdoc, view.state.doc.length);
        this.decorations = decorationsFor(anchored);
        // Force redraw so newly arrived comments appear without a keystroke.
        view.dispatch({});
      }

      destroy() {
        if (this.unsubscribe) this.unsubscribe();
        if (this.clickHandler) {
          // No view reference here — listeners are cleaned up by CodeMirror's
          // own dom-element disposal when the editor is destroyed.
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
