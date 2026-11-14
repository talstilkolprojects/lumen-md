/**
 * Tests for the tags index — the cheap `tags:` aggregation we use to
 * render the workspace browse-by-tag view.
 *
 * Workspace adapter is mocked so we exercise frontmatter parsing +
 * bucketing without touching OPFS.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildTagsIndex } from "../views/tagsIndex";

vi.mock("../storage/workspace", () => {
  const files = new Map<string, string>();
  return {
    isOPFSAvailable: () => true,
    isAssetName: () => false,
    listWorkspace: async () => {
      return [...files.entries()].map(([path]) => ({
        path,
        name: path.split("/").pop() ?? path,
        size: 0,
        modified: 0,
      }));
    },
    readWorkspaceFile: async (p: string) => {
      const f = files.get(p);
      if (f === undefined) throw new Error(`missing ${p}`);
      return f;
    },
    __setFiles(initial: Record<string, string>) {
      files.clear();
      for (const [k, v] of Object.entries(initial)) files.set(k, v);
    },
  };
});

import * as ws from "../storage/workspace";
import { __resetWorkspaceIndex } from "../storage/workspaceIndex";
// The tags view reads the shared workspace index; a new set of files is a
// structural change, so start each case from an empty index.
const setFiles = (d: Record<string, string>) => {
  __resetWorkspaceIndex();
  (ws as unknown as { __setFiles(d: Record<string, string>): void }).__setFiles(d);
};

beforeEach(() => setFiles({}));

describe("buildTagsIndex", () => {
  it("returns empty when workspace is empty", async () => {
    const idx = await buildTagsIndex();
    expect(idx.totalNotes).toBe(0);
    expect(idx.buckets).toEqual([]);
  });

  it("groups notes by tag and counts them", async () => {
    setFiles({
      "a.md": "---\ntags: [machine-learning, paper]\n---\n\nA",
      "b.md": "---\ntags: [machine-learning]\n---\n\nB",
      "c.md": "---\ntags: [paper]\n---\n\nC",
    });
    const idx = await buildTagsIndex();
    expect(idx.totalNotes).toBe(3);
    const ml = idx.buckets.find((b) => b.tag === "machine-learning");
    expect(ml?.count).toBe(2);
    expect(ml?.paths).toEqual(["a.md", "b.md"]);
  });

  it("buckets are sorted by size desc, then alpha asc", async () => {
    setFiles({
      "a.md": "---\ntags: [bbb]\n---\n",
      "b.md": "---\ntags: [aaa, bbb]\n---\n",
      "c.md": "---\ntags: [ccc]\n---\n",
    });
    const idx = await buildTagsIndex();
    const tags = idx.buckets.map((b) => b.tag);
    // 'bbb' (size 2) first; then 'aaa' and 'ccc' (size 1) alphabetic.
    expect(tags).toEqual(["bbb", "aaa", "ccc"]);
  });

  it("collects untagged notes separately", async () => {
    setFiles({
      "tagged.md": "---\ntags: [foo]\n---\n",
      "untagged.md": "no frontmatter at all",
      "fmNoTags.md": "---\ntitle: foo\n---\n",
    });
    const idx = await buildTagsIndex();
    expect(idx.untaggedPaths.sort()).toEqual(["fmNoTags.md", "untagged.md"]);
  });

  it("accepts string-form tag values (comma-separated, with #)", async () => {
    setFiles({
      "a.md": '---\ntags: "#alpha, #beta"\n---\n',
    });
    const idx = await buildTagsIndex();
    expect(idx.buckets.map((b) => b.tag).sort()).toEqual(["alpha", "beta"]);
  });

  it("normalises tag case (uppercase folded to lowercase)", async () => {
    setFiles({
      "a.md": "---\ntags: [Alpha, BETA]\n---\n",
    });
    const idx = await buildTagsIndex();
    expect(idx.buckets.map((b) => b.tag).sort()).toEqual(["alpha", "beta"]);
  });
});
