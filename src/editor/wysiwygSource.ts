/**
 * The block splitter the WYSIWYG editor's source-preserving save uses
 * (see sourcePreserve.ts): Lumen's own Markdown parser, with the GFM and
 * math syntax Milkdown also reads, so blocks split the same way on both sides.
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { blocksFromMdast, createSourcePreserver, type SourcePreserver } from "./sourcePreserve";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

export const splitMarkdownBlocks = blocksFromMdast((md) => parser.parse(md) as never);

export function wysiwygSourcePreserver(original: string, serializedAtLoad: string): SourcePreserver {
  return createSourcePreserver(original, serializedAtLoad, splitMarkdownBlocks);
}
