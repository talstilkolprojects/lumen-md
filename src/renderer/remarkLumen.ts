/**
 * Lumen's Markdown-dialect remark plugins — pure mdast transforms with no
 * React / DOM / browser dependencies. Shared by the app's preview pipeline
 * (./pipeline.ts) and by the VS Code extension (packages/vscode-lumen), so
 * both render `:::note` callouts, `:::columns`, `[[wikilinks]]`, soft line
 * breaks and heading slugs identically.
 */
import { headingSlug } from "../lib/slug";
import { visit } from "unist-util-visit";
import type { Root as MdastRoot } from "mdast";

// Inline remark-breaks plugin: converts single newlines in paragraphs to <br>.
export function remarkBreaks() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tree: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const visit = (node: any) => {
      if (node.children) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const next: any[] = [];
        for (const child of node.children) {
          if (child.type === "text" && child.value?.includes("\n")) {
            const parts = child.value.split("\n");
            parts.forEach((part: string, i: number) => {
              if (part) next.push({ type: "text", value: part });
              if (i < parts.length - 1) next.push({ type: "break" });
            });
          } else {
            visit(child);
            next.push(child);
          }
        }
        node.children = next;
      }
    };
    visit(tree);
  };
}

/**
 * Convert `[[Page Name]]` and `[[target|label]]` text occurrences into
 * intra-document links. v1: target slug becomes the URL fragment, so clicking
 * jumps to a heading with that title. Workspace-aware behavior comes later.
 */
export function remarkWikiLinks() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function walk(parent: any) {
    if (!parent || !Array.isArray(parent.children)) return;
    for (let i = 0; i < parent.children.length; i++) {
      const child = parent.children[i];
      if (
        child.type === "text" &&
        typeof child.value === "string" &&
        child.value.includes("[[")
      ) {
        const replacement = splitWikiText(child.value);
        // Any link — a text that is nothing but `[[Note]]` (a line or list
        // item of its own) splits into a single link node.
        if (replacement.some((n) => n.type === "link")) {
          parent.children.splice(i, 1, ...replacement);
          i += replacement.length - 1;
        }
      } else if (
        child.type !== "code" &&
        child.type !== "inlineCode" &&
        child.type !== "link" &&
        Array.isArray(child.children)
      ) {
        walk(child);
      }
    }
  }
  return (tree: MdastRoot) => walk(tree);
}

interface MdastTextLike {
  type: "text" | "link";
  value?: string;
  url?: string;
  title?: null;
  data?: { hProperties?: Record<string, unknown> };
  children?: { type: "text"; value: string }[];
}

function splitWikiText(value: string): MdastTextLike[] {
  const out: MdastTextLike[] = [];
  const re = /\[\[([^\]\r\n|]+?)(?:\|([^\]\r\n]+?))?\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    if (m.index > last) {
      out.push({ type: "text", value: value.slice(last, m.index) });
    }
    const target = m[1].trim();
    const label = (m[2] ?? target).trim();
    out.push({
      type: "link",
      // `[[#^id]]` points at the block's own id; anything else at a heading slug.
      url: `#${target.startsWith("#^") ? target.slice(1) : slug(target)}`,
      title: null,
      data: {
        hProperties: { className: ["wiki-link"], "data-wiki-target": target },
      },
      children: [{ type: "text", value: label }],
    });
    last = m.index + m[0].length;
  }
  if (last < value.length) {
    out.push({ type: "text", value: value.slice(last) });
  }
  return out;
}

/**
 * remark plugin: convert :::name container directives into admonitions.
 */
export function remarkAdmonitions() {
  const known = new Set(["note", "tip", "info", "warning", "danger"]);
  // remark-directive nodes don't ship type defs in mdast — narrow locally.
  interface DirectiveNode {
    type: string;
    name: string;
    attributes?: Record<string, string | undefined> & { title?: string };
    data?: Record<string, unknown>;
    children?: unknown[];
  }
  return (tree: MdastRoot) => {
    visit(tree, (node) => {
      const n = node as unknown as DirectiveNode;
      if (
        n.type !== "containerDirective" &&
        n.type !== "leafDirective" &&
        n.type !== "textDirective"
      ) {
        return;
      }
      if (!known.has(n.name)) return;

      const data = (n.data ?? (n.data = {})) as Record<string, unknown>;
      data.hName = "div";
      data.hProperties = { className: ["admonition", n.name] };

      const titleText: string =
        (n.attributes && n.attributes.title) ??
        (n.name as string).charAt(0).toUpperCase() + (n.name as string).slice(1);

      const titleNode = {
        type: "paragraph",
        data: {
          hName: "div",
          hProperties: { className: ["admonition-title"] },
        },
        children: [{ type: "text", value: titleText }],
      };
      n.children = [titleNode, ...(n.children ?? [])];
    });
  };
}

/**
 * remark plugin: render `:::columns{cols=N}` container directives as a
 * CSS grid. Each `:::` separator inside the column block delimits a
 * column; the children between separators become column contents.
 *
 *   :::columns{cols=3}
 *   First column body. Multiple paragraphs welcome.
 *   :::
 *   Second column body.
 *   :::
 *   Third column body.
 *   :::
 *
 * The number of columns defaults to the number of `:::`-separated
 * groups when `cols` isn't passed explicitly.
 *
 * Why a renderer-side directive instead of a ProseMirror NodeSpec:
 * markdown round-trip stays trivial (the source is just text), the
 * directive parses on every render so concurrent edits don't conflict
 * with collab, and we avoid pushing 200 lines of NodeSpec + serializer
 * into the WYSIWYG path. The cost: there's no inline editing of
 * individual columns in WYSIWYG — users edit the source.
 */
export function remarkColumns() {
  interface DirectiveNode {
    type: string;
    name: string;
    attributes?: Record<string, string | undefined>;
    data?: Record<string, unknown>;
    children?: Array<{ type: string; data?: Record<string, unknown> }>;
  }
  return (tree: MdastRoot) => {
    visit(tree, (node) => {
      const n = node as unknown as DirectiveNode;
      if (n.type !== "containerDirective") return;
      if (n.name !== "columns") return;

      // Parse `cols=N` attr; fall back to number of children at top level.
      const colsAttr = n.attributes?.cols;
      const cols = colsAttr ? Math.max(1, Math.min(6, parseInt(colsAttr, 10) || 0)) : 0;

      const data = (n.data ?? (n.data = {})) as Record<string, unknown>;
      data.hName = "div";
      data.hProperties = {
        className: ["lumen-columns"],
        style: `display: grid; grid-template-columns: repeat(${
          cols || (n.children?.length ?? 1)
        }, 1fr); gap: 16px;`,
      };

      // Wrap each direct child in a `lumen-column` div so flexible
      // content (paragraphs, lists) renders inside its own grid cell.
      n.children = (n.children ?? []).map((child) => ({
        type: "paragraph",
        data: {
          hName: "div",
          hProperties: { className: ["lumen-column"] },
        },
        children: [child],
      }));
    });
  };
}

/**
 * remark plugin: strip the YAML frontmatter node (we surface it elsewhere).
 */
export function remarkStripFrontmatter() {
  return (tree: MdastRoot) => {
    tree.children = tree.children.filter((c) => c.type !== "yaml");
  };
}

/** Heading id for a wiki-link target — the same one rehype-slug gives the heading (T26). */
export function slug(s: string): string {
  return headingSlug(s);
}
