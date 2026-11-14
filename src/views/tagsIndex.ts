/**
 * Tag index — scans every note in the workspace for `tags:` frontmatter
 * and `#tags` in the text (plan 11.3, outside code) and produces an inverted index (tag → list of notes). The Tag panel
 * uses this to render a flat browse view; the auto-tag agent uses it
 * to bias suggestions toward the user's existing vocabulary.
 *
 * Cheap: <100ms on a few hundred notes. Re-runs on `lumen-workspace-changed`.
 */

import {
  isOPFSAvailable,
  isAssetName,
} from "../storage/workspace";
import { extractFrontmatter } from "../renderer/pipeline";
import { noteTags } from "../search/queryOps";

export interface TagBucket {
  tag: string;
  count: number;
  paths: string[];
}

export interface TagsIndex {
  buckets: TagBucket[];
  /** Total number of notes (denominator for "X% tagged" stats). */
  totalNotes: number;
  /** Notes that have no `tags:` field at all. */
  untaggedPaths: string[];
}

export function tagsFromFrontmatter(fm: unknown): string[] {
  if (!fm || typeof fm !== "object") return [];
  const tags = (fm as Record<string, unknown>).tags;
  if (Array.isArray(tags)) {
    return tags.map((t) => String(t).toLowerCase()).filter(Boolean);
  }
  if (typeof tags === "string") {
    return tags
      .split(/[,\s]+/)
      .map((t) => t.replace(/^#/, "").toLowerCase())
      .filter(Boolean);
  }
  return [];
}

export async function buildTagsIndex(): Promise<TagsIndex> {
  if (!isOPFSAvailable()) {
    return { buckets: [], totalNotes: 0, untaggedPaths: [] };
  }
  // The shared workspace index re-reads only changed files (C3).
  const { ensureIndex, indexedFiles } = await import("../storage/workspaceIndex");
  await ensureIndex();
  const buckets = new Map<string, string[]>();
  const untagged: string[] = [];
  let totalNotes = 0;

  for (const f of indexedFiles().sort((a, b) => a.path.localeCompare(b.path))) {
    if (!/\.(md|markdown)$/i.test(f.path)) continue;
    if (isAssetName(f.name)) continue;
    totalNotes++;
    const body = f.content;
    const fm = extractFrontmatter(body) ?? {};
    // Front matter first (as YAML reads it), then the body's #tags.
    const tags = [...new Set([...tagsFromFrontmatter(fm), ...noteTags(body)])];
    if (tags.length === 0) {
      untagged.push(f.path);
      continue;
    }
    for (const t of tags) {
      const arr = buckets.get(t) ?? [];
      arr.push(f.path);
      buckets.set(t, arr);
    }
  }

  // Sort buckets by descending size so the densest tags surface first.
  const out: TagBucket[] = [...buckets.entries()]
    .map(([tag, paths]) => ({ tag, count: paths.length, paths: paths.sort() }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  return { buckets: out, totalNotes, untaggedPaths: untagged.sort() };
}
