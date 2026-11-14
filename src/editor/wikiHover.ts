/**
 * Hover preview in the source editor (plan 4.6): CodeMirror's hoverTooltip
 * over `[[Note]]` / `![[Note]]` shows the note's first 20 lines rendered.
 * The renderer (renderer/hoverPreview) loads on the first hover.
 */

import { hoverTooltip, type EditorView, type Tooltip } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

/** Code is literal: a `[[x]]` in it is no link (as in the renderer). */
const CODE = new Set(["InlineCode", "FencedCode", "CodeBlock", "CodeText", "HTMLBlock", "CommentBlock"]);
function inCode(state: EditorState, pos: number): boolean {
  for (let n: { name: string; parent: unknown } | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent as typeof n) {
    if (CODE.has(n.name)) return true;
  }
  return false;
}

const LINK = /!?\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g;

/** The tooltip for `pos`, or null (no link there, a link in code, or no such note). */
export const wikiHoverSource = async (view: EditorView, pos: number): Promise<Tooltip | null> => {
    const line = view.state.doc.lineAt(pos);
    const off = pos - line.from;
    for (const m of line.text.matchAll(LINK)) {
      const at = m.index ?? 0;
      if (off < at || off > at + m[0].length) continue;
      const target = m[1].trim();
      if (!target || target.startsWith("#") || inCode(view.state, line.from + at)) return null;
      const { renderPreview, mountPreview } = await import("../renderer/hoverPreview");
      const el = await renderPreview(target).catch(() => null);
      if (!el) return null;
      return {
        pos: line.from + at,
        end: line.from + at + m[0].length,
        create() {
          const dom = document.createElement("div");
          dom.className = "lumen-hover-card lumen-hover-card-cm";
          dom.dataset.testid = "hover-preview-editor";
          const unmount = mountPreview(dom, el);
          return { dom, destroy: unmount };
        },
      };
    }
    return null;
};

export const wikiHover = hoverTooltip(wikiHoverSource, { hoverTime: 150 });
