/**
 * Obsidian syntax (W1.3), as a remark transformer that runs on the syntax
 * tree after parsing. It is shared by the preview pipeline and the WYSIWYG
 * editor (which turns highlights into a mark).
 *
 * - Callouts: `> [!type] Title`. A `+` or `-` after the type makes the callout
 *   foldable (`+` open, `-` closed). The type aliases are Obsidian's.
 * - Comments: `%%hidden%%`, inline or across blocks. Hidden in the preview.
 *   An unclosed `%%` hides the rest of the note, as in Obsidian.
 * - Highlights: `==text==`. A colour emoji at the start (🔴 🟠 🟡 🟢 🔵 🟣)
 *   picks the colour (Obsidian 1.14).
 * - Image embeds and sizes: `![[img.png]]`, `![[img.png|300]]`,
 *   `![[img.png|300x200]]`, `![[img.png|alt text|300]]`, and the Markdown
 *   form `![alt|300](img.png)`. Images carry their source offset
 *   (`data-md-offset`), so resizing one in the preview can write the new
 *   width back (imageSize.ts).
 *
 * Code, inline code, math and raw HTML are never touched.
 */
import type { Root } from "mdast";

/* eslint-disable @typescript-eslint/no-explicit-any -- mdast nodes are rebuilt structurally here */
type Node = any;

/** Obsidian's callout types: alias -> the type that sets the style and default title. */
const CALLOUT_ALIASES: Record<string, string> = {
  note: "note",
  abstract: "abstract",
  summary: "abstract",
  tldr: "abstract",
  info: "info",
  todo: "todo",
  tip: "tip",
  hint: "tip",
  important: "tip",
  success: "success",
  check: "success",
  done: "success",
  question: "question",
  help: "question",
  faq: "question",
  warning: "warning",
  caution: "warning",
  attention: "warning",
  failure: "failure",
  fail: "failure",
  missing: "failure",
  danger: "danger",
  error: "danger",
  bug: "bug",
  example: "example",
  quote: "quote",
  cite: "quote",
};

export const CALLOUT_KINDS = [
  "note",
  "abstract",
  "info",
  "todo",
  "tip",
  "success",
  "question",
  "warning",
  "failure",
  "danger",
  "bug",
  "example",
  "quote",
] as const;

/** True for the types Obsidian knows (they get a translated default title). */
export function isKnownCallout(type: string): boolean {
  return type.toLowerCase() in CALLOUT_ALIASES;
}

/** The style an Obsidian callout type maps to; unknown types look like a note. */
export function calloutKind(type: string): string {
  return CALLOUT_ALIASES[type.toLowerCase()] ?? "note";
}

export const HIGHLIGHT_COLORS: Record<string, string> = {
  "🔴": "red",
  "🟠": "orange",
  "🟡": "yellow",
  "🟢": "green",
  "🔵": "blue",
  "🟣": "purple",
};

export const CALLOUT_HEAD = /^\[!([\w-]+)\]([+-]?)[ \t]*/;

const SKIP = new Set(["code", "inlineCode", "math", "inlineMath", "html", "yaml"]);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?)$/i;
const SIZE = /^(\d{1,5})(?:x(\d{1,5}))?$/;

export interface ObsidianOptions {
  /** Default title of a callout without one, by its kind. */
  calloutTitle?: (kind: string, type: string) => string;
  /** Leave `%%comments%%` in place (the WYSIWYG editor shows them). */
  keepComments?: boolean;
  /** Turn callouts into elements (the preview). The editor keeps them as quotes. */
  callouts?: boolean;
}

export const defaultCalloutTitle = (_kind: string, type: string) => type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();

/* ─── Comments ─────────────────────────────────────────────────────── */

const BLOCKISH = new Set(["paragraph", "heading", "blockquote", "list", "listItem", "table", "tableRow", "tableCell", "footnoteDefinition"]);

/** Remove `%%…%%` from the tree, in document order. */
export function stripComments(tree: Root): void {
  let open = false;
  const walk = (parent: Node) => {
    const kids: Node[] = parent.children;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      let keep = true;
      if (c.type === "text") {
        if (c.value.includes("%%") || open) {
          const parts = c.value.split("%%");
          let out = "";
          parts.forEach((p: string, k: number) => {
            if (k > 0) open = !open;
            if (!open) out += p;
          });
          c.value = out;
          keep = out.length > 0;
        }
      } else if (SKIP.has(c.type) || !Array.isArray(c.children)) {
        keep = !open;
      } else {
        const had = c.children.length;
        walk(c);
        if (had > 0 && c.children.length === 0 && BLOCKISH.has(c.type)) keep = false;
      }
      if (!keep) {
        kids.splice(i, 1);
        i--;
      }
    }
  };
  walk(tree);
}

/* ─── Highlights ───────────────────────────────────────────────────── */

const PHRASING_PARENTS = new Set(["paragraph", "heading", "tableCell", "emphasis", "strong", "delete", "link", "linkReference", "footnoteDefinition"]);
const MARK = /(?<!=)==(?!=)/g;
/** The emoji presentation selector (U+FE0F) after a colour emoji; built at runtime so no invisible character sits in the source. */
const VARIATION_SELECTOR = new RegExp(`^${String.fromCharCode(0xfe0f)}`);

/** Wrap `==…==` in `highlight` nodes (with an optional colour). */
export function wrapHighlights(tree: Root): void {
  const walk = (parent: Node) => {
    if (!Array.isArray(parent.children)) return;
    for (const c of parent.children) if (!SKIP.has(c.type)) walk(c);
    if (!PHRASING_PARENTS.has(parent.type)) return;
    if (!parent.children.some((c: Node) => c.type === "text" && c.value.includes("=="))) return;
    // Split the text nodes at each `==` into tokens.
    const seq: Node[] = [];
    for (const c of parent.children) {
      if (c.type !== "text" || !c.value.includes("==")) {
        seq.push(c);
        continue;
      }
      let last = 0;
      for (const m of c.value.matchAll(MARK)) {
        if (m.index > last) seq.push({ type: "text", value: c.value.slice(last, m.index) });
        seq.push({ type: "__mark", before: c.value[m.index - 1], after: c.value[m.index + 2] });
        last = m.index + 2;
      }
      if (last < c.value.length) seq.push({ type: "text", value: c.value.slice(last) });
    }
    const out: Node[] = [];
    for (let i = 0; i < seq.length; i++) {
      const t = seq[i];
      if (t.type !== "__mark") {
        out.push(t);
        continue;
      }
      // An opener must be followed by text that does not start with a space.
      const opens = t.after !== undefined && !/\s/.test(t.after);
      let close = -1;
      if (opens) {
        for (let j = i + 1; j < seq.length; j++) {
          if (seq[j].type === "__mark") {
            if (seq[j].before !== undefined && !/\s/.test(seq[j].before)) close = j;
            break;
          }
        }
      }
      if (close < 0) {
        out.push({ type: "text", value: "==" });
        continue;
      }
      const inner = seq.slice(i + 1, close);
      let color: string | undefined;
      const first = inner[0];
      if (first?.type === "text") {
        for (const [emoji, name] of Object.entries(HIGHLIGHT_COLORS)) {
          if (first.value.startsWith(emoji)) {
            color = name;
            first.value = first.value.slice(emoji.length).replace(VARIATION_SELECTOR, "");
            if (!first.value) inner.shift();
            break;
          }
        }
      }
      out.push({
        type: "highlight",
        color,
        data: {
          hName: "mark",
          hProperties: { className: color ? ["obsidian-highlight", `hl-${color}`] : ["obsidian-highlight"] },
        },
        children: inner,
      });
      i = close;
    }
    // Merge adjacent text nodes left by unmatched markers.
    const merged: Node[] = [];
    for (const n of out) {
      const prev = merged[merged.length - 1];
      if (n.type === "text" && prev?.type === "text" && !prev.position && !n.position) prev.value += n.value;
      else merged.push(n);
    }
    parent.children = merged;
  };
  walk(tree);
}

/* ─── Image embeds and sizes ───────────────────────────────────────── */

const EMBED = /!\[\[([^\]\n|]+?)((?:\|[^\]\n]*)*)\]\]/g;

/** Split `|alt|300x200` parameters into alt text and size. */
export function parseEmbedParams(params: string[]): { alt: string | null; width?: number; height?: number } {
  let width: number | undefined;
  let height: number | undefined;
  const alt: string[] = [];
  for (const p of params) {
    const m = SIZE.exec(p.trim());
    if (m && width === undefined) {
      width = Number(m[1]);
      height = m[2] ? Number(m[2]) : undefined;
    } else if (p.trim()) alt.push(p.trim());
  }
  return { alt: alt.length ? alt.join("|") : null, width, height };
}

function sizeProps(width?: number, height?: number): Record<string, number> {
  const p: Record<string, number> = {};
  if (width !== undefined) p.width = width;
  if (height !== undefined) p.height = height;
  return p;
}

export function embedImages(tree: Root): void {
  const walk = (parent: Node) => {
    if (!Array.isArray(parent.children)) return;
    for (let i = 0; i < parent.children.length; i++) {
      const c = parent.children[i];
      if (SKIP.has(c.type)) continue;
      if (c.type === "image") {
        const m = /^(.*?)\|(\d{1,5})(?:x(\d{1,5}))?$/.exec(c.alt ?? "");
        const props: Record<string, unknown> = {};
        if (m) {
          c.alt = m[1];
          Object.assign(props, sizeProps(Number(m[2]), m[3] ? Number(m[3]) : undefined));
        }
        if (c.position?.start.offset !== undefined) {
          props["data-md-offset"] = c.position.start.offset;
          props["data-md-target"] = c.url;
        }
        c.data = { ...(c.data ?? {}), hProperties: { ...(c.data?.hProperties ?? {}), ...props } };
        continue;
      }
      if (c.type === "text" && c.value.includes("![[")) {
        const parts: Node[] = [];
        let last = 0;
        const base = c.position?.start.offset;
        for (const m of c.value.matchAll(EMBED)) {
          const target = m[1].trim();
          if (!IMAGE_EXT.test(target)) continue;
          const { alt, width, height } = parseEmbedParams(m[2].split("|").slice(1));
          if (m.index > last) parts.push({ type: "text", value: c.value.slice(last, m.index) });
          const props: Record<string, unknown> = { className: ["obsidian-embed"], ...sizeProps(width, height) };
          if (base !== undefined) {
            props["data-md-offset"] = base + m.index;
            props["data-md-target"] = target;
          }
          parts.push({
            type: "image",
            url: encodeURI(target),
            alt: alt ?? target.split("/").pop()?.replace(IMAGE_EXT, "") ?? target,
            title: null,
            data: { hProperties: props },
          });
          last = m.index + m[0].length;
        }
        if (parts.length) {
          if (last < c.value.length) parts.push({ type: "text", value: c.value.slice(last) });
          parent.children.splice(i, 1, ...parts);
          i += parts.length - 1;
        }
        continue;
      }
      walk(c);
    }
  };
  walk(tree);
}

/* ─── Callouts ─────────────────────────────────────────────────────── */

/** Split a paragraph's children at the first line break: [first line, rest]. */
function splitFirstLine(children: Node[]): [Node[], Node[]] {
  const head: Node[] = [];
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c.type === "break") return [head, children.slice(i + 1)];
    if (c.type === "text" && c.value.includes("\n")) {
      const at = c.value.indexOf("\n");
      if (at > 0) head.push({ type: "text", value: c.value.slice(0, at) });
      const rest = c.value.slice(at + 1);
      return [head, [...(rest ? [{ type: "text", value: rest }] : []), ...children.slice(i + 1)]];
    }
    head.push(c);
  }
  return [head, []];
}

export function transformCallouts(tree: Root, title: ObsidianOptions["calloutTitle"] = defaultCalloutTitle): void {
  const walk = (parent: Node) => {
    if (!Array.isArray(parent.children)) return;
    for (const c of parent.children) {
      if (SKIP.has(c.type)) continue;
      walk(c);
      if (c.type !== "blockquote") continue;
      const p = c.children[0];
      const t = p?.type === "paragraph" ? p.children[0] : null;
      if (!t || t.type !== "text") continue;
      const m = CALLOUT_HEAD.exec(t.value);
      if (!m) continue;
      const type = m[1];
      const kind = calloutKind(type);
      const fold = m[2];
      t.value = t.value.slice(m[0].length);
      const [head, rest] = splitFirstLine(p.children);
      const titleKids = head.filter((n) => !(n.type === "text" && n.value === ""));
      const body = [...(rest.length ? [{ type: "paragraph", children: rest }] : []), ...c.children.slice(1)];
      c.data = {
        hName: fold ? "details" : "div",
        hProperties: {
          className: ["callout", `callout-${kind}`],
          "data-callout": type.toLowerCase(),
          ...(fold ? { "data-callout-fold": fold, open: fold === "+" } : {}),
        },
      };
      c.children = [
        {
          type: "paragraph",
          data: { hName: fold ? "summary" : "div", hProperties: { className: ["callout-title"] } },
          children: titleKids.length ? titleKids : [{ type: "text", value: title(kind, type) }],
        },
        ...(body.length
          ? [{ type: "blockquote", data: { hName: "div", hProperties: { className: ["callout-content"] } }, children: body }]
          : []),
      ];
    }
  };
  walk(tree);
}

/** The preview's remark plugin. */
export function remarkObsidian(options: ObsidianOptions = {}) {
  return (tree: Root) => {
    if (!options.keepComments) stripComments(tree);
    embedImages(tree);
    if (options.callouts !== false) transformCallouts(tree, options.calloutTitle);
    wrapHighlights(tree);
  };
}
