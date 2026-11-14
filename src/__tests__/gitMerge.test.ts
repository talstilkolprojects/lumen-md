/**
 * Plan 3.3 — safe git pull, the pure planner: a pull merges three ways,
 * marks conflicts, and never deletes anything in the vault.
 */
import { describe, expect, it } from "vitest";
import {
  copyPathFor,
  hasConflictMarkers,
  isBinary,
  isLfsPointer,
  mergeHunks,
  mergeText,
  planPull,
  type PullAction,
} from "../sync/gitMerge";

const enc = (s: string | null) => (s === null ? null : new TextEncoder().encode(s));
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const LFS = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 12345\n`;

function plan(entries: Array<[string, string | null, string | null, string | null]>): PullAction[] {
  return planPull(entries.map(([path, base, ours, theirs]) => ({ path, base: enc(base), ours: enc(ours), theirs: enc(theirs) })));
}

describe("mergeText", () => {
  it("takes changes made on different lines from both sides", () => {
    const r = mergeText("a\nb\nc\nd\ne", "A\nb\nc\nd\ne", "a\nb\nc\nd\nE");
    expect(r).toEqual({ clean: true, text: "A\nb\nc\nd\nE" });
  });

  it("marks different edits of the same line as a conflict, keeping both", () => {
    const r = mergeText("a\nb\nc", "a\nmine\nc", "a\ntheirs\nc", { ours: "local", theirs: "origin/main" });
    expect(r.clean).toBe(false);
    expect(r.text).toBe("a\n<<<<<<< local\nmine\n=======\ntheirs\n>>>>>>> origin/main\nc");
    expect(hasConflictMarkers(r.text)).toBe(true);
  });

  it("takes the same change made on both sides once", () => {
    expect(mergeText("a\nb", "a\nB", "a\nB")).toEqual({ clean: true, text: "a\nB" });
  });

  it("a deletion on one side against an edit of the same line is a conflict (both ways)", () => {
    expect(mergeText("a\nb\nc", "a\nc", "a\nB\nc")).toEqual({ clean: false, text: "a\n<<<<<<< local\n=======\nB\n>>>>>>> remote\nc" });
    expect(mergeText("a\nb\nc", "a\nB\nc", "a\nc").clean).toBe(false);
  });

  it("gives the conflict dialog a conflict hunk for a deletion against an edit", () => {
    const hunks = mergeHunks("a\nb\nc", "a\nc", "a\nB\nc");
    expect(hunks.map((h) => [h.op, h.local, h.remote])).toEqual([
      ["equal", ["a"], ["a"]],
      ["conflict", [], ["B"]],
      ["equal", ["c"], ["c"]],
    ]);
  });

  it("inserts at different places merge cleanly", () => {
    expect(mergeText("a\nb\nc", "a\nb\nc\nL", "X\na\nb\nc")).toEqual({ clean: true, text: "X\na\nb\nc\nL" });
  });

  it("works on Hebrew text", () => {
    const r = mergeText("שלום\nעולם\nסוף", "שלום רב\nעולם\nסוף", "שלום\nעולם\nסוף טוב");
    expect(r).toEqual({ clean: true, text: "שלום רב\nעולם\nסוף טוב" });
  });
});

describe("planPull", () => {
  it("never deletes: a file removed upstream stays in the vault", () => {
    const actions = plan([["notes/keep.md", "x", "x", null]]);
    expect(actions).toEqual([{ kind: "keptDeletedUpstream", path: "notes/keep.md" }]);
    expect(actions.some((a) => (a.kind as string) === "delete")).toBe(false);
  });

  it("does not touch files the remote did not change (local edits, untracked files)", () => {
    expect(plan([["mine.md", "base", "my edit", "base"]])).toEqual([]);
  });

  it("writes new and fast-forwarded files", () => {
    const actions = plan([
      ["new.md", null, null, "from upstream"],
      ["same.md", "old", "old", "new"],
    ]);
    expect(actions.map((a) => [a.kind, a.path, a.kind === "write" ? dec(a.data) : ""])).toEqual([
      ["write", "new.md", "from upstream"],
      ["write", "same.md", "new"],
    ]);
  });

  it("does nothing when both sides already agree", () => {
    expect(plan([["a.md", "old", "new", "new"]])).toEqual([]);
  });

  it("merges a file changed on both sides when the edits do not overlap", () => {
    const [a] = plan([["m.md", "1\n2\n3\n4\n5", "one\n2\n3\n4\n5", "1\n2\n3\n4\nfive"]]);
    expect(a.kind).toBe("write");
    if (a.kind === "write") {
      expect(a.why).toBe("merged");
      expect(dec(a.data)).toBe("one\n2\n3\n4\nfive");
    }
  });

  it("reports overlapping edits as a conflict with all three versions", () => {
    const [a] = plan([["c.md", "a\nb\nc", "a\nmine\nc", "a\ntheirs\nc"]]);
    expect(a.kind).toBe("conflict");
    if (a.kind === "conflict") {
      expect([a.base, a.ours, a.theirs]).toEqual(["a\nb\nc", "a\nmine\nc", "a\ntheirs\nc"]);
      expect(hasConflictMarkers(a.marked)).toBe(true);
      expect(a.marked).toContain("mine");
      expect(a.marked).toContain("theirs");
    }
  });

  it("an untracked local file and a new upstream file of the same name: conflict, not overwrite", () => {
    const [a] = plan([["clash.md", null, "my own file", "their new file"]]);
    expect(a.kind).toBe("conflict");
  });

  it("brings back a file deleted here but changed upstream (nothing local to lose)", () => {
    const [a] = plan([["gone.md", "old", null, "changed upstream"]]);
    expect(a).toMatchObject({ kind: "write", path: "gone.md", why: "restored" });
  });

  it("never merges binary files: ours stays, theirs goes to a copy", () => {
    const actions = planPull([
      { path: "img.png", base: new Uint8Array([0, 1]), ours: new Uint8Array([0, 2]), theirs: new Uint8Array([0, 3]) },
    ]);
    expect(actions).toEqual([{ kind: "binaryConflict", path: "img.png", theirs: new Uint8Array([0, 3]) }]);
  });

  it("does not replace a real file with a Git LFS pointer", () => {
    expect(plan([["big.psd", "real", "real", LFS]])).toEqual([{ kind: "lfsSkipped", path: "big.psd" }]);
  });

  it("writes an LFS pointer only where nothing was, and flags it", () => {
    const [a] = plan([["new.bin", null, null, LFS]]);
    expect(a).toMatchObject({ kind: "write", lfs: true });
  });
});

describe("helpers", () => {
  it("recognises LFS pointers and nothing else", () => {
    expect(isLfsPointer(LFS)).toBe(true);
    expect(isLfsPointer(enc(LFS))).toBe(true);
    expect(isLfsPointer("version https://git-lfs.github.com/spec/v1\n")).toBe(false);
    // The full structure: exact version line, oid and size.
    expect(isLfsPointer(`version https://git-lfs.github.com/spec/v1-not-a-pointer\noid sha256:${"a".repeat(64)}\nsize 1\n`)).toBe(false);
    expect(isLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\n`)).toBe(false);
    expect(isLfsPointer("# notes")).toBe(false);
    expect(isLfsPointer(null)).toBe(false);
  });

  it("tells binary from text (UTF-8, Hebrew included)", () => {
    expect(isBinary(new Uint8Array([104, 0, 105]))).toBe(true);
    expect(isBinary(new Uint8Array([0xff, 0xfe, 0x41]))).toBe(true);
    expect(isBinary(enc("שלום, world")!)).toBe(false);
  });

  it("names the copy next to the file", () => {
    expect(copyPathFor("notes/a.md", "from git abc1234")).toBe("notes/a (from git abc1234).md");
    expect(copyPathFor("README", "x")).toBe("README (x)");
    expect(copyPathFor(".gitignore", "x")).toBe(".gitignore (x)");
  });

  it("finds unresolved conflict markers only as whole lines", () => {
    expect(hasConflictMarkers("<<<<<<< local\na\n=======\nb\n>>>>>>> remote")).toBe(true);
    expect(hasConflictMarkers("a\n=======\nb")).toBe(false);
    expect(hasConflictMarkers("text <<<<<<< inline")).toBe(false);
    expect(hasConflictMarkers(">>>>>>> x\n=======\n<<<<<<< y")).toBe(false);
  });
});
