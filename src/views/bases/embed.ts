/**
 * Obsidian Bases in a note (plan W1.11) — the startup-side part, kept tiny
 * (type imports only): the engine and the view come with the lazy `base` block.
 *
 *  - `![[Books.base]]` or `![[Books.base#Favourites]]` alone on a line is
 *    turned into a `base` block that loads that file (and that view);
 *  - a `.base` file opened in the editor previews as its views.
 */

import type { Root as MdastRoot } from "mdast";

interface MdNode {
  type: string;
  value?: string;
  lang?: string | null;
  meta?: string | null;
  children?: MdNode[];
}

const EMBED = /^\s*!\[\[([^\]|#\n]+\.base)(?:#([^\]|\n]+))?(?:\|[^\]\n]*)?\]\]\s*$/i;

/** Marks a block made from an embed: `meta` is `embed <path> [view]`, URI-encoded. */
export const BASE_EMBED_META = "embed";

/** remark plugin: a paragraph that is only `![[x.base]]` becomes a `base` block for that file. */
export function remarkBaseEmbeds() {
  const walk = (node: MdNode) => {
    const kids = node.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (k.type === "paragraph" && k.children?.length === 1 && k.children[0].type === "text") {
        const m = EMBED.exec(k.children[0].value ?? "");
        if (m) {
          const meta = [BASE_EMBED_META, encodeURIComponent(m[1].trim()), ...(m[2] ? [encodeURIComponent(m[2].trim())] : [])].join(" ");
          kids[i] = { type: "code", lang: "base", meta, value: "" };
          continue;
        }
      }
      if (k.type !== "code") walk(k);
    }
  };
  return (tree: MdastRoot) => walk(tree as unknown as MdNode);
}

/** The embed a `base` block stands for: the `.base` path and view name, or null for an inline block. */
export function parseBaseEmbedMeta(meta: string | null | undefined): { path: string; view?: string } | null {
  const parts = (meta ?? "").trim().split(/\s+/);
  if (parts[0] !== BASE_EMBED_META || !parts[1]) return null;
  try {
    return { path: decodeURIComponent(parts[1]), view: parts[2] ? decodeURIComponent(parts[2]) : undefined };
  } catch {
    return null;
  }
}

/** A `.base` file's text as Markdown for the preview: one `base` block, fenced longer than any backtick run inside. */
export function baseAsMarkdown(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((s) => s.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}base\n${text.replace(/\n$/, "")}\n${fence}\n`;
}
