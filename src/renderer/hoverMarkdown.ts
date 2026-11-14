/**
 * The part of a note a hover card shows (plan 4.6), as Markdown: no React,
 * no DOM, so the render worker (./render.worker.ts) cuts it out of the note
 * and renders it there (plan 8.1, W10.E4).
 */
import { headingSlugger, wikiFragmentId } from "../lib/slug";
import { noteHeadingLines } from "../lint/vaultDoctor";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkDirective from "remark-directive";
import { remarkBlockIds } from "./remarkBlockIds";

/** How many lines of the note the card shows. */
export const PREVIEW_LINES = 20;

const stripFrontmatter = (text: string) => text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, "");

/** The part of a note a link points at, as Markdown: a heading's section, a block, or the start — at most 20 lines. */
export function previewMarkdown(text: string, fragment: string | null): string {
  const body = stripFrontmatter(text);
  const lines = body.split(/\r?\n/);
  let from = 0;
  if (fragment?.startsWith("^")) {
    const range = blockRange(body, fragment.slice(1));
    if (range) return body.slice(range[0], range[1]).split(/\r?\n/).slice(0, PREVIEW_LINES).join("\n");
  } else if (fragment) {
    // The heading whose slug (numbered like the preview's) is the fragment's.
    // Its line comes from the same parse (code, quotes, HTML: as the preview sees them).
    const want = wikiFragmentId(fragment);
    const slugger = headingSlugger();
    const hit = noteHeadingLines(body).find((h) => slugger.slug(h.text) === want);
    if (hit) from = hit.line;
  }
  return lines.slice(from, from + PREVIEW_LINES).join("\n");
}

let blockParser: ReturnType<typeof buildBlockParser> | null = null;
function buildBlockParser() {
  return unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkDirective).use(remarkBlockIds);
}

interface MdNode {
  type: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/**
 * Where the block `^id` names is in the text: the node the renderer's own
 * remarkBlockIds gives the id (code is skipped, a list item is just that
 * item, a `^id` line of its own names the block before it).
 */
function blockRange(text: string, id: string): [number, number] | null {
  blockParser ??= buildBlockParser();
  const tree = blockParser.runSync(blockParser.parse(text)) as unknown as MdNode;
  const want = `^${id}`;
  const find = (n: MdNode): MdNode | null => {
    if (n.data?.hProperties?.id === want) return n.type === "lumenBlockRef" ? (n.children?.[0] ?? null) : n;
    for (const c of n.children ?? []) {
      const hit = find(c);
      if (hit) return hit;
    }
    return null;
  };
  const node = find(tree);
  const from = node?.position?.start.offset;
  const to = node?.position?.end.offset;
  return from === undefined || to === undefined ? null : [from, to];
}

