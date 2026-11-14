/**
 * C3 / C4 / C6 — a 10,000-note vault. A save re-indexes only the saved
 * note, the file tree ignores text-only saves, and bursts of saves are
 * coalesced. Timings are generous for CI; the point is "one file, not ten
 * thousand".
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { writeWorkspaceFile } from "../storage/workspace";
import { __resetWorkspaceIndex, ensureIndex, findBacklinks, indexedFiles } from "../storage/workspaceIndex";
import { mergeChanges, notifyWorkspaceChanged, onWorkspaceChanged } from "../storage/workspaceEvents";
import * as ws from "../storage/workspace";

const N = 10_000;

describe("big vault (10,000 notes)", () => {
  beforeAll(async () => {
    installFakeOpfs();
    __resetWorkspaceIndex();
    for (let i = 0; i < N; i++) {
      await writeWorkspaceFile(`notes/${Math.floor(i / 500)}/n${i}.md`, `# Note ${i}\nlinks to [[n${(i + 1) % N}]]\n`);
    }
  }, 120_000);

  it("builds the index once with bounded parallel reads", async () => {
    const t0 = performance.now();
    await ensureIndex();
    expect(indexedFiles()).toHaveLength(N);
    // hygiene-allow: benchmark output
    console.log(`full index of ${N} notes: ${Math.round(performance.now() - t0)} ms`);
  }, 120_000);

  it("a save re-reads only the saved note (< 50 ms), not the vault", async () => {
    const read = vi.spyOn(ws, "readWorkspaceFile");
    await writeWorkspaceFile("notes/0/n1.md", "# Note 1\nnow links to [[n42]]\n");
    notifyWorkspaceChanged({ kind: "content", paths: ["notes/0/n1.md"] });
    const t0 = performance.now();
    await ensureIndex();
    const ms = performance.now() - t0;
    expect(read).toHaveBeenCalledTimes(1);
    expect(ms).toBeLessThan(50);
    const hits = await findBacklinks("notes/0/n42.md");
    expect(hits.map((h) => h.fromPath)).toContain("notes/0/n1.md");
    read.mockRestore();
  });

  it("adding a file is a structural change: a full rebuild picks it up", async () => {
    await writeWorkspaceFile("new.md", "# New");
    notifyWorkspaceChanged();
    await ensureIndex();
    expect(indexedFiles().some((f) => f.path === "new.md")).toBe(true);
  }, 120_000);
});

describe("workspace change events", () => {
  it("coalesce a burst and keep 'structure' over 'content'", async () => {
    vi.useFakeTimers();
    const got: unknown[] = [];
    const off = onWorkspaceChanged((c) => got.push(c), { debounceMs: 200 });
    notifyWorkspaceChanged({ kind: "content", paths: ["a.md"] });
    notifyWorkspaceChanged({ kind: "content", paths: ["b.md"] });
    vi.advanceTimersByTime(250);
    expect(got).toEqual([{ kind: "content", paths: ["a.md", "b.md"] }]);
    notifyWorkspaceChanged({ kind: "content", paths: ["a.md"] });
    window.dispatchEvent(new Event("lumen-workspace-changed"));
    vi.advanceTimersByTime(250);
    expect(got[1]).toEqual({ kind: "structure", paths: undefined });
    off();
    vi.useRealTimers();
    expect(mergeChanges(null, { kind: "content" })).toEqual({ kind: "content" });
  });
});
