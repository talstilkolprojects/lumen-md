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

export function rehypeDirAuto() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      const props = (node.properties ??= {});
      if (props.dir !== undefined && props.dir !== null && props.dir !== "") return;
      if (LTR.has(node.tagName)) props.dir = "ltr";
      else if (CONTAINER.has(node.tagName)) props.dir = firstStrongDirection(toString(node)) ?? "auto";
      else if (AUTO.has(node.tagName)) props.dir = "auto";
    });
  };
}
