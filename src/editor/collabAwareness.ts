/**
 * Live presence in the editor — render every peer's caret + selection
 * coloured by their awareness state, plus a small floating "X is editing"
 * pill in the top-right when peers are active.
 *
 * Reads from a Y.js Awareness instance: each peer publishes
 *   { user: { name, color, colorLight }, cursor: { anchor, head } }
 * via `setLocalStateField`. We watch for changes and rebuild the
 * decoration set whenever any peer's state mutates.
 *
 * The local peer's cursor is published back on every selection change so
 * remote editors render its position. y-codemirror.next ships a similar
 * binding but pulls in a heavier runtime — we keep this minimal because
 * Lumen's WebRTC mesh is already small (≤ 20 peers).
 */

import { ViewPlugin, EditorView, Decoration, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { Awareness } from "y-protocols/awareness";

interface PeerState {
  user?: { name: string; color: string; colorLight: string };
  cursor?: { anchor: number; head: number };
}

class CursorWidget extends WidgetType {
  constructor(
    private readonly name: string,
    private readonly color: string,
  ) {
    super();
  }
  toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-collab-cursor";
    wrapper.style.cssText = `
      position: relative;
      display: inline-block;
      width: 0;
      border-inline-start: 2px solid ${this.color};
      height: 1.2em;
      vertical-align: text-bottom;
      pointer-events: none;
    `;
    const tag = document.createElement("span");
    tag.textContent = this.name;
    tag.style.cssText = `
      position: absolute;
      top: -1.4em;
      inset-inline-start: -2px;
      padding: 0 4px;
      font-size: 10px;
      line-height: 1.4em;
      color: white;
      background: ${this.color};
      border-radius: 3px;
      border-end-start-radius: 0;
      font-family: Inter, ui-sans-serif, system-ui;
      white-space: nowrap;
      pointer-events: none;
    `;
    wrapper.appendChild(tag);
    return wrapper;
  }
  eq(other: CursorWidget): boolean {
    return other.name === this.name && other.color === this.color;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function decorationsFor(view: EditorView, awareness: Awareness): DecorationSet {
  const localId = awareness.clientID;
  const ranges: Array<{ from: number; to: number; deco: Decoration }> = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === localId) return;
    const peer = state as PeerState;
    if (!peer.cursor || !peer.user) return;
    const { anchor, head } = peer.cursor;
    if (typeof anchor !== "number" || typeof head !== "number") return;
    const docLen = view.state.doc.length;
    const a = Math.max(0, Math.min(anchor, docLen));
    const h = Math.max(0, Math.min(head, docLen));
    const from = Math.min(a, h);
    const to = Math.max(a, h);
    // Selection mark when the peer has a non-empty range.
    if (from !== to) {
      ranges.push({
        from,
        to,
        deco: Decoration.mark({
          attributes: {
            style: `background:${peer.user.colorLight};border-radius:2px`,
            "data-peer": peer.user.name,
          },
        }),
      });
    }
    // Caret widget always rendered at `head`.
    ranges.push({
      from: h,
      to: h,
      deco: Decoration.widget({
        widget: new CursorWidget(peer.user.name, peer.user.color),
        side: 1,
      }),
    });
  });
  ranges.sort((a, b) => a.from - b.from || (a.to ?? a.from) - (b.to ?? b.from));
  return Decoration.set(
    ranges.map((r) => r.deco.range(r.from, r.to)),
    true,
  );
}

/**
 * Wire awareness into a CodeMirror view. Call from `Editor.tsx` when a
 * `CollabSession` is active. Returns an Extension (a plugin + a theme).
 */
export function collabAwarenessExtension(awareness: Awareness): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        private readonly off: () => void;
        private readonly view: EditorView;

        constructor(view: EditorView) {
          this.view = view;
          this.decorations = decorationsFor(view, awareness);
          // Re-render whenever any peer's state changes.
          const listener = () => {
            this.decorations = decorationsFor(view, awareness);
            view.dispatch({});
          };
          awareness.on("change", listener);
          this.off = () => awareness.off("change", listener);
        }

        update(u: ViewUpdate) {
          // Local-cursor publish: tell peers where we are.
          if (u.selectionSet || u.focusChanged) {
            const sel = u.state.selection.main;
            awareness.setLocalStateField("cursor", {
              anchor: sel.anchor,
              head: sel.head,
            });
          }
          // Re-render decorations on any doc change so positions stay valid
          // after local edits move text underneath remote carets.
          if (u.docChanged) {
            this.decorations = decorationsFor(this.view, awareness);
          }
        }

        destroy() {
          this.off();
        }
      },
      {
        decorations: (v) => v.decorations,
      },
    ),
    EditorView.baseTheme({
      ".cm-collab-cursor": { zIndex: 5 },
    }),
  ];
}
