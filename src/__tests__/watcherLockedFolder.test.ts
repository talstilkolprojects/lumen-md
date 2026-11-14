// Review t5 (L1): one sub-folder that can never be listed (EACCES) stopped every external-change check.
// Adopted with the fix: the root failing still rejects; a sub-folder rejects while its failure may be
// passing, and once it has failed SKIP_AFTER times in a row it is skipped, keeping its last entries.
import { describe, expect, it } from "vitest";
import { listSnapshot, SKIP_AFTER, watchExternalChanges, type Snapshot } from "../storage/vault/watcher";
import { VaultError } from "../storage/vault/types";

const backend = {
  async list(dir: string) {
    if (dir === "") return [
      { name: "a.md", path: "a.md", kind: "file", size: 3, mtime: 1 },
      { name: "locked", path: "locked", kind: "directory" },
    ];
    if (dir === "locked") throw new VaultError("EACCES" as never, "locked", "permission denied");
    return [];
  },
} as never;

describe("listSnapshot with an unreadable sub-folder (review t5)", () => {
  it("still lists the rest of the vault", async () => {
    const snap = await listSnapshot(backend);
    expect([...snap.keys()]).toContain("a.md");
  });

  it("the root failing still rejects", async () => {
    const root = { list: async () => Promise.reject(new VaultError("EACCES" as never, "", "denied")) } as never;
    await expect(listSnapshot(root)).rejects.toThrow("denied");
    await expect(listSnapshot(root, { failures: new Map(), skipAfter: 1 })).rejects.toThrow("denied");
  });

  it("with a failure count: rejects until the folder failed SKIP_AFTER times in a row, then keeps its last entries", async () => {
    const prev: Snapshot = new Map([
      ["a.md", { size: 3, mtime: 1 }],
      ["locked/x.md", { size: 5, mtime: 7 }],
      ["lockedness.md", { size: 1, mtime: 1 }],
    ]);
    const failures = new Map<string, number>();
    const skipped: string[] = [];
    for (let i = 1; i < SKIP_AFTER; i++) await expect(listSnapshot(backend, { prev, failures, onSkip: (d) => skipped.push(d) })).rejects.toThrow("permission denied");
    const snap = await listSnapshot(backend, { prev, failures, onSkip: (d) => skipped.push(d) });
    expect([...snap.keys()].sort()).toEqual(["a.md", "locked/x.md"]);
    expect(skipped).toEqual(["locked"]);
  });
});

describe("the watcher with a sub-folder that never lists (review t5)", () => {
  it("reports no mass delete, keeps reporting changes elsewhere, and warns once", async () => {
    let locked = false;
    let aSize = 3;
    const events: unknown[] = [];
    const warned: string[] = [];
    const b = {
      async list(dir: string) {
        if (dir === "") return [
          { name: "a.md", path: "a.md", kind: "file", size: aSize, mtime: 1 },
          { name: "sub", path: "sub", kind: "directory" },
        ];
        if (dir === "sub") {
          if (locked) throw new VaultError("EACCES" as never, "sub", "permission denied");
          return [{ name: "x.md", path: "sub/x.md", kind: "file", size: 5, mtime: 7 }];
        }
        return [];
      },
      watch: () => () => undefined,
      stat: async () => null,
      notifyExternal: (e: unknown) => events.push(e),
    } as never;
    const stop = watchExternalChanges(b, { intervalMs: 5, onUnreadable: (d) => warned.push(d) });
    const tick = () => new Promise((r) => setTimeout(r, 40));
    try {
      await tick(); // the baseline, with sub/x.md
      locked = true;
      for (let i = 0; i < SKIP_AFTER + 4; i++) await tick();
      aSize = 4; // an edit outside the locked folder
      await tick();
      await tick();
      expect(events).toEqual([{ type: "write", path: "a.md" }]);
      expect(warned).toEqual(["sub"]);
    } finally {
      stop();
    }
  });
});
