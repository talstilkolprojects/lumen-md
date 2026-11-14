/**
 * The `![[embed]]` remark plugin as the pipeline registers it (plan 4.7) —
 * only the part every render needs. The expansion itself (resolving
 * targets, sections, the depth and cycle guards; ./embeds) is loaded with
 * the context that drives it, so notes without embeds — and the startup
 * bundle — don't carry it.
 *
 * With a context in `file.data.lumenEmbeds`, the plugin hands the tree to
 * it. Without one (exports, the AI answer view, the first paint before the
 * workspace index is ready) an embed renders as the plain `[[wiki link]]`
 * to its target that remarkWikiLinks, which runs next, makes of it.
 */

import type { Root as MdastRoot } from "mdast";

/** Key of `file.data` that carries the context into the pipeline. */
export const EMBEDS_DATA_KEY = "lumenEmbeds";

export const EMBED_SOURCE = /!\[\[([^\]\r\n]+?)\]\]/.source;

/** Does this Markdown contain an embed? Cheap; code is not excluded. */
export function hasEmbeds(markdown: string): boolean {
  return new RegExp(EMBED_SOURCE).test(markdown);
}

/** What the plugin needs from a context: ./embeds `createEmbedContext` builds one. */
export interface EmbedExpander {
  /** Replace the tree's embeds with the embedded content (or notices). */
  expand(tree: MdastRoot, parse: (markdown: string) => MdastRoot): void;
}

/** Nodes whose text is not prose: embeds inside them stay literal. */
export const LITERAL_NODES = new Set(["code", "inlineCode", "link", "linkReference", "html", "math", "inlineMath", "yaml", "definition"]);

interface TextNode {
  type: string;
  value?: string;
  children?: TextNode[];
}

function unembed(node: TextNode): void {
  for (const c of node.children ?? []) {
    if (LITERAL_NODES.has(c.type)) continue;
    if (c.type === "text" && c.value?.includes("![[")) c.value = c.value.replace(new RegExp(EMBED_SOURCE, "g"), "[[$1]]");
    else unembed(c);
  }
}

/**
 * remark plugin. Runs after the Lumen dialect transforms and before
 * remarkWikiLinks / remarkLumenBlocks, which then also handle the embedded
 * nodes. `parse` turns a note into mdast with the same dialect transforms
 * (the pipeline passes its own parser).
 */
export function remarkEmbeds(options: { parse: (markdown: string) => MdastRoot }) {
  return (tree: MdastRoot, file: { data: unknown }) => {
    const ctx = (file.data as Record<string, unknown> | undefined)?.[EMBEDS_DATA_KEY] as EmbedExpander | undefined;
    if (ctx) ctx.expand(tree, options.parse);
    else unembed(tree as unknown as TextNode);
  };
}
