/**
 * W2.22 — what the main thread keeps of a note: a compact summary, not its
 * text. The full text lives once, in the index worker (vaultIndexCore). At
 * 100,000 notes the main thread no longer holds a second copy of the vault.
 *
 * The graph reads `meta` (tags and frontmatter scalars, the same read as
 * graphModel's `noteMeta`), the tags view reads the raw `frontmatter` block,
 * and links come from `wikiTargets`.
 */
import { noteMeta } from "../graph/graphModel";
import { wikiTargetsOf } from "./wikiTargets";
import { noteTags } from "../search/queryOps";

export interface NoteSummary {
  /** Raw `[[target]]` texts. */
  wikiTargets: string[];
  /** Tags and scalar frontmatter values, as graphModel's noteMeta reads them. */
  meta: { tags: string[]; props: Record<string, string> };
  /** The leading YAML frontmatter block, delimiters included, or null. Capped. */
  frontmatter: string | null;
  /** Front matter `tags:` and body `#tags` (plan 11.3), lower-case: the tags view and search operators read these. */
  noteTags: string[];
  /** Length of the note, in characters. */
  chars: number;
}

/** The same block `extractFrontmatter` (renderer/pipeline) reads. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
/** A frontmatter block larger than this is not kept (no real note has one). */
export const MAX_FRONTMATTER = 16_384;

export function summarize(content: string): NoteSummary {
  const fm = FRONTMATTER.exec(content)?.[0] ?? null;
  const summary: NoteSummary = {
    wikiTargets: wikiTargetsOf(content),
    meta: noteMeta(content),
    frontmatter: fm && fm.length <= MAX_FRONTMATTER ? fm : null,
    noteTags: noteTags(content),
    chars: content.length,
  };
  // The strings above are slices of `content`: V8 would keep the whole text
  // alive through them. A copy owns its own small strings.
  return JSON.parse(JSON.stringify(summary)) as NoteSummary;
}
