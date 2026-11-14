/**
 * HAST → React elements (plan 8.1): the one step of the preview pipeline
 * that stays on the main thread, because it needs the components map
 * (./components). The tree comes from the render worker or, without one,
 * from ./renderCore.ts run here; both give the same tree, so both give the
 * same elements.
 */
import { unified } from "unified";
import type { ReactElement } from "react";
import type { Root as HastRoot } from "hast";
import rehypeReact from "rehype-react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { components } from "./components";

type ReactCompiler = { stringify(tree: HastRoot): ReactElement };

let compiler: ReactCompiler | null = null;

export function hastToReact(tree: HastRoot): ReactElement {
  compiler ??= unified().use(rehypeReact, {
    Fragment,
    jsx,
    jsxs,
    components,
  } as unknown as Parameters<typeof rehypeReact>[0]) as unknown as ReactCompiler;
  return compiler.stringify(tree);
}
