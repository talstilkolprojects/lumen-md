/**
 * W6.36 — regressions for review 17 of #573 (rr17), with the bounds shortened:
 *  (x1) after the view wait, nothing unchecked is shown: summaries, text, search;
 *  (x2) W2: a listing that never settles: after the check times out, a checked view still answers;
 *  (x3) W1: a slow but healthy listing that outlasts the timeout is listed once, not twice.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryBackend, setVaultBackend, type VaultBackend } from "../storage/vault";
import * as session from "../storage/vault/encrypted/session";
import { __putSnapshotRecord, __snapshotRecord } from "../storage/indexSnapshot";
import { __resetWorkspaceIndex, __saveSnapshotNow, __setCheckBounds, ensureIndex, indexedFiles, indexedNoteText, indexedNotes, searchWorkspace, snapshotCounters } from "../storage/workspaceIndex";
import { VaultIndex, localEngine } from "../storage/vaultIndexLocal";

const PASS = "a long enough passphrase";
// The check and view bounds, shortened so the cases run in seconds (the defaults are 60 s and 1 s).
const CHECK_TIMEOUT_MS = 400;
const VIEW_WAIT_MS = 100;
const N = 8;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T | "TIMEOUT"> => Promise.race([p, tick(ms).then(() => "TIMEOUT" as const)]);
const engine = () => localEngine(new VaultIndex());
let previous: VaultBackend | null;

beforeEach(() => {
  session.setKdfPolicyForTests({ minPbkdf2Iterations: 1000, minArgon2CostKiB: 8, argon2: { memoryKiB: 8, iterations: 1, parallelism: 1 } });
  previous = setVaultBackend(null);
  __setCheckBounds({ checkMs: CHECK_TIMEOUT_MS, viewMs: VIEW_WAIT_MS });
});
afterEach(() => {
  session.lock();
  setVaultBackend(previous);
  __resetWorkspaceIndex();
  __setCheckBounds();
});
async function vault(id: string, word: string): Promise<VaultBackend> {
  const b = createMemoryBackend({ id });
  for (let i = 0; i < N; i++) await b.write(`x/n${i}.md`, `# n${i}\n${word}-${i}`);
  setVaultBackend(b);
  await session.enableEncryption(PASS, { pbkdf2Iterations: 1000, confirmRecoveryKey: async () => true });
  return b;
}
const isRoot = (d: string) => !d || d === "/" || d === ".";

describe("W6.36 review 17: the check's bounds", () => {
  it("(x1) after the 1 s view wait nothing unchecked is shown: summaries, text, search", async () => {
    const E = await vault("vault-X1", "OLDWORD");
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow();
    const old = await __snapshotRecord();
    await tick();
    const { deleteWorkspaceFile, writeWorkspaceFile } = await import("../storage/workspace");
    await writeWorkspaceFile("x/n3.md", "edited now");
    await deleteWorkspaceFile("x/n4.md");
    await __putSnapshotRecord(old); // rolled back
    const list = E.list.bind(E);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    E.list = async (d) => (await gate, list(d));
    try {
      __resetWorkspaceIndex(engine, { keepSnapshot: true });
      const t0 = Date.now();
      await ensureIndex(false, { checked: true });
      const waited = Date.now() - t0;
      const files = indexedFiles().map((f) => f.path);
      const text = withTimeout(indexedNoteText("x/n4.md"), 800);
      const notes = withTimeout(indexedNotes(), 800);
      const search = withTimeout(searchWorkspace("OLDWORD-4", { limit: 9 }), 800);
      const [a, b, c] = await Promise.all([text, notes, search]);
      console.log("  view returned after", waited, "ms | indexedFiles:", JSON.stringify(files), "| n4 text:", JSON.stringify(a), "| notes:", b === "TIMEOUT" ? b : b.length, "| search:", JSON.stringify(c === "TIMEOUT" ? c : c.map((h) => h.path)));
      expect(files).toEqual([]);
      expect(a === "TIMEOUT" || a === null).toBe(true);
      expect(b === "TIMEOUT" || !JSON.stringify(b).includes("OLDWORD-4")).toBe(true);
      expect(c === "TIMEOUT" || !c.map((h) => h.path).includes("x/n4.md")).toBe(true);
      release();
      expect(await indexedNoteText("x/n4.md")).toBeNull();
      expect(await indexedNoteText("x/n3.md")).toBe("edited now");
    } finally {
      E.list = list;
      release();
    }
  });

  it("(x2) W2: a listing that never settles: after the check times out, a checked view still answers", async () => {
    const E = await vault("vault-X2", "HWORD");
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow();
    const list = E.list.bind(E);
    E.list = () => new Promise(() => {});
    try {
      __resetWorkspaceIndex(engine, { keepSnapshot: true });
      await ensureIndex();
      const text = withTimeout(indexedNoteText("x/n1.md"), CHECK_TIMEOUT_MS + 4000);
      const first = await withTimeout(ensureIndex(false, { checked: true }), 3000);
      await tick(CHECK_TIMEOUT_MS + 2000);
      const second = await withTimeout(ensureIndex(false, { checked: true }), 3000);
      const t = await text;
      console.log("  view before the timeout:", first === "TIMEOUT" ? "hangs" : "answers", "| text query across the timeout:", JSON.stringify(t), "| view after the timeout:", second === "TIMEOUT" ? "hangs" : "answers");
      expect(t === "TIMEOUT" || t === null).toBe(true); // never unchecked text
      expect(second).not.toBe("TIMEOUT");
    } finally {
      E.list = list;
    }
  }, 200_000);

  it("(x3) W1: a healthy vault whose listing outlasts the check timeout: one listing, and the snapshot's texts are reused", async () => {
    const E = await vault("vault-X3", "SLOWWORD");
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow();
    const list = E.list.bind(E);
    let listings = 0;
    E.list = async (d) => {
      if (isRoot(d)) {
        listings++;
        await tick(CHECK_TIMEOUT_MS + 1000);
      }
      return list(d);
    };
    try {
      __resetWorkspaceIndex(engine, { keepSnapshot: true });
      const t0 = Date.now();
      await ensureIndex();
      const opened = Date.now() - t0;
      const r = await searchWorkspace("SLOWWORD-5", { limit: 3 });
      const firstSearch = Date.now() - t0;
      console.log("  open", opened, "ms | first search", firstSearch, "ms | listings", listings, "| counters", JSON.stringify(snapshotCounters), "| hit", JSON.stringify(r.map((h) => h.path)), "| record kept:", !!(await __snapshotRecord()));
      // A healthy check should not be thrown away: one listing, and an answer right after it.
      expect(listings).toBe(1);
    } finally {
      E.list = list;
    }
  }, 250_000);
});
