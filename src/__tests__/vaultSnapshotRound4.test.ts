/**
 * W6.36 — regressions for the approval review of #529 / #560 (review 15,
 * rr15). Each case asserts the secure (or live) outcome:
 *  (u5) V3: a trusted open whose listing never answers: a view that lists notes does not hang;
 *  (u6) T7: during the check indexedFiles() is empty, and indexVersion() moves after it;
 *  (u7) V1: a plain record written before sizes is not trusted on the mtime alone;
 *  (u7b) a sealed v2 manifest without sizes is refused: every note read;
 *  and u1–u3 (U2). Not here: u8 (same mtime and size, new content), accepted as inherent (V2).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryBackend, setVaultBackend, type VaultBackend } from "../storage/vault";
import * as session from "../storage/vault/encrypted/session";
import { restSnapshotKeys } from "../storage/vault/restStore";
import { sealSnapshot } from "../storage/snapshotSeal";
import { __putSnapshotRecord, __snapshotRecord } from "../storage/indexSnapshot";
import { summarize } from "../storage/noteSummary";
import { __resetWorkspaceIndex, __saveSnapshotNow, ensureIndex, indexChecked, indexedFiles, indexedNoteText, indexVersion, searchWorkspace, snapshotCounters } from "../storage/workspaceIndex";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { VaultIndex, localEngine } from "../storage/vaultIndexLocal";
import type { IndexEngine } from "../storage/vaultIndexProtocol";

const PASS = "a long enough passphrase";
const N = 8;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T,>(p: Promise<T>, ms = 2000): Promise<T | "TIMEOUT"> => Promise.race([p, tick(ms).then(() => "TIMEOUT" as const)]);
let previous: VaultBackend | null;
let clears = 0;
const engine = (): IndexEngine => {
  const e = localEngine(new VaultIndex());
  return { ...e, clear: () => ((clears++), e.clear()) };
};

beforeEach(() => {
  session.setKdfPolicyForTests({ minPbkdf2Iterations: 1000, minArgon2CostKiB: 8, argon2: { memoryKiB: 8, iterations: 1, parallelism: 1 } });
  previous = setVaultBackend(null);
  clears = 0;
});
afterEach(() => {
  session.lock();
  setVaultBackend(previous);
  __resetWorkspaceIndex();
});
const notes = (prefix: string, word: string) => async (b: VaultBackend) => {
  for (let i = 0; i < N; i++) await b.write(`${prefix}/n${i}.md`, `# ${prefix} ${i}\n${word}-${i}`);
};
async function encryptedVault(id: string, write: (b: VaultBackend) => Promise<void>, now?: () => number): Promise<VaultBackend> {
  const b = createMemoryBackend({ id, ...(now ? { now } : {}) });
  await write(b);
  setVaultBackend(b);
  await session.enableEncryption(PASS, { pbkdf2Iterations: 1000, confirmRecoveryKey: async () => true });
  return b;
}
const paths = (r: unknown) => (r === "TIMEOUT" ? "TIMEOUT" : (r as { path: string }[]).map((h) => h.path));

describe("W6.36 review 15-560 U2: the wait for unlock", () => {
  it("(u1) lock -> switch -> query -> switch back -> unlock", async () => {
    const E = await encryptedVault("vault-E", notes("e", "ESECRET"));
    await __saveSnapshotNow().catch(() => undefined);
    session.lock();
    __resetWorkspaceIndex(engine, { keepSnapshot: true });
    void ensureIndex(); // waits for unlock
    await tick(20);
    const P = createMemoryBackend({ id: "vault-P" });
    await notes("p", "plainword")(P);
    setVaultBackend(P);
    notifyWorkspaceChanged({ kind: "structure" });
    const onP = await withTimeout(searchWorkspace("plainword-3", { limit: 5 }));
    setVaultBackend(E);
    notifyWorkspaceChanged({ kind: "structure" });
    const pendingE = withTimeout(searchWorkspace("ESECRET-2", { limit: 5 }), 4000);
    await tick(50);
    await session.unlock(PASS);
    const onE = await pendingE;
    const anyP = await withTimeout(searchWorkspace("plainword", { limit: 50 }));
    console.log("  on P:", JSON.stringify(paths(onP)), "| on E after unlock:", JSON.stringify(paths(onE)), "| P notes on E:", JSON.stringify(paths(anyP)));
    expect(paths(onP)).toContain("p/n3.md");
    expect(paths(onE)).toContain("e/n2.md");
    expect(paths(anyP)).toEqual([]);
  });

  it("(u2) a storm of ensureIndex / search / checked views while locked, then unlock", async () => {
    await encryptedVault("vault-S", notes("s", "SSECRET"));
    session.lock();
    __resetWorkspaceIndex(engine);
    const all: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i++) all.push(ensureIndex(), searchWorkspace(`SSECRET-${i % N}`, { limit: 3 }), ensureIndex(false, { checked: true }));
    for (let i = 0; i < 20; i++) notifyWorkspaceChanged({ kind: "structure" });
    await tick(100);
    let settledEarly = 0;
    for (const p of all) void p.then(() => settledEarly++, () => settledEarly++);
    await tick(10);
    const early = settledEarly;
    await session.unlock(PASS);
    const r = await withTimeout(Promise.allSettled(all), 5000);
    const ok = r === "TIMEOUT" ? -1 : r.filter((x) => x.status === "fulfilled").length;
    const hits = await searchWorkspace("SSECRET-5", { limit: 3 });
    console.log("  settled before unlock:", early, "| after unlock fulfilled:", ok, "/", all.length, "| engine clears:", clears, "| hit:", JSON.stringify(paths(hits)));
    expect(early).toBe(0);
    expect(ok).toBe(all.length);
    expect(paths(hits)).toContain("s/n5.md");
  });

  it("(u3) drops (lock events) and structural events during the wait, then unlock", async () => {
    await encryptedVault("vault-D", notes("d", "DSECRET"));
    session.lock();
    __resetWorkspaceIndex(engine);
    const q = withTimeout(searchWorkspace("DSECRET-1", { limit: 3 }), 5000);
    for (let i = 0; i < 5; i++) {
      await tick(10);
      window.dispatchEvent(new CustomEvent("lumen-vault-locked"));
      notifyWorkspaceChanged({ kind: "structure" });
    }
    await session.unlock(PASS);
    const r = await q;
    console.log("  after drops + unlock:", JSON.stringify(paths(r)));
    expect(paths(r)).toContain("d/n1.md");
  });
});

describe("W6.36 review 15-560 T7 and S3", () => {
  it("(u5) V3: a trusted open whose listing never answers: a checked view does not hang", async () => {
    const E = await encryptedVault("vault-H", notes("h", "HWORD"));
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow();
    const list = E.list.bind(E);
    E.list = () => new Promise(() => {});
    try {
      __resetWorkspaceIndex(engine, { keepSnapshot: true });
      await ensureIndex();
      const v = await withTimeout(ensureIndex(false, { checked: true }), 1500);
      console.log("  checked view with a listing that never answers:", v === "TIMEOUT" ? "hangs" : "answers", "| indexedFiles:", indexedFiles().length);
      expect(v).not.toBe("TIMEOUT");
    } finally {
      E.list = list;
    }
  });

  it("(u6) during the check indexedFiles() is empty, and indexVersion() moves once it is done", async () => {
    const E = await encryptedVault("vault-V", notes("v", "VWORD"));
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow();
    const { deleteWorkspaceFile } = await import("../storage/workspace");
    await deleteWorkspaceFile("v/n2.md");
    const list = E.list.bind(E);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    E.list = async (d) => (await gate, list(d));
    try {
      __resetWorkspaceIndex(engine, { keepSnapshot: true });
      await ensureIndex();
      const during = indexedFiles().length;
      const v0 = indexVersion();
      release();
      await indexChecked();
      const after = indexedFiles().map((f) => f.path);
      console.log("  during:", during, "| after:", after.length, "| deleted shown:", after.includes("v/n2.md"), "| version moved:", indexVersion() !== v0);
      expect(during).toBe(0);
      expect(after.includes("v/n2.md")).toBe(false);
      expect(indexVersion()).not.toBe(v0);
    } finally {
      E.list = list;
      release();
    }
  });

  it("(u7) S3: a plain record written before sizes; an equal-mtime edit of another length", async () => {
    const P = createMemoryBackend({ id: "vault-O", now: () => 2_000_000 });
    await notes("o", "OWORD")(P);
    setVaultBackend(P);
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow();
    const rec = (await __snapshotRecord()) as Record<string, unknown>;
    const hadSizes = Array.isArray(rec.sizes);
    delete rec.sizes; // as #420 / rounds 1-3 wrote it
    await __putSnapshotRecord(rec);
    const { writeWorkspaceFile } = await import("../storage/workspace");
    await writeWorkspaceFile("o/n3.md", "rewritten with another length, same mtime");
    __resetWorkspaceIndex(engine, { keepSnapshot: true });
    await ensureIndex();
    await indexChecked();
    const t = await indexedNoteText("o/n3.md");
    console.log("  record had sizes:", hadSizes, "| counters", JSON.stringify(snapshotCounters), "| n3:", JSON.stringify(t));
    expect(t).toBe("rewritten with another length, same mtime");
  });

  it("(u7b) S3: a sealed v2 manifest without sizes (rounds 2-3) is refused: every note read", async () => {
    await encryptedVault("vault-B", notes("b", "BWORD"));
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    const k = restSnapshotKeys()!;
    const files = Array.from({ length: N }, (_, i) => ({ path: `b/n${i}.md`, name: `n${i}.md`, modified: 1, content: `old ${i}` }));
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    const manifest = { v: 1, vault: "vault-B", paths: files.map((f) => f.path), names: files.map((f) => f.name), modified: files.map((f) => f.modified), summaries: files.map((f) => summarize(f.content)) };
    const body = { v: 1, vault: "vault-B", contents: files.map((f) => f.content) };
    await __putSnapshotRecord(await sealSnapshot(k, "vault-B", enc(manifest), enc(body)));
    __resetWorkspaceIndex(engine, { keepSnapshot: true });
    await ensureIndex();
    await indexChecked();
    const t = await indexedNoteText("b/n1.md");
    console.log("  counters", JSON.stringify(snapshotCounters), "| n1:", JSON.stringify(t), "| record:", JSON.stringify((await __snapshotRecord()) ?? null).slice(0, 20));
    expect(snapshotCounters.fromSnapshot).toBe(0);
    expect(t).toBe("# b 1\nBWORD-1");
  });
});
