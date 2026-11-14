/**
 * W6.36 — regressions for review 19 of #585 (rr19):
 *  (y1) Y1: a note saved during a slow check is read again after the kept listing is reused;
 *  (y2) Y2: two vaults of the same kind: A's kept listing is never reused for B;
 *  (y3) a lock after the timeout drops the kept listing; after unlock the index lists afresh;
 *  (y4) the reuse path restores no text the listing didn't check;
 *  and the rest of rr19.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryBackend, setVaultBackend, type VaultBackend } from "../storage/vault";
import * as session from "../storage/vault/encrypted/session";
import { __resetWorkspaceIndex, __saveSnapshotNow, __setCheckBounds, ensureIndex, indexedNoteText, searchWorkspace } from "../storage/workspaceIndex";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { VaultIndex, localEngine } from "../storage/vaultIndexLocal";

const PASS = "a long enough passphrase";
const N = 6;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const engine = () => localEngine(new VaultIndex());
let previous: VaultBackend | null;

beforeEach(() => {
  session.setKdfPolicyForTests({ minPbkdf2Iterations: 1000, minArgon2CostKiB: 8, argon2: { memoryKiB: 8, iterations: 1, parallelism: 1 } });
  previous = setVaultBackend(null);
  __setCheckBounds({ checkMs: 400, viewMs: 200 });
});
afterEach(() => {
  session.lock();
  setVaultBackend(previous);
  __setCheckBounds();
  __resetWorkspaceIndex();
});
async function encVault(id: string, word: string): Promise<VaultBackend> {
  const b = createMemoryBackend({ id });
  for (let i = 0; i < N; i++) await b.write(`n${i}.md`, `# n${i}\n${word}-${i}`);
  setVaultBackend(b);
  await session.enableEncryption(PASS, { pbkdf2Iterations: 1000, confirmRecoveryKey: async () => true });
  return b;
}
/** The listing reads the vault at once (as a slow walk reads its early folders) and answers `ms` later. */
function slowList(b: VaultBackend, ms: number) {
  const list = b.list.bind(b);
  let count = 0;
  b.list = async (d) => {
    count++;
    const r = await list(d);
    await tick(ms);
    return r;
  };
  return { count: () => count, restore: () => (b.list = list) };
}

describe("W6.36 review 19: the kept listing and the vault's identity", () => {
  it("(y1) Y1: an edit made after the reused listing read the note is not lost", async () => {
    const E = await encVault("vault-Y1", "OLDTEXT");
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow();
    const s = slowList(E, 1200);
    try {
      __resetWorkspaceIndex(engine, { keepSnapshot: true });
      await ensureIndex(); // trusted open; the listing reads n3 now, answers in 1.2 s
      await tick(50);
      const { writeWorkspaceFile } = await import("../storage/workspace");
      await writeWorkspaceFile("n3.md", "# n3\nNEWTEXT-3, saved during the slow check"); // the user saves
      await tick(500); // the 400 ms check deadline passes: dropIndex (dirty cleared), the listing is kept
      const t = await indexedNoteText("n3.md"); // rebuild on the kept listing
      const later = await indexedNoteText("n3.md");
      console.log("  listings:", s.count(), "| n3 after the rebuild:", JSON.stringify(t), "| again:", JSON.stringify(later));
      expect(t).toContain("NEWTEXT");
    } finally {
      s.restore();
    }
  });

  it("(y2) Y2: two vaults with the same backend id: A's timed-out listing is not reused for B", async () => {
    const A = await encVault("desktop", "AWORD");
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow();
    const s = slowList(A, 1200);
    const B = createMemoryBackend({ id: "desktop" }); // switchDesktopVault: another folder, same id
    for (let i = 0; i < N; i++) await B.write(`b${i}.md`, `# b${i}\nBWORD-${i}`);
    try {
      __resetWorkspaceIndex(engine, { keepSnapshot: true });
      await ensureIndex();
      await tick(500); // the check times out on A's listing; it is kept, tagged "desktop"
      setVaultBackend(B);
      notifyWorkspaceChanged({ kind: "structure" });
      const hits = (await searchWorkspace("BWORD-2", { limit: 5 })).map((h) => h.path);
      console.log("  A listings:", s.count(), "| B search for its own note:", JSON.stringify(hits));
      expect(hits).toContain("b2.md");
    } finally {
      s.restore();
    }
  });

  it("(y3) a lock after the timeout drops the kept listing; after unlock the index lists afresh", async () => {
    const E = await encVault("vault-Y3", "LWORD");
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow();
    const s = slowList(E, 1200);
    try {
      __resetWorkspaceIndex(engine, { keepSnapshot: true });
      await ensureIndex();
      await tick(500);
      session.lock();
      const before = s.count();
      const q = searchWorkspace("LWORD-1", { limit: 5 });
      await tick(50);
      await session.unlock(PASS);
      const hits = (await q).map((h) => h.path);
      console.log("  listings before unlock:", before, "| after:", s.count(), "| hits:", JSON.stringify(hits));
      expect(s.count()).toBeGreaterThan(before);
      expect(hits).toContain("n1.md");
    } finally {
      s.restore();
    }
  });

  it("(y4) the reuse path takes no text the listing didn't check", async () => {
    const E = await encVault("vault-Y4", "CWORD");
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow();
    await tick();
    const { deleteWorkspaceFile, writeWorkspaceFile } = await import("../storage/workspace");
    await writeWorkspaceFile("n2.md", "edited before the open");
    await deleteWorkspaceFile("n4.md");
    const s = slowList(E, 1200);
    try {
      __resetWorkspaceIndex(engine, { keepSnapshot: true });
      await ensureIndex();
      await tick(500);
      const t2 = await indexedNoteText("n2.md");
      const t4 = await indexedNoteText("n4.md");
      console.log("  listings:", s.count(), "| n2:", JSON.stringify(t2), "| n4:", JSON.stringify(t4));
      expect(t2).toBe("edited before the open");
      expect(t4).toBeNull();
      expect(s.count()).toBe(1);
    } finally {
      s.restore();
    }
  });

  it("(y6) T1 with two vaults of the same backend id: plain P built, encrypted E read by refresh, back to P: nothing in the clear", async () => {
    const E = await encVault("desktop", "ESECRET");
    const P = createMemoryBackend({ id: "desktop" });
    for (let i = 0; i < N; i++) await P.write(`p${i}.md`, `# p${i}\nplainword-${i}`);
    setVaultBackend(P);
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    setVaultBackend(E);
    notifyWorkspaceChanged({ kind: "structure" });
    await ensureIndex();
    const eText = await indexedNoteText("n1.md");
    setVaultBackend(P);
    notifyWorkspaceChanged({ kind: "structure" });
    await __saveSnapshotNow();
    const { __snapshotRecord } = await import("../storage/indexSnapshot");
    const t = JSON.stringify((await __snapshotRecord()) ?? null);
    console.log("  E text indexed under the same id:", JSON.stringify(eText), "| ESECRET in clear:", /ESECRET/.test(t), "|", t.slice(0, 60));
    expect(/ESECRET/.test(t)).toBe(false);
  });
});
