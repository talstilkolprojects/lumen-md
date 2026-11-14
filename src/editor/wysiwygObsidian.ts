/**
 * Obsidian syntax in the WYSIWYG editor (W1.3).
 *
 * - `==highlight==` (with an optional colour emoji) is a mark. It opens from
 *   the Markdown and is written back as `==…==`.
 * - A callout (`> [!type] Title`) stays a quote, so its text remains
 *   editable, but it is drawn as a callout. The serializer writes the
 *   `[!type]` head as is, instead of escaping it to `\[!type]` (which would
 *   turn the callout into a plain quote).
 * - `%%comments%%` stay in the text, faded, as in Obsidian's Live Preview.
 */
import { $markSchema, $prose, $remark } from "@milkdown/utils";
import type { Mark, Node as ProseNode } from "@milkdown/prose/model";
import { Plugin, PluginKey } from "@milkdown/prose/state";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import type { Root } from "mdast";
import { defaultHandlers } from "mdast-util-to-markdown";
import { CALLOUT_HEAD, HIGHLIGHT_COLORS, calloutKind, wrapHighlights } from "../renderer/remarkObsidian";

const EMOJI_BY_COLOR = Object.fromEntries(Object.entries(HIGHLIGHT_COLORS).map(([e, c]) => [c, e]));

type Handler = (node: never, parent: never, state: never, info: never) => string;
interface ToMd {
  stack: string[];
  safe: (value: string, config: unknown) => string;
  containerPhrasing: (node: unknown, info: unknown) => string;
}

const highlightHandler = ((node: { color?: string }, _parent: unknown, state: ToMd, info: Record<string, unknown>) => {
  const inner = state.containerPhrasing(node, { ...info, before: "=", after: "=" });
  return `==${node.color ? (EMOJI_BY_COLOR[node.color] ?? "") : ""}${inner}==`;
}) as unknown as Handler;

const textHandler = ((
  node: { value: string },
  parent: { type?: string; children?: unknown[] } | undefined,
  state: ToMd,
  info: Record<string, unknown>,
) => {
  if (parent?.type === "paragraph" && parent.children?.[0] === node && state.stack.includes("blockquote")) {
    const m = CALLOUT_HEAD.exec(node.value);
    if (m) return m[0] + state.safe(node.value.slice(m[0].length), { ...info, before: " " });
  }
  return (defaultHandlers.text as unknown as (n: unknown, p: unknown, s: unknown, i: unknown) => string)(node, parent, state, info);
}) as unknown as Handler;

export function remarkObsidianWysiwyg(this: { data: (key?: string) => Record<string, unknown> }) {
  const data = this.data() as { toMarkdownExtensions?: unknown[] };
  (data.toMarkdownExtensions ??= []).push({ handlers: { highlight: highlightHandler, text: textHandler } });
  return (tree: Root) => wrapHighlights(tree);
}

export const obsidianRemark = $remark("obsidianSyntax", () => remarkObsidianWysiwyg as never);

export const highlightSchema = $markSchema("obsidian_highlight", () => ({
  attrs: { color: { default: null } },
  parseDOM: [
    {
      tag: "mark.obsidian-highlight",
      getAttrs: (dom: HTMLElement) => ({ color: dom.getAttribute("data-color") }),
    },
  ],
  toDOM: (mark: Mark) => [
    "mark",
    {
      class: mark.attrs.color ? `obsidian-highlight hl-${mark.attrs.color}` : "obsidian-highlight",
      ...(mark.attrs.color ? { "data-color": mark.attrs.color } : {}),
    },
  ],
  parseMarkdown: {
    match: (node: { type: string }) => node.type === "highlight",
    runner: (state, node, markType) => {
      state.openMark(markType, { color: (node as { color?: string }).color ?? null });
      state.next(node.children ?? []);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark: Mark) => mark.type.name === "obsidian_highlight",
    runner: (state, mark) => {
      state.withMark(mark, "highlight", undefined, mark.attrs.color ? { color: mark.attrs.color } : {});
    },
  },
}));

const COMMENT = /%%[\s\S]*?(?:%%|$)/g;

/** Callout styling and faded comments, as decorations (the document is not changed). */
export function obsidianDecorations(doc: ProseNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "blockquote") {
      const first = node.firstChild;
      const m = first?.isTextblock ? CALLOUT_HEAD.exec(first.textContent) : null;
      if (m) {
        decos.push(
          Decoration.node(pos, pos + node.nodeSize, {
            class: `callout callout-${calloutKind(m[1])}`,
            "data-callout": m[1].toLowerCase(),
          }),
        );
      }
    }
    if (node.isTextblock && node.type.spec.code !== true) {
      const text = node.textContent;
      if (text.includes("%%")) {
        // Text offsets map to positions only inside plain inline content.
        let offset = 0;
        const starts: number[] = [];
        node.forEach((child, childOffset) => {
          if (child.isText) for (let i = 0; i < (child.text ?? "").length; i++) starts[offset + i] = pos + 1 + childOffset + i;
          offset += child.isText ? (child.text ?? "").length : child.textContent.length;
        });
        for (const m of text.matchAll(COMMENT)) {
          const from = starts[m.index];
          const toIdx = m.index + m[0].length - 1;
          const to = starts[toIdx];
          if (from !== undefined && to !== undefined) decos.push(Decoration.inline(from, to + 1, { class: "obs-comment" }));
        }
      }
      return false;
    }
    return true;
  });
  return DecorationSet.create(doc, decos);
}

const decoKey = new PluginKey<DecorationSet>("obsidianDecorations");

export const obsidianDecorationsPlugin = $prose(
  () =>
    new Plugin<DecorationSet>({
      key: decoKey,
      state: {
        init: (_, state) => obsidianDecorations(state.doc),
        apply: (tr, old) => (tr.docChanged ? obsidianDecorations(tr.doc) : old),
      },
      props: {
        decorations: (state) => decoKey.getState(state),
      },
    }),
);

export const wysiwygObsidianPlugins = [obsidianRemark, highlightSchema, obsidianDecorationsPlugin].flat();
