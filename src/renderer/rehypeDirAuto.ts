/**
 * Direction per block of prose (T25): a Hebrew paragraph sits on the
 * right and the English one after it on the left, in the same note.
 *
 * Leaf blocks (paragraphs, headings, cells…) get `dir="auto"`: the
 * browser resolves each from its own first strong character. Container
 * blocks (lists, quotes, list items with nested blocks) cannot use `auto`
 * — the algorithm skips descendants that carry their own `dir`, which
 * every child block now does — so their direction is computed here from
 * their text, which is what decides where the indent, the markers and the
 * quote bar go. Code, math and tables as a whole stay left-to-right (a
 * cell's text still resolves on its own). An element that already has a
 * `dir` (raw HTML in the note) is left alone.
 */

import type { Element, Root } from "hast";
import { toString } from "hast-util-to-string";
import { visit } from "unist-util-visit";
import { firstStrongDirection } from "../lib/textDirection";

const AUTO = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "dd", "dt", "figcaption", "th", "td", "summary", "label"]);
const CONTAINER = new Set(["ul", "ol", "dl", "li", "blockquote", "details"]);
const LTR = new Set(["pre", "table", "math", "svg", "kbd", "samp"]);

const isFormulaOrCode = (n: Element) => {
  const c = n.properties?.className;
  const classes = Array.isArray(c) ? c.map(String) : typeof c === "string" ? c.split(/\s+/) : [];
  return n.tagName === "code" || classes.some((x) => x === "math-inline" || x === "math-display" || x.startsWith("katex"));
};

/**
 * A container's text without its formulas and code (W5.14): "$x$ הוא" is a
 * Hebrew item. When nothing else is left, the whole text decides as before.
 */
function proseText(node: Element): string {
  let out = "";
  for (const child of node.children) {
    if (child.type === "text") out += child.value;
    else if (child.type === "element" && !isFormulaOrCode(child)) out += proseText(child);
  }
  return out;
}

export function rehypeDirAuto() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      const props = (node.properties ??= {});
      if (props.dir !== undefined && props.dir !== null && props.dir !== "") return;
      const cls = Array.isArray(props.className) ? props.className : [];
      if (LTR.has(node.tagName)) props.dir = "ltr";
      else if (cls.includes("callout")) {
        // A callout reads in its content's direction: a default title ("Tip")
        // must not turn a Hebrew callout left-to-right.
        const content = node.children.find(
          (c) => c.type === "element" && Array.isArray(c.properties?.className) && c.properties.className.includes("callout-content"),
        );
        props.dir = firstStrongDirection(proseText(content ?? node)) ?? firstStrongDirection(toString(node)) ?? "auto";
      } else if (CONTAINER.has(node.tagName) || cls.includes("callout-content"))
        props.dir = firstStrongDirection(proseText(node)) ?? firstStrongDirection(toString(node)) ?? "auto";
      else if (AUTO.has(node.tagName) || cls.includes("callout-title")) props.dir = "auto";
    });
  };
}
