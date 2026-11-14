/**
 * Block ids in the preview (plan 4.8). Obsidian marks a block with ` ^id`
 * at the end of its paragraph (or list item), or with a `^id` line of its
 * own after a block that can't hold one (a table, a quote, code). Here the
 * marker is hidden and the block gets the DOM id `^id`, so a
 * `[[Note#^id]]` link can scroll to it (renderer/wikiLinks, Preview).
 *
 * The same rule picks the block an `![[Note#^id]]` embed shows (./embeds).
 */

import type { Root as MdastRoot } from "mdast";

/** ` ^id` at the end of a paragraph's text. */
export const BLOCK_MARK = /(^|\s)\^([A-Za-z0-9-]+)\s*$/;

interface Node {
  type: string;
  value?: string;
  children?: Node[];
  data?: { hProperties?: Record<string, unknown> } & Record<string, unknown>;
}

const setId = (n: Node, id: string) => {
  n.data ??= {};
  n.data.hProperties = { ...(n.data.hProperties ?? {}), id: `^${id}` };
};

/**
 * Code (and display math) becomes a Lumen block, Shiki's `<pre>` or KaTeX
 * later, and those drop an id put on the node: such a block is wrapped in a
 * `<div>` that carries it.
 */
const REPLACED = new Set(["code", "math"]);
const withId = (n: Node, id: string): Node => {
  if (!REPLACED.has(n.type)) {
    setId(n, id);
    return n;
  }
  return { type: "lumenBlockRef", data: { hName: "div", hProperties: { id: `^${id}` } }, children: [n] };
};

function walk(parent: Node): void {
  const list = parent.children;
  if (!list) return;
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (n.type === "code" || n.type === "html" || n.type === "math") continue;
    const last = n.type === "paragraph" ? n.children?.[n.children.length - 1] : undefined;
    const m = last?.type === "text" ? BLOCK_MARK.exec(last.value ?? "") : null;
    if (m && last) {
      const before = (last.value ?? "").slice(0, m.index);
      if (n.children!.length === 1 && !before.trim()) {
        // A `^id` line of its own names the block before it.
        if (i > 0 && !list[i - 1].data?.hProperties?.id && list[i - 1].type !== "lumenBlockRef") {
          list[i - 1] = withId(list[i - 1], m[2]);
          list.splice(i--, 1);
        }
        continue;
      }
      last.value = before.replace(/\s+$/, "");
      // In a list item, the item is the block.
      setId(parent.type === "listItem" && parent.children?.[0] === n ? parent : n, m[2]);
      continue;
    }
    walk(n);
  }
}

/** remark plugin: hide `^id` markers and put the ids on their blocks. */
export function remarkBlockIds() {
  return (tree: MdastRoot) => walk(tree as unknown as Node);
}
