/**
 * Codex P1 on #269: before a commit, every open note with unsaved edits is
 * saved — the inactive tabs too, which autosave never writes — so a merge a
 * pull put into a dirty tab reaches the vault the commit reads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
vi.mock("../storage/workspace", async (orig) => ({
  ...(await orig<object>()),
  workspaceHasFile: async (p: string) => files.has(p),
  readWorkspaceFile: async (p: string) => {
    if (!files.has(p)) throw new Error("missing");
    return files.get(p)!;
  },
  writeWorkspaceFile: async (p: string, c: string) => void files.set(p, c),
}));
vi.mock("../storage/vault", () => ({ getVaultBackend: () => ({ stat: async () => null }), watchVault: () => () => undefined }));

import { useAppStore } from "../store/useStore";
import { flushOpenNotes } from "../store/gitPullDocs";

beforeEach(() => {
  files.clear();
  files.set("repo/a.md", "a before");
  files.set("repo/b.md", "b before");
});

describe("flushOpenNotes", () => {
  it("writes an inactive dirty tab (a merge the pull placed there) and marks it clean", async () => {
    useAppStore.setState({
      doc: { ...useAppStore.getState().doc, name: "b.md", workspaceName: "repo/b.md", content: "b before", dirty: false },
      openTabs: [
        { id: "ws:repo/b.md", name: "b.md", content: "b before", workspaceName: "repo/b.md", dirty: false },
        { id: "ws:repo/a.md", name: "a.md", content: "a merged", workspaceName: "repo/a.md", dirty: true },
      ],
    });
    expect(await flushOpenNotes()).toEqual([]);
    expect(files.get("repo/a.md")).toBe("a merged");
    expect(useAppStore.getState().openTabs.find((t) => t.workspaceName === "repo/a.md")?.dirty).toBe(false);
  });

  it("leaves a tab whose file changed outside Lumen for the conflict flow, and reports it", async () => {
    const ext = await import("../store/externalChanges");
    ext.__resetExternalChanges();
    ext.__setConflictUi(async () => null);
    useAppStore.setState({
      doc: { ...useAppStore.getState().doc, name: "b.md", workspaceName: "repo/b.md", content: "b before", dirty: false },
      openTabs: [{ id: "ws:repo/a.md", name: "a.md", content: "a merged", workspaceName: "repo/a.md", dirty: true }],
    });
    // Lumen last wrote "a before" (so that is the known disk state); another program changed the file since.
    expect(await ext.saveOpenNote("repo/a.md", "a before")).toBe(true);
    files.set("repo/a.md", "changed outside");
    const left = await flushOpenNotes();
    expect(left).toEqual(["repo/a.md"]);
    expect(files.get("repo/a.md")).toBe("changed outside");
    expect(useAppStore.getState().openTabs[0].dirty).toBe(true);
  });
});
