/**
 * The outline of a long document, re-parsed only where it changed
 * (plan 8.4).
 *
 * `extractToc` parses the whole document on every change: ~1 s of main
 * thread for a 2 MB note. This keeps the document's top-level blocks
 * (./blocks.ts) and the headings found in each; after an edit only the
 * blocks around it are parsed again. Heading ids are then numbered over
 * the whole document, the same way, so the result is exactly
 * `extractToc(markdown)`.
 *
 * Reference definitions are the one thing a block cannot see on its own:
 * `# [Intro]` is a link only if `[intro]: …` is defined somewhere. When a
 * document has definitions, blocks whose headings contain `[` are parsed
 * again after them (before: the block may end in an unclosed fence), and
 * again whenever the set of definitions changes.
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import type { Root as MdastRoot } from "mdast";
import { headingSlugger } from "../lib/slug";
import { stripCriticDelimiters } from "./criticMarkup";
import { BlockTracker } from "./blocks";

export interface TocEntry {
  depth: number;
  text: string;
  id: string;
}

interface Heading {
  depth: number;
  text: string;
  /** Its source contains `[`, so its text may depend on reference definitions. */
  bracket: boolean;
}

interface BlockToc {
  text: string;
  headings: Heading[];
  /** Labels of the reference definitions in this block. */
  defs: string[];
  /** Headings parsed again after the document's definitions, for that set of definitions. */
  withDefs?: { sig: string; headings: Heading[] };
}

/** The same frontmatter / CriticMarkup stripping `extractToc` does. */
export function tocSource(markdownText: string): string {
  return stripCriticDelimiters(markdownText)
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/m, "")
    .replace(/^\+\+\+\r?\n[\s\S]*?\r?\n\+\+\+\r?\n?/m, "");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mdToString(node: any): string {
  if (typeof node?.value === "string") return node.value;
  if (Array.isArray(node?.children)) return node.children.map(mdToString).join("");
  return "";
}

export class IncrementalToc {
  private readonly tracker = new BlockTracker();
  private readonly parser = unified().use(remarkParse);
  private values: BlockToc[] = [];
  /** Blocks parsed since this outline was created (a test counter). */
  parsed = 0;

  private parse(text: string): { headings: Heading[]; defs: string[] } {
    this.parsed++;
    const tree = this.parser.parse(text) as MdastRoot;
    const headings: Heading[] = [];
    const defs: string[] = [];
    visit(tree, (node) => {
      if (node.type === "heading") {
        const s = node.position?.start.offset ?? 0;
        const e = node.position?.end.offset ?? text.length;
        headings.push({ depth: node.depth, text: mdToString(node), bracket: text.slice(s, e).includes("[") });
      } else if (node.type === "definition") {
        defs.push(node.label ?? node.identifier);
      }
    });
    return { headings, defs };
  }

  /** The outline of `markdownText` — equal to `extractToc(markdownText)`. */
  update(markdownText: string): TocEntry[] {
    const source = tocSource(markdownText);
    const u = this.tracker.update(source);
    // Scanned-again blocks whose text did not change keep their result.
    const reusable = new Map<string, BlockToc>();
    for (let k = u.head; k < u.oldTail && k < this.values.length; k++) reusable.set(this.values[k].text, this.values[k]);
    const middle = u.blocks.slice(u.head, u.tail).map((b) => {
      const text = source.slice(b.start, b.end);
      return reusable.get(text) ?? { text, ...this.parse(text) };
    });
    this.values = this.values.slice(0, u.head).concat(middle, this.values.slice(u.oldTail));

    const labels = [...new Set(this.values.flatMap((v) => v.defs))];
    const sig = labels.join("\n");
    const defsText = labels.map((l) => `[${l}]: #`).join("\n");
    const slugger = headingSlugger();
    const out: TocEntry[] = [];
    for (const v of this.values) {
      let headings = v.headings;
      if (labels.length && headings.some((h) => h.bracket)) {
        if (v.withDefs?.sig !== sig) v.withDefs = { sig, headings: this.parse(`${defsText}\n\n${v.text}`).headings };
        headings = v.withDefs.headings;
      }
      for (const h of headings) {
        if (!h.text.trim()) continue;
        out.push({ depth: h.depth, text: h.text, id: slugger.slug(h.text) });
      }
    }
    return out;
  }
}
