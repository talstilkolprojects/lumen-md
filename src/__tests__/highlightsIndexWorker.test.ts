/**
 * Audit W10.C25 (plan W1.15 step 1): the highlights hub's index is built in
 * the vault index worker, from the notes the index already holds. The main
 * thread no longer lists, reads and parses every note itself.
 *
 * `localEngine` is the same request handler the worker runs
 * (vaultIndex.worker.ts → handleIndexRequest), here in this thread. The
 * notes are synthetic.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VaultIndex } from "../storage/vaultIndexCore";
import { localEngine } from "../storage/vaultIndexLocal";
import { buildIndex, isIndexed } from "../highlights/hub";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { writeWorkspaceFile } from "../storage/workspace";
import { __resetWorkspaceIndex, ensureIndex } from "../storage/workspaceIndex";
import type { IndexEngine } from "../storage/vaultIndexProtocol";

const clip = (tags: string, extra = "") => `---\ntitle: "Story"\nsource: "https://example.com/story"\nclipped: "2026-11-10"\ntags: [${tags}]\n---\n\n> ==a marked passage==\n\nBody with ==another mark==.${extra}\n`;
const NOTES = [
  { path: "clips/story.md", name: "story.md", content: clip("news"), modified: 1 },
  { path: "clips/other.md", name: "other.md", content: `---\nclipped: "2026-11-11"\n---\n\n==kept across rounds==\n`, modified: 1 },
  { path: "notes/plain.md", name: "plain.md", content: "# Plain\n\nA ==mark== in a note that is not a clip.\n", modified: 1 },
];

describe("the highlights index in the vault index worker (W10.C25)", () => {
  it("the worker's handler answers `highlights` with the hub's index of the notes it holds", async () => {
    const engine = localEngine(new VaultIndex());
    await engine.upsert(NOTES);
    const items = await engine.highlights();
    expect(items).toEqual(buildIndex(NOTES.filter((n) => isIndexed(n.path))));
    expect(items.map((i) => i.text).sort()).toEqual(["a marked passage", "another mark", "kept across rounds"]);
  });

  it("after a sync round changes a note, the highlights follow it and the others stay", async () => {
    const engine = localEngine(new VaultIndex());
    await engine.upsert(NOTES);
    // A sync round: the other device added a mark and a tag to the clip.
    await engine.upsert([{ ...NOTES[0], content: clip("news, longread", "\n\nAnd ==a third=="), modified: 2 }]);
    const items = await engine.highlights();
    expect(items.map((i) => i.text).sort()).toEqual(["a marked passage", "a third", "another mark", "kept across rounds"]);
    expect(items.find((i) => i.text === "a third")!.tags).toEqual(["news", "longread"]);
    await engine.remove(["clips/story.md"]);
    expect((await engine.highlights()).map((i) => i.text)).toEqual(["kept across rounds"]);
  });

  describe("the panel asks the index, it does not build", () => {
    beforeEach(() => installFakeOpfs());

    it("loadIndex answers from the engine's `highlights`, once", async () => {
      for (const n of NOTES) await writeWorkspaceFile(n.path, n.content);
      let asked = 0;
      __resetWorkspaceIndex(() => {
        const e: IndexEngine = localEngine(new VaultIndex());
        return { ...e, highlights: () => (asked++, e.highlights()) };
      });
      await ensureIndex(true);
      const { loadIndex } = await import("../highlights/HighlightsPanel");
      const items = await loadIndex();
      expect(asked).toBe(1);
      expect(items.map((i) => i.text).sort()).toEqual(["a marked passage", "another mark", "kept across rounds"]);
    });

    it("the panel's source neither reads notes nor builds the index", () => {
      const src = readFileSync(join(process.cwd(), "src/highlights/HighlightsPanel.tsx"), "utf8");
      expect(src).not.toMatch(/\bbuildIndex\b|readWorkspaceFile|listWorkspace/);
      expect(src).toMatch(/indexedHighlights\(\)/);
    });
  });
});
