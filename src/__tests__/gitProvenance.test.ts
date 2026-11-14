/**
 * Plan 2.7: git clone / pull record the repo folder as outside content
 * before the first workspace write, so a copy that fails half way (or is
 * still running) is covered.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("idb-keyval", () => ({ get: async () => undefined, set: async () => undefined }));

const writes: string[] = [];
let failAt = Infinity;
vi.mock("../storage/workspace", () => ({
  createWorkspaceFolder: vi.fn(async () => undefined),
  deleteWorkspaceFile: vi.fn(async () => undefined),
  listWorkspace: vi.fn(async () => []),
  readWorkspaceFile: vi.fn(async () => ""),
  workspaceHasFile: vi.fn(async () => false),
  // The clone mirror asks these since #269 (safe git): nothing is in the vault yet.
  workspaceHasEntry: vi.fn(async () => false),
  readWorkspaceBlob: vi.fn(async () => new Blob([])),
  writeWorkspaceBlob: vi.fn(async (p: string) => {
    // What provenance says at the moment of each write.
    const { untrustedSourcesOfNote } = await import("../agents/provenance");
    expect(untrustedSourcesOfNote(p).length, `recorded before writing ${p}`).toBeGreaterThan(0);
    if (writes.length >= failAt) throw new DOMException("full", "QuotaExceededError");
    writes.push(p);
  }),
}));

// The mirror looks at the vault through its backend (#269): an empty vault.
vi.mock("../storage/vault", async (orig) => ({
  ...(await orig<typeof import("../storage/vault")>()),
  getVaultBackend: () => ({ stat: async () => null }),
}));

// A two-file checkout in a fake lightning-fs volume.
const tree: Record<string, string[] | string> = { "/git": ["team-notes"], "/git/team-notes": ["a.md", "b.md"], "/git/team-notes/a.md": "A", "/git/team-notes/b.md": "B" };
vi.mock("@isomorphic-git/lightning-fs", () => ({
  default: class {
    promises = {
      mkdir: async () => undefined,
      readdir: async (d: string) => (Array.isArray(tree[d]) ? tree[d] : []),
      stat: async (p: string) => ({ isDirectory: () => Array.isArray(tree[p]), isFile: () => typeof tree[p] === "string" }),
      readFile: async (p: string) => new TextEncoder().encode(String(tree[p])),
    };
  },
}));
// A pull fetches, then merges into the vault (#269, safe git): the fetch finds a new commit.
vi.mock("isomorphic-git", () => ({
  default: {
    clone: async () => undefined,
    currentBranch: async () => "main",
    fetch: async () => ({ fetchHead: "theirs" }),
    resolveRef: async () => "head",
  },
}));
// The merge itself (gitPull.test.ts covers it) writes the repo's two files through the vault the
// pull hands it; what is checked here is that the record is made before the first write.
vi.mock("../sync/gitPull", async (orig) => ({
  ...(await orig<typeof import("../sync/gitPull")>()),
  integrateFetched: async (o: { vault: { write: (path: string, data: Uint8Array) => Promise<void> } }) => {
    for (const f of ["a.md", "b.md"]) await o.vault.write(`team-notes/${f}`, new TextEncoder().encode(f));
    return { changedFiles: 2, deletedFiles: 0, upToDate: false, conflicts: [], keptDeletedUpstream: [], lfsSkipped: [], lfsPointers: [], copies: [], mergedIntoOpen: [], kindClashes: [], head: "theirs" };
  },
}));
vi.mock("isomorphic-git/http/web", () => ({ default: {} }));

beforeEach(() => {
  writes.length = 0;
  failAt = Infinity;
  localStorage.clear();
});

describe("git provenance", () => {
  it("clone: the repo folder is recorded before the first file, and stays recorded when the copy fails half way", async () => {
    failAt = 1;
    const { cloneRepo } = await import("../sync/git");
    await expect(cloneRepo("https://github.com/someone/team-notes.git", { token: "t" })).rejects.toThrow("full");
    // (The mirror names the folder with repoNameFromUrl, which yields "repo" for a bare name — a pre-existing quirk this test doesn't pin.)
    expect(writes).toHaveLength(1);
    const [written] = writes;
    const { untrustedSourcesOfNote } = await import("../agents/provenance");
    expect(untrustedSourcesOfNote(written)).toEqual([`cloned from git (${written})`]);
    // The file that was never written is covered too, by the folder record.
    expect(untrustedSourcesOfNote(written.replace("a.md", "b.md"))).toHaveLength(1);
  });

  it("pull: a repo with no record yet (cloned before the guard) is recorded before anything is written", async () => {
    const { pullRepo } = await import("../sync/git");
    await pullRepo("team-notes", { token: "t" });
    expect(writes).toEqual(["team-notes/a.md", "team-notes/b.md"]);
    const { untrustedSourcesOfNote } = await import("../agents/provenance");
    expect(untrustedSourcesOfNote("team-notes/b.md")).toEqual(["pulled from git (team-notes/b.md)"]);
  });

  it("backfill: clones made before the guard are recorded once, before provenance is used", async () => {
    vi.stubGlobal("indexedDB", { databases: async () => [{ name: "lumen-git" }] });
    vi.resetModules();
    const prov = await import("../agents/provenance");
    expect(prov.untrustedSourcesOfNote("team-notes/a.md")).toEqual([]);
    await prov.ensureProvenanceBackfill();
    expect(prov.untrustedSourcesOfNote("team-notes/a.md")).toEqual(["cloned from git (team-notes/a.md)"]);
    expect(localStorage.getItem("lumen.agents.provenanceBackfill.v1")).toBe("1");
    vi.unstubAllGlobals();
  });

  it("fails closed: when the record can't be stored, the clone stops before writing anything", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const { cloneRepo } = await import("../sync/git");
    await expect(cloneRepo("https://github.com/someone/team-notes.git", { token: "t" })).rejects.toThrow(/Can't record where these notes came from/);
    spy.mockRestore();
    expect(writes).toEqual([]);
  });

  it("fails closed: unreadable records make every note outside content", async () => {
    localStorage.setItem("lumen.agents.untrustedNotes", "{damaged");
    const { untrustedSourcesOfNote } = await import("../agents/provenance");
    expect(untrustedSourcesOfNote("notes/mine.md")).toEqual(["unknown origin: provenance records unreadable (notes/mine.md)"]);
  });

  it("imports made before the guard: everything under Imported/ is outside content by its path", async () => {
    const { untrustedSourcesOfNote } = await import("../agents/provenance");
    expect(untrustedSourcesOfNote("Imported/Old vault/n.md")).toEqual(["imported (Imported/Old vault/n.md)"]);
  });
});
