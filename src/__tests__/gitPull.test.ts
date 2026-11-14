/**
 * Plan 3.3 — safe git pull against a real isomorphic-git repository (on
 * the node file system in a temp folder) and an in-memory vault: a pull
 * merges three ways, marks conflicts, keeps every local file (0 deleted),
 * never overwrites a note with unsaved edits, and finds the merge base of
 * a shallow history by deepening.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as git from "isomorphic-git";
import { integrateFetched, NoMergeBaseError, type OpenNote, type PullDeps, type PullGit } from "../sync/gitPull";

const author = { name: "Test", email: "test@example.com" };
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

let dir: string;
let vault: Map<string, Uint8Array>;
let open: Map<string, OpenNote>;

function put(rel: string, text: string) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

/** Commit `files` (null = delete) on `ref`, with `parent`. */
async function commitOn(ref: string, parent: string[], files: Record<string, string | null>, message = "c"): Promise<string> {
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) {
      fs.rmSync(path.join(dir, rel), { force: true });
      await git.remove({ fs, dir, filepath: rel });
    } else {
      put(rel, text);
      await git.add({ fs, dir, filepath: rel });
    }
  }
  return git.commit({ fs, dir, message, author, ref, parent });
}

/** A repo with a base commit on main, and `vault` holding the same files under `r/`. */
async function setup(files: Record<string, string>): Promise<string> {
  await git.init({ fs, dir, defaultBranch: "main" });
  for (const [rel, text] of Object.entries(files)) {
    put(rel, text);
    await git.add({ fs, dir, filepath: rel });
    vault.set(`r/${rel}`, enc(text));
  }
  return git.commit({ fs, dir, message: "base", author });
}

/** The remote moved on: a commit on refs/remotes/origin/main. Main's work tree is restored. */
async function remote(base: string, files: Record<string, string | null>): Promise<string> {
  const oid = await commitOn("refs/remotes/origin/main", [base], files, "remote");
  await git.checkout({ fs, dir, ref: "main", force: true });
  return oid;
}

function deps(theirs: string, extra: Partial<PullDeps> = {}): PullDeps {
  return {
    git: git as unknown as PullGit,
    fs,
    dir,
    repoFolder: "r",
    theirs,
    author,
    vault: {
      read: async (p) => vault.get(p) ?? null,
      write: async (p, d) => void vault.set(p, d),
      exists: async (p) => vault.has(p) || [...vault.keys()].some((k) => k.startsWith(`${p}/`)),
      kind: async (p) => (vault.has(p) ? "file" : [...vault.keys()].some((k) => k.startsWith(`${p}/`)) ? "directory" : null),
    },
    openNote: (p) => open.get(p) ?? null,
    setOpenNote: (p, text) => void open.set(p, { content: text, dirty: true }),
    ...extra,
  };
}

const text = (p: string) => (vault.has(p) ? dec(vault.get(p)!) : null);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-safe-git-"));
  vault = new Map();
  open = new Map();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("safe pull", () => {
  it("brings in upstream changes and deletes nothing — not even files deleted upstream", async () => {
    const base = await setup({ "a.md": "a", "gone.md": "bye", "sub/s.md": "s" });
    vault.set("r/untracked.md", enc("mine, never committed"));
    const before = new Set(vault.keys());
    const theirs = await remote(base, { "a.md": "a2", "gone.md": null, "sub/s.md": null, "new.md": "new" });

    const r = await integrateFetched(deps(theirs));

    expect(r.deletedFiles).toBe(0);
    for (const p of before) expect(vault.has(p), p).toBe(true); // 0 files deleted on pull
    expect(text("r/a.md")).toBe("a2");
    expect(text("r/new.md")).toBe("new");
    expect(text("r/gone.md")).toBe("bye");
    expect(text("r/untracked.md")).toBe("mine, never committed");
    expect(r.keptDeletedUpstream.sort()).toEqual(["r/gone.md", "r/sub/s.md"]);
    expect(r.conflicts).toEqual([]);
    // The mirror fast-forwarded to the remote commit.
    expect(await git.resolveRef({ fs, dir, ref: "main" })).toBe(theirs);
  });

  it("merges a file both sides changed on different lines", async () => {
    const base = await setup({ "n.md": "1\n2\n3\n4\n5" });
    vault.set("r/n.md", enc("one\n2\n3\n4\n5"));
    const theirs = await remote(base, { "n.md": "1\n2\n3\n4\nfive" });
    const r = await integrateFetched(deps(theirs));
    expect(text("r/n.md")).toBe("one\n2\n3\n4\nfive");
    expect(r.conflicts).toEqual([]);
  });

  it("marks overlapping edits with conflict markers, keeping both versions", async () => {
    const base = await setup({ "c.md": "x\ny\nz" });
    vault.set("r/c.md", enc("x\nLOCAL\nz"));
    const theirs = await remote(base, { "c.md": "x\nREMOTE\nz" });
    const snaps: string[] = [];
    const r = await integrateFetched(deps(theirs, { snapshot: async (_p, t) => void snaps.push(t) }));
    expect(text("r/c.md")).toBe("x\n<<<<<<< local\nLOCAL\n=======\nREMOTE\n>>>>>>> remote\nz");
    expect(r.conflicts).toEqual([{ path: "r/c.md", base: "x\ny\nz", ours: "x\nLOCAL\nz", theirs: "x\nREMOTE\nz", where: "file" }]);
    // What the file held before is in the history.
    expect(snaps).toEqual(["x\nLOCAL\nz"]);
  });

  it("never writes over a note open with unsaved edits", async () => {
    const base = await setup({ "open.md": "a\nb\nc", "clash.md": "1\n2\n3" });
    open.set("r/open.md", { content: "A\nb\nc", dirty: true });
    open.set("r/clash.md", { content: "1\nmine\n3", dirty: true });
    const theirs = await remote(base, { "open.md": "a\nb\nC", "clash.md": "1\ntheirs\n3" });
    const r = await integrateFetched(deps(theirs));

    // Clean merge → into the editor, still unsaved; the file is untouched.
    expect(open.get("r/open.md")).toEqual({ content: "A\nb\nC", dirty: true });
    expect(text("r/open.md")).toBe("a\nb\nc");
    expect(r.mergedIntoOpen).toEqual(["r/open.md"]);
    // Conflict → the note is left as it is; theirs waits in a copy.
    expect(open.get("r/clash.md")).toEqual({ content: "1\nmine\n3", dirty: true });
    expect(text("r/clash.md")).toBe("1\n2\n3");
    const copy = r.conflicts[0].copy!;
    expect(r.conflicts[0]).toMatchObject({ path: "r/clash.md", where: "open" });
    expect(copy).toMatch(/^r\/clash \(git [0-9a-f]{7}\)\.md$/);
    expect(text(copy)).toBe("1\ntheirs\n3");
  });

  it("records a merge commit when there are local commits, so the next push fast-forwards", async () => {
    const base = await setup({ "a.md": "a", "b.md": "b" });
    const local = await commitOn("refs/heads/main", [base], { "a.md": "a-local" }, "local");
    vault.set("r/a.md", enc("a-local"));
    const theirs = await remote(base, { "b.md": "b-remote" });
    const r = await integrateFetched(deps(theirs));
    const head = await git.readCommit({ fs, dir, oid: r.head });
    expect(head.commit.parent).toEqual([local, theirs]);
    expect(text("r/a.md")).toBe("a-local");
    expect(text("r/b.md")).toBe("b-remote");
    // A second pull has nothing to do.
    expect((await integrateFetched(deps(theirs))).upToDate).toBe(true);
  });

  it("records the merge even when a file was deleted here and changed upstream", async () => {
    const base = await setup({ "a.md": "a", "d.md": "d" });
    const local = await commitOn("refs/heads/main", [base], { "d.md": null }, "delete locally");
    vault.delete("r/d.md");
    const theirs = await remote(base, { "d.md": "d changed" });
    const r = await integrateFetched(deps(theirs));
    expect(text("r/d.md")).toBe("d changed");
    expect((await git.readCommit({ fs, dir, oid: r.head })).commit.parent).toEqual([local, theirs]);
  });

  it("does not replace a real file with a Git LFS pointer", async () => {
    const base = await setup({ "big.psd": "REAL BYTES" });
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"b".repeat(64)}\nsize 99\n`;
    const theirs = await remote(base, { "big.psd": pointer });
    const r = await integrateFetched(deps(theirs));
    expect(text("r/big.psd")).toBe("REAL BYTES");
    expect(r.lfsSkipped).toEqual(["r/big.psd"]);
  });

  it("deepens a shallow history until the merge base is found", async () => {
    const base = await setup({ "a.md": "a" });
    const theirs = await remote(base, { "a.md": "a2" });
    // A shallow clone: no merge base until enough history was fetched.
    let fetched = 0;
    const steps: Array<{ depth: number; full: boolean }> = [];
    const shallowGit = {
      ...(git as unknown as PullGit),
      findMergeBase: async (o: Record<string, unknown>) => (fetched >= 2 ? git.findMergeBase(o as never) : []),
    };
    const r = await integrateFetched(
      deps(theirs, {
        git: shallowGit,
        deepen: async (step) => {
          steps.push(step);
          fetched++;
        },
      }),
    );
    expect(steps).toEqual([
      { depth: 50, full: false },
      { depth: 500, full: false },
    ]);
    expect(text("r/a.md")).toBe("a2");
    expect(r.deletedFiles).toBe(0);
  });

  it("asks for the full history last, and stops with a clear error when there is still no common commit", async () => {
    const base = await setup({ "a.md": "a" });
    const theirs = await remote(base, { "a.md": "a2" });
    const steps: Array<{ depth: number; full: boolean }> = [];
    const noBase = { ...(git as unknown as PullGit), findMergeBase: async () => [] };
    await expect(integrateFetched(deps(theirs, { git: noBase, deepen: async (s) => void steps.push(s) }))).rejects.toBeInstanceOf(NoMergeBaseError);
    expect(steps.at(-1)).toEqual({ depth: 0, full: true });
    expect(text("r/a.md")).toBe("a"); // nothing written
  });

  it("a delete on one side against an edit on the other is a conflict, not a silent merge", async () => {
    const base = await setup({ "d.md": "a\nb\nc" });
    vault.set("r/d.md", enc("a\nc"));
    const theirs = await remote(base, { "d.md": "a\nB\nc" });
    const r = await integrateFetched(deps(theirs));
    expect(r.conflicts.map((c) => c.path)).toEqual(["r/d.md"]);
    expect(text("r/d.md")).toBe("a\n<<<<<<< local\n=======\nB\n>>>>>>> remote\nc");
  });

  it("a vault read that fails stops the pull before anything is written", async () => {
    const base = await setup({ "a.md": "a", "b.md": "b" });
    vault.set("r/a.md", enc("local a"));
    const theirs = await remote(base, { "a.md": "remote a", "b.md": "remote b" });
    const d = deps(theirs);
    const read = d.vault.read;
    d.vault.read = async (p) => {
      if (p === "r/b.md") throw new Error("storage busy");
      return read(p);
    };
    await expect(integrateFetched(d)).rejects.toThrow("storage busy");
    expect(text("r/a.md")).toBe("local a");
    expect(text("r/b.md")).toBe("b");
  });

  it("a file that became a folder upstream (or the reverse) is left as it is and reported", async () => {
    const base = await setup({ "x.md": "file", "keep.md": "k" });
    const theirs = await remote(base, { "x.md": null, "x.md/inner.md": "inside", "keep.md": "k2" });
    const r = await integrateFetched(deps(theirs));
    expect(r.kindClashes).toEqual(["r/x.md/inner.md"]);
    expect(text("r/x.md")).toBe("file");
    expect(text("r/keep.md")).toBe("k2");
    expect(r.deletedFiles).toBe(0);
  });

  it("is a no-op when already up to date", async () => {
    const base = await setup({ "a.md": "a" });
    const r = await integrateFetched(deps(base));
    expect(r.upToDate).toBe(true);
    expect(r.changedFiles).toBe(0);
  });
});
