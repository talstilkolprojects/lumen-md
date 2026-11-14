/**
 * Codex P1s on #269 (plan 3.3):
 *  - a commit never writes the vault's real file over a Git LFS pointer the
 *    mirror holds (the pull kept the real file; committing it would push the
 *    whole object as a blob);
 *  - every open note with unsaved edits is saved before the commit reads the
 *    vault — a pull puts merges into inactive dirty tabs, which autosave
 *    never writes — and a note that cannot be saved stays out of the commit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeIntoMirror } from "../sync/gitMirror";
import { LFS_POINTER_PREFIX } from "../sync/gitMerge";

const enc = (s: string) => new TextEncoder().encode(s);
const POINTER = `${LFS_POINTER_PREFIX}\noid sha256:${"a".repeat(64)}\nsize 12\n`;

describe("writeIntoMirror keeps LFS pointers", () => {
  let dir: string;
  beforeEach(() => {
    dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "lumen-lfs-"));
  });
  afterEach(() => nodeFs.rmSync(dir, { recursive: true, force: true }));

  it("the vault's real file does not replace the mirror's pointer, and is reported", async () => {
    nodeFs.writeFileSync(path.join(dir, "big.bin"), POINTER);
    nodeFs.writeFileSync(path.join(dir, "note.md"), "old");
    const r = await writeIntoMirror(nodeFs, dir, [
      { relative: "big.bin", bytes: enc("real bytes here") },
      { relative: "note.md", bytes: enc("new") },
    ]);
    expect(r).toEqual({ skipped: [], lfsKept: ["big.bin"] });
    expect(nodeFs.readFileSync(path.join(dir, "big.bin"), "utf8")).toBe(POINTER);
    expect(nodeFs.readFileSync(path.join(dir, "note.md"), "utf8")).toBe("new");
  });

  it("a pointer over a pointer, or a real file where the mirror has none, is written", async () => {
    nodeFs.writeFileSync(path.join(dir, "big.bin"), POINTER);
    const other = POINTER.replace("a".repeat(64), "b".repeat(64));
    const r = await writeIntoMirror(nodeFs, dir, [
      { relative: "big.bin", bytes: enc(other) },
      { relative: "fresh.bin", bytes: enc("real") },
    ]);
    expect(r).toEqual({ skipped: [], lfsKept: [] });
    expect(nodeFs.readFileSync(path.join(dir, "big.bin"), "utf8")).toBe(other);
    expect(nodeFs.readFileSync(path.join(dir, "fresh.bin"), "utf8")).toBe("real");
  });
});

// ── commitAndPush: flush first, leave out what could not be saved ──────────
const written: string[] = [];
const vault = new Map<string, string>([
  ["repo/a.md", "a on disk"],
  ["repo/b.md", "b on disk"],
  ["repo/big.bin", "real bytes here"],
]);
vi.mock("idb-keyval", () => ({ get: async () => undefined, set: async () => undefined, del: async () => undefined }));
vi.mock("../storage/workspace", () => ({
  createWorkspaceFolder: vi.fn(),
  listWorkspace: async () => [...vault.keys()].map((p) => ({ path: p, name: p.split("/").pop()!, size: 1, modified: 1 })),
  readWorkspaceBlob: async (p: string) => new Blob([vault.get(p) ?? ""]),
  workspaceHasEntry: async () => false,
  writeWorkspaceBlob: vi.fn(),
}));
vi.mock("../storage/vault", () => ({ getVaultBackend: () => ({ stat: async (p: string) => (vault.has(p) ? { kind: "file" } : null) }) }));
const mirror = new Map<string, string>([["/git/repo/big.bin", POINTER]]);
vi.mock("@isomorphic-git/lightning-fs", () => ({
  default: class {
    promises = {
      mkdir: async () => undefined,
      readdir: async () => [],
      stat: async (p: string) => {
        if (mirror.has(p)) return { isDirectory: () => false, isFile: () => true };
        throw new Error("ENOENT");
      },
      readFile: async (p: string) => new TextEncoder().encode(mirror.get(p) ?? ""),
      writeFile: async (p: string, d: Uint8Array) => {
        written.push(p);
        mirror.set(p, new TextDecoder().decode(d));
      },
    };
  },
}));
vi.mock("isomorphic-git", () => ({ default: { add: async () => undefined, commit: async () => "sha", push: async () => undefined } }));
vi.mock("isomorphic-git/http/web", () => ({ default: {} }));

describe("commitAndPush", () => {
  it("saves open notes first, leaves out the ones that could not be saved, and keeps LFS pointers", async () => {
    const { commitAndPush } = await import("../sync/git");
    const flush = vi.fn(async () => ["repo/a.md", "other/x.md"]);
    const r = await commitAndPush("repo", "msg", { name: "n", email: "e" }, { token: "t", flushOpenNotes: flush });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ skipped: [], lfsKept: ["repo/big.bin"], unsaved: ["repo/a.md"] });
    expect(written).toEqual(["/git/repo/b.md"]); // a.md left out, big.bin kept as its pointer
    expect(mirror.get("/git/repo/big.bin")).toBe(POINTER);
  });
});
