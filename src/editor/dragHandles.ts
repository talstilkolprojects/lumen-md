/**
 * ProseMirror plugin — drag-handles on every top-level block.
 *
 * Renders a small ⠿ widget to the left of the block under the pointer.
 * Pressing and dragging the widget reorders the block: when the user
 * drops on a different sibling, the source slice is moved to the drop
 * position via a single transaction.
 *
 * Why a custom plugin instead of `prosemirror-handle` (which doesn't
 * ship with Milkdown): we need a tiny no-deps implementation that
 * cooperates with the existing Milkdown listener / clipboard plugins
 * without ownership conflicts. The plugin is ~120 lines and binds only
 * to the ProseMirror primitives Milkdown already exposes.
 *
 * Wire-up (see `WysiwygEditor.tsx`):
 *   import { dragHandlePlugin } from "./dragHandles";
 *   editor.use(dragHandlePlugin);
 */

import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import type { EditorState } from "prosemirror-state";

const HANDLE_KEY = new PluginKey("lumen-drag-handle");

interface DragState {
  /** ProseMirror position of the source block (start of the node). */
  fromPos: number | null;
  /** Hover indicator — the position we'd insert the source at on drop. */
  hoverPos: number | null;
}

const initial: DragState = { fromPos: null, hoverPos: null };

/**
 * Build the handle DOM. Lives entirely on the editor host so we can
 * mount it via `Decoration.widget(side: -1)`. The handle responds to
 * `dragstart` / `dragend`; the editor's container listens for
 * `dragover` / `drop` to update hover + commit the move.
 */
function makeHandle(view: EditorView, blockPos: number): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "lumen-drag-handle";
  el.setAttribute("contenteditable", "false");
  el.draggable = true;
  el.title = "Drag to reorder block";
  el.setAttribute("aria-label", "Drag block handle");
  // The braille glyph is a strong left-to-right character, and the widget
  // sits first inside the block: inside <bdi> the block's `dir="auto"`
  // (T25) skips it and resolves from the real text, while the handle
  // itself still follows the block (so inset-inline-start is its start).
  const glyph = document.createElement("bdi");
  glyph.textContent = "⠿";
  el.appendChild(glyph);
  el.style.cssText = [
    "position: absolute",
    "inset-inline-start: -22px",
    "top: 4px",
    "width: 18px",
    "height: 18px",
    "border: none",
    "background: transparent",
    "color: hsl(var(--fg-muted))",
    "cursor: grab",
    "font-size: 14px",
    "line-height: 1",
    "padding: 0",
    "opacity: 0",
    "transition: opacity 120ms",
    "user-select: none",
    // The finger drags the block, not the page (plan 10.2.1).
    "touch-action: none",
  ].join(";");

  el.addEventListener("dragstart", (e) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = "move";
    // Firefox needs setData to start the drag.
    e.dataTransfer.setData("application/x-lumen-block", String(blockPos));
    view.dispatch(
      view.state.tr.setMeta(HANDLE_KEY, { fromPos: blockPos, hoverPos: null }),
    );
    el.style.cursor = "grabbing";
  });

  el.addEventListener("dragend", () => {
    el.style.cursor = "grab";
    view.dispatch(view.state.tr.setMeta(HANDLE_KEY, initial));
  });

  // Touch and pen (plan 10.2.1): HTML5 drag-and-drop doesn't start from a
  // finger on most mobile browsers, so a pointer drag does the same move —
  // press the handle, slide, lift where the block should go. Mouse keeps the
  // native drag above.
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    e.preventDefault();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* why: no capture (an unknown pointer): the window listeners below still see it */
    }
    view.dispatch(view.state.tr.setMeta(HANDLE_KEY, { fromPos: blockPos, hoverPos: null }));
    let last = { x: e.clientX, y: e.clientY };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      last = { x: ev.clientX, y: ev.clientY };
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (ev.type === "pointerup" && (Math.abs(last.x - e.clientX) > 4 || Math.abs(last.y - e.clientY) > 4)) moveBlockTo(view, blockPos, last.x, last.y);
      else view.dispatch(view.state.tr.setMeta(HANDLE_KEY, initial));
    };
    // On window: with or without capture, the pointer's later events reach these.
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  });

  // Touch and pen (plan 10.2.1): HTML5 drag-and-drop doesn't start from a
  // finger on most mobile browsers, so a pointer drag does the same move —
  // press the handle, slide, lift where the block should go. Mouse keeps the
  // native drag above.
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    e.preventDefault();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // why: pointer capture is not available for this pointer; the drag still works without it
      /* no capture (an unknown pointer): the window listeners below still see it */
    }
    view.dispatch(view.state.tr.setMeta(HANDLE_KEY, { fromPos: blockPos, hoverPos: null }));
    let last = { x: e.clientX, y: e.clientY };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      last = { x: ev.clientX, y: ev.clientY };
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (ev.type === "pointerup" && (Math.abs(last.x - e.clientX) > 4 || Math.abs(last.y - e.clientY) > 4)) moveBlockTo(view, blockPos, last.x, last.y);
      else view.dispatch(view.state.tr.setMeta(HANDLE_KEY, initial));
    };
    // On window: with or without capture, the pointer's later events reach these.
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  });

  // Keyboard a11y — focus the handle then ↑/↓ moves the block one step
  // in either direction; Enter / Space behaves the same as a click on
  // the block (focus the editor at the block start). Without this,
  // drag-handles are mouse-only and screen-reader / keyboard users
  // can't reorder blocks at all.
  el.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      moveBlockByOne(view, blockPos, e.key === "ArrowUp" ? -1 : 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      view.focus();
      const tr = view.state.tr.setSelection(
        TextSelection.near(view.state.doc.resolve(blockPos + 1)),
      );
      view.dispatch(tr);
    }
  });

  return el;
}

/**
 * A drop lands between two top-level blocks, never inside one (that would
 * split a paragraph in two): before the block under the point when the point
 * is in its upper half, after it otherwise.
 * @internal exported for tests.
 */
export function blockBoundary(view: EditorView, pos: number, y: number): number {
  const $pos = view.state.doc.resolve(Math.max(0, Math.min(pos, view.state.doc.content.size)));
  if ($pos.depth === 0) return $pos.pos;
  const start = $pos.before(1);
  const end = $pos.after(1);
  const dom = view.nodeDOM(start);
  if (dom instanceof HTMLElement) {
    const r = dom.getBoundingClientRect();
    if (r.height > 0) return y < r.top + r.height / 2 ? start : end;
  }
  return pos - start <= end - pos ? start : end;
}

/**
 * Move the block at `fromPos` up (`dir = -1`) or down (`dir = +1`) by
 * one sibling within the document. No-op when already at the boundary.
 */
function moveBlockByOne(view: EditorView, fromPos: number, dir: -1 | 1): void {
  const node = view.state.doc.nodeAt(fromPos);
  if (!node) return;
  const sourceTo = fromPos + node.nodeSize;
  // Find the sibling we'd swap with by walking direct children.
  let prev = -1;
  let next = -1;
  let pos = 0;
  view.state.doc.forEach((child, off) => {
    if (off === fromPos) {
      // already-set
    } else if (off < fromPos) {
      prev = off;
    } else if (off > fromPos && next === -1) {
      next = off;
    }
    pos = off + child.nodeSize;
  });
  void pos;

  let target: number;
  if (dir === -1) {
    if (prev < 0) return; // already at top
    target = prev;
  } else {
    if (next < 0) return; // already at bottom
    const nextNode = view.state.doc.nodeAt(next);
    if (!nextNode) return;
    target = next + nextNode.nodeSize;
  }

  const slice = view.state.doc.slice(fromPos, sourceTo);
  const tr = view.state.tr.delete(fromPos, sourceTo);
  // Adjust target by the deletion's length when the target was after
  // the source.
  const adjusted = target > sourceTo ? target - node.nodeSize : target;
  tr.insert(adjusted, slice.content);
  view.dispatch(tr);
}

/**
 * Move the block at `fromPos` to the document position under the screen
 * point (x, y): the drop of a mouse drag, or the release of a touch drag.
 * @internal exported for tests.
 */
export function moveBlockTo(view: EditorView, fromPos: number, x: number, y: number): boolean {
  const coords = view.posAtCoords({ left: x, top: y });
  const sourceNode = view.state.doc.nodeAt(fromPos);
  if (!coords || !sourceNode) {
    view.dispatch(view.state.tr.setMeta(HANDLE_KEY, initial));
    return false;
  }
  const sourceTo = fromPos + sourceNode.nodeSize;
  let target = blockBoundary(view, coords.pos, y);
  // If we'd insert into the source's own range, snap to its end.
  if (target >= fromPos && target <= sourceTo) target = sourceTo;
  const slice = view.state.doc.slice(fromPos, sourceTo);
  const tr = view.state.tr;
  // Delete first, then insert at the (shifted) target.
  tr.delete(fromPos, sourceTo);
  const adjusted = target > sourceTo ? target - sourceNode.nodeSize : target;
  tr.insert(adjusted, slice.content);
  tr.setMeta(HANDLE_KEY, initial);
  view.dispatch(tr);
  return true;
}

/**
 * Compute one widget decoration per top-level block. We only decorate
 * direct children of the doc root — nested lists / quotes get a single
 * handle for the outer block, which is the convention every Notion-like
 * editor follows.
 */
function buildDecorations(state: EditorState): DecorationSet {
  const decos: Decoration[] = [];
  state.doc.forEach((node, offset) => {
    if (node.isBlock) {
      decos.push(
        Decoration.widget(offset + 1, (view) => makeHandle(view, offset), {
          side: -1,
          ignoreSelection: true,
          key: `lumen-drag-${offset}`,
        }),
      );
    }
  });
  return DecorationSet.create(state.doc, decos);
}

/**
 * The plugin. Decorations recompute on every doc change; the drag-state
 * meta key is used purely for the hover indicator (not yet rendered —
 * the visible affordance is the source-row's reduced opacity, applied
 * via CSS via the hover decoration).
 */
export const dragHandlePlugin = new Plugin<DragState>({
  key: HANDLE_KEY,
  state: {
    init: () => initial,
    apply(tr, value) {
      const meta = tr.getMeta(HANDLE_KEY);
      if (meta) return meta as DragState;
      return value;
    },
  },
  props: {
    decorations(this: Plugin<DragState>, state) {
      return buildDecorations(state);
    },
    handleDOMEvents: {
      // Show / hide the handle on row hover. We rely on the visible CSS
      // pseudo-class :hover on the parent block by mutating the handle's
      // opacity from a delegated mousemove listener — much cheaper than
      // a per-block React state + ResizeObserver.
      pointermove(view, e) {
        const root = view.dom;
        const handles = root.querySelectorAll<HTMLElement>(".lumen-drag-handle");
        const target = e.target as HTMLElement;
        for (const h of handles) {
          // The handle's absolute positioning means its DOMRect lives
          // outside the block; check the parent block instead.
          const parent = h.parentElement;
          if (!parent) continue;
          if (parent.contains(target) || parent === target) {
            h.style.opacity = "0.6";
          } else {
            h.style.opacity = "0";
          }
        }
        return false;
      },
      pointerdown(view, e) {
        // No hover on touch: touching a block shows its handle.
        if (e.pointerType === "mouse") return false;
        const target = e.target as HTMLElement;
        for (const h of view.dom.querySelectorAll<HTMLElement>(".lumen-drag-handle")) {
          const parent = h.parentElement;
          h.style.opacity = parent && (parent.contains(target) || parent === target) ? "0.8" : "0";
        }
        return false;
      },
      pointerleave(view, e) {
        if (e.pointerType !== "mouse") return false;
        for (const h of view.dom.querySelectorAll<HTMLElement>(".lumen-drag-handle")) {
          h.style.opacity = "0";
        }
        return false;
      },
      dragover(view, e) {
        // Compute the position the source would land at on drop, store
        // it as hover meta so we can render a visual indicator.
        if (!e.dataTransfer?.types?.includes("application/x-lumen-block")) {
          return false;
        }
        e.preventDefault();
        const coords = view.posAtCoords({ left: e.clientX, top: e.clientY });
        if (!coords) return true;
        view.dispatch(
          view.state.tr.setMeta(HANDLE_KEY, {
            ...view.state.tr.getMeta(HANDLE_KEY),
            hoverPos: coords.pos,
          }),
        );
        return true;
      },
      drop(view, e) {
        const data = e.dataTransfer?.getData("application/x-lumen-block");
        if (!data) return false;
        const fromPos = Number(data);
        if (!Number.isFinite(fromPos)) return false;
        e.preventDefault();
        moveBlockTo(view, fromPos, e.clientX, e.clientY);
        return true;
      },
    },
  },
});
