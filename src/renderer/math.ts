/**
 * KaTeX, once per formula (plan 8.1 step 2).
 *
 * rehype-katex renders every math element of a document on every render;
 * typing in a note with fifty formulas re-renders all fifty. Here each
 * formula goes through rehype-katex on its own — the element (or the
 * `<pre>` around a ```` ```math ```` block, the scope rehype-katex replaces)
 * as the only child of a small tree — and the result is kept, keyed by a
 * hash of what decides it: the element's tag, its classes and its text.
 * The output is rehype-katex's own, so it is the same as running it over
 * the whole tree. Runs wherever the pipeline runs: in the render worker
 * when there is one (./render.worker.ts).
 */
import type { Element, ElementContent, Root } from "hast";
import { toString as hastToString } from "hast-util-to-string";
import { SKIP, visit } from "unist-util-visit";
import { BlockCache } from "./blockCache";

type RehypeKatex = typeof import("./katexPlugin").default;
type Transform = (tree: Root, file: unknown) => void;

const MATH_CLASSES = ["language-math", "math-display", "math-inline"];

const classesOf = (el: Element): string[] => {
  const c = el.properties?.className;
  return Array.isArray(c) ? c.map(String) : [];
};
const isMath = (el: Element) => classesOf(el).some((c) => MATH_CLASSES.includes(c));

/** Formulas rendered by KaTeX since load (a test counter: a cache hit does not count). */
export const katexStats = { rendered: 0, cached: 0 };

const cache = new BlockCache<ElementContent[]>(2000);

/** Forget the kept formulas (tests). */
export function clearMathCache(): void {
  cache.clear();
  katexStats.rendered = 0;
  katexStats.cached = 0;
}

/**
 * The scope rehype-katex replaces for `el`: the element itself, or the
 * `<pre>` whose `<code class="language-math">` child makes it a display
 * block. null when `el` is not math.
 */
function scopeOf(el: Element): Element | null {
  if (isMath(el)) return el;
  if (el.tagName === "pre" && el.children.some((c) => c.type === "element" && c.tagName === "code" && classesOf(c).includes("language-math"))) return el;
  return null;
}

/** rehype-katex, run per formula with a cache in front of it. */
export function rehypeKatexCached(rehypeKatex: RehypeKatex) {
  return function rehypeKatexPerFormula() {
    const transform = (rehypeKatex as unknown as () => Transform)();
    return (tree: Root, file: unknown) => {
      visit(tree, "element", (el: Element, index, parent) => {
        if (!parent || index === undefined) return;
        const scope = scopeOf(el);
        if (!scope) return;
        const key = `${scope.tagName}\u0000${classesOf(scope).join(" ")}\u0000${scope.children
          .map((c) => (c.type === "element" ? `${c.tagName}.${classesOf(c).join(".")}` : c.type))
          .join(",")}\u0000${hastToString(scope)}`;
        let out = cache.get(key);
        if (out) katexStats.cached++;
        else {
          const mini: Root = { type: "root", children: [structuredClone(scope)] };
          transform(mini, file);
          out = mini.children as ElementContent[];
          cache.set(key, out);
          katexStats.rendered++;
        }
        const nodes = structuredClone(out);
        parent.children.splice(index, 1, ...nodes);
        return [SKIP, index + nodes.length];
      });
    };
  };
}
