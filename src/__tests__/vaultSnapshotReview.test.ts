/**
 * W6.36 — regressions for the independent crypto re-review of #529 (14.11),
 * from its attack tests (rr10). Each case asserts the secure outcome:
 *  (a) T1 vault switch: an encrypted vault's notes are never saved in the clear under another vault;
 *  (b) T4 lock: the index forgets the locked vault (summaries and texts);
 *  (c) T6: a plain save already queued when encryption is turned on is dropped;
 *  (d) T3: encryption turned on in another tab: this tab looks for the header again before a plain save;
 *  (e2) the text queries wait for the check of a trusted snapshot;
 *  (f) T2: a failed check fails closed: nothing answers from the unchecked (rolled-back) snapshot;
 *  (h) the v2 format refuses v1 records, mixed seals, short bodies, other workspaces and downgrades.
 *  (e) T7: before the check, indexedFiles() shows nothing a note deleted while closed had;
 *  (g) S3: the same mtime with another size is read again.
 * Not here: T5 (lock forgets only the current vault's keys: 11.4, lane K).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryBackend, getVaultBackend, setVaultBackend, setVaultEncryptionState, type VaultBackend } from "../storage/vault";
import * as session from "../storage/vault/encrypted/session";
import { setRestSealer } from "../storage/vault/restStore";
import { deriveRestKeys } from "../storage/vault/encrypted/format";
import { isSealedSnapshot, sealSnapshot, SEAL_VERSION, type SnapshotKeys } from "../storage/snapshotSeal";
import { __putSnapshotRecord, __snapshotRecord, encodeSnapshot, encodeSnapshotParts, readSnapshotManifest, readSnapshotRecord } from "../storage/indexSnapshot";
import {
  __resetWorkspaceIndex,
  __saveSnapshotNow,
  ensureIndex,
  findBacklinks,
  indexChecked,
  indexedFiles,
  indexedNoteText,
  queryVaultTasks,
  searchWorkspace,
  snapshotCounters,
} from "../storage/workspaceIndex";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { VaultIndex, localEngine } from "../storage/vaultIndexLocal";
import type { IndexEngine } from "../storage/vaultIndexProtocol";

const PASS = "a long enough passphrase";
const N = 10;
const engine = () => localEngine(new VaultIndex());
const recText = async () => JSON.stringify((await __snapshotRecord()) ?? null);
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T,>(p: Promise<T>, ms = 1500): Promise<T | "TIMEOUT"> => Promise.race([p, tick(ms).then(() => "TIMEOUT" as const)]);
let previous: VaultBackend | null;

beforeEach(() => {
  session.setKdfPolicyForTests({ minPbkdf2Iterations: 1000, minArgon2CostKiB: 8, argon2: { memoryKiB: 8, iterations: 1, parallelism: 1 } });
  previous = setVaultBackend(null);
});
afterEach(() => {
  session.lock();
  setVaultBackend(previous);
});

async function encryptedVault(id: string, write: (b: VaultBackend) => Promise<void>, opts: { now?: () => number } = {}): Promise<VaultBackend> {
  const b = createMemoryBackend({ id, ...opts });
  await write(b);
  setVaultBackend(b);
  await session.enableEncryption(PASS, { pbkdf2Iterations: 1000, confirmRecoveryKey: async () => true });
  return b;
}
const notes = (prefix: string, word: string) => async (b: VaultBackend) => {
  for (let i = 0; i < N; i++) await b.write(`${prefix}/n${i}.md`, `# ${prefix} ${i}\n${word}-${i} [[n${(i + 1) % N}]]\n- [ ] task ${word}-${i}`);
};

describe("W6.36 review 14.11: never in the clear", () => {
  it("(a) T1 vault switch: an encrypted vault's notes read by refresh are not saved in the clear after switching back to a plain vault", async () => {
    const E = await encryptedVault("vault-E", notes("e", "ESECRET"));
    const P = createMemoryBackend({ id: "vault-P" });
    await notes("p", "plainword")(P);
    setVaultBackend(P);
    __resetWorkspaceIndex(engine);
    await ensureIndex(); // built from the plain vault: filledEncrypted = false
    setVaultBackend(E); // the user opens the encrypted vault (location.ts activate)
    notifyWorkspaceChanged({ kind: "structure" });
    await ensureIndex(); // refresh reads E's notes through the unlocked layer
    const eText = await indexedNoteText("e/n1.md");
    await __saveSnapshotNow();
    const sealedWhileE = isSealedSnapshot(await __snapshotRecord());
    setVaultBackend(P); // ... and switches back inside the 5 s idle window
    notifyWorkspaceChanged({ kind: "structure" });
    await __saveSnapshotNow(); // the idle timer scheduled by E's refresh fires
    const t = await recText();
    console.log("  E text indexed:", JSON.stringify(eText), "| sealed while E:", sealedWhileE, "| after switch to P: sealed", isSealedSnapshot(await __snapshotRecord()), "| ESECRET in clear:", /ESECRET/.test(t), "|", t.slice(0, 140));
    expect(/ESECRET/.test(t)).toBe(false);
  });

  it("(b) T4 lock: the index no longer answers the locked vault's content", async () => {
    await encryptedVault("vault-L", notes("l", "LOCKEDSECRET"));
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    session.lock();
    const text = await withTimeout(indexedNoteText("l/n2.md"));
    const hits = await withTimeout(searchWorkspace("LOCKEDSECRET-3", { limit: 5 }));
    const summaries = indexedFiles().length;
    console.log("  after lock: noteText", JSON.stringify(text), "| search", JSON.stringify(hits === "TIMEOUT" ? hits : hits.map((h) => h.path)), "| summaries in main thread:", summaries);
    expect(typeof text === "string" && text.includes("LOCKEDSECRET")).toBe(false);
    expect(hits === "TIMEOUT" || hits.length === 0).toBe(true);
    expect(summaries).toBe(0);
  });

  it("(c) T6: a plain save queued before the conversion is dropped after it lands", async () => {
    const P = createMemoryBackend({ id: "vault-C" });
    await notes("c", "CONVSECRET")(P);
    setVaultBackend(P);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let called!: () => void;
    const calledP = new Promise<void>((r) => (called = r));
    let holdNext = false;
    const delayed = (): IndexEngine => {
      const e = localEngine(new VaultIndex());
      return {
        ...e,
        saveSnapshot: async (v, k) => {
          if (holdNext) {
            holdNext = false;
            called();
            await hold; // the worker is busy with the save (34 MB at 10k notes)
          }
          return e.saveSnapshot(v, k);
        },
      };
    };
    __resetWorkspaceIndex(delayed);
    await ensureIndex();
    holdNext = true;
    const saving = __saveSnapshotNow(); // mode decided now: plain
    await calledP;
    await session.enableEncryption(PASS, { pbkdf2Iterations: 1000, confirmRecoveryKey: async () => true });
    const afterConversion = await recText();
    release();
    await saving;
    const t = await recText();
    console.log("  after conversion:", afterConversion.slice(0, 40), "| after queued save landed: plain", !isSealedSnapshot(await __snapshotRecord()), "| CONVSECRET in clear:", /CONVSECRET/.test(t));
    expect(/CONVSECRET/.test(t)).toBe(false);
  });

  it("(d) T3 another tab turns encryption on: this tab's idle save writes nothing in the clear", async () => {
    const mem = createMemoryBackend({ id: "vault-D" });
    await notes("d", "TABSECRET")(mem);
    setVaultBackend(mem);
    const tab1Gate = getVaultBackend();
    __resetWorkspaceIndex(engine);
    await ensureIndex(); // tab 1: plain vault, index filled (filledEncrypted = false)
    // Tab 2: the same storage through its own gate; converts and drops the snapshot.
    const view = new Proxy(mem, { get: (t, k) => { const v = (t as unknown as Record<string | symbol, unknown>)[k]; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v; } }) as VaultBackend;
    setVaultBackend(view);
    await session.enableEncryption(PASS, { pbkdf2Iterations: 1000, confirmRecoveryKey: async () => true });
    const afterTab2 = await recText();
    const fileIsCipher = !(new TextDecoder().decode(await (await mem.read("d/n1.md")).arrayBuffer())).includes("TABSECRET");
    // Back in tab 1: its own module state (gate cached plain, state "none", no sealer).
    setVaultBackend(tab1Gate);
    setVaultEncryptionState("none");
    setRestSealer(null);
    await __saveSnapshotNow(); // tab 1's idle timer from an edit made during/just after the conversion
    const t = await recText();
    console.log("  vault file now ciphertext:", fileIsCipher, "| record after tab 2:", afterTab2.slice(0, 30), "| tab 1 save: plain", !isSealedSnapshot(await __snapshotRecord()), "| TABSECRET in clear:", /TABSECRET/.test(t));
    expect(/TABSECRET/.test(t)).toBe(false);
  });
});

describe("W6.36 review 14.11: trusting the manifest", () => {
  const holdList = (b: VaultBackend) => {
    const list = b.list.bind(b);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    b.list = async (dir) => {
      await gate;
      return list(dir);
    };
    return { release, restore: () => ((b.list = list), release()) };
  };

  it("(e2) the text queries wait for the check: search, backlinks, tasks and note text never show the deleted or old note", async () => {
    const E = await encryptedVault("vault-T2", notes("q", "QWORD"));
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow();
    const old = await __snapshotRecord();
    await tick();
    const { deleteWorkspaceFile, writeWorkspaceFile } = await import("../storage/workspace");
    await writeWorkspaceFile("q/n3.md", "edited now");
    await deleteWorkspaceFile("q/n4.md");
    await __putSnapshotRecord(old); // rolled back on top
    const h = holdList(E);
    try {
      __resetWorkspaceIndex(engine, { keepSnapshot: true });
      await ensureIndex();
      const s = searchWorkspace("QWORD-4", { limit: 50 });
      const b = findBacklinks("q/n5.md");
      const tk = queryVaultTasks("not done");
      const t3 = indexedNoteText("q/n3.md");
      const t4 = indexedNoteText("q/n4.md");
      await tick(30);
      h.release();
      const [sh, bh, th, x3, x4] = await Promise.all([s, b, tk, t3, t4]);
      const taskText = JSON.stringify(th);
      console.log("  search", JSON.stringify(sh.map((x) => x.path)), "| backlinks to n5", JSON.stringify(bh.map((x) => x.fromPath)), "| tasks mention QWORD-4:", taskText.includes("QWORD-4"), "| n3", JSON.stringify(x3), "| n4", x4);
      expect(sh.map((x) => x.path)).not.toContain("q/n4.md");
      expect(bh.map((x) => x.fromPath)).not.toContain("q/n4.md");
      expect(taskText.includes("QWORD-4")).toBe(false);
      expect(x3).toBe("edited now");
      expect(x4).toBeNull();
    } finally {
      h.restore();
    }
  });

  it("(e) T7: a note deleted while closed (or by a rolled-back record) shows no title, tags or links in indexedFiles() before the check", async () => {
    const E = await encryptedVault("vault-T", async (b) => {
      await b.write("t/keep.md", "keep");
      await b.write("t/Merger with Acme.md", "---\ntags: [acquisition]\n---\n#confidential [[Board minutes]]");
    });
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow();
    const { deleteWorkspaceFile } = await import("../storage/workspace");
    await deleteWorkspaceFile("t/Merger with Acme.md"); // deleted (here, or on another device) while this app is closed
    const h = holdList(E);
    try {
      __resetWorkspaceIndex(engine, { keepSnapshot: true });
      await ensureIndex();
      const before = indexedFiles().find((f) => f.path === "t/Merger with Acme.md");
      console.log("  before the check, indexedFiles has the deleted note:", !!before, before ? JSON.stringify({ name: before.name, tags: before.noteTags, links: before.wikiTargets }) : "");
      h.release();
      await indexChecked();
      const after = indexedFiles().some((f) => f.path === "t/Merger with Acme.md");
      console.log("  after the check:", after);
      expect(after).toBe(false);
      expect(before).toBeUndefined();
    } finally {
      h.restore();
    }
  });

  it("(g) S3: content changed with the same mtime is read again (the size differs)", async () => {
    const E = await encryptedVault("vault-G", notes("g", "GWORD"), { now: () => 1_000_000 });
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow();
    const { writeWorkspaceFile } = await import("../storage/workspace");
    await writeWorkspaceFile("g/n3.md", "rewritten, same mtime");
    const st = await E.stat("g/n3.md");
    __resetWorkspaceIndex(engine, { keepSnapshot: true });
    await ensureIndex();
    await indexChecked();
    const t = await indexedNoteText("g/n3.md");
    console.log("  mtime", st?.mtime, "| counters", JSON.stringify(snapshotCounters), "| n3 from index:", JSON.stringify(t));
    expect(t).toBe("rewritten, same mtime");
  });
  it("(f) T2 the check fails (listing error): no query answers from the unchecked, rolled-back snapshot", async () => {
    const E = await encryptedVault("vault-F", notes("f", "OLDWORD"));
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow();
    const old = await __snapshotRecord();
    await tick();
    const { deleteWorkspaceFile, writeWorkspaceFile } = await import("../storage/workspace");
    await writeWorkspaceFile("f/n3.md", "edited now");
    await deleteWorkspaceFile("f/n4.md");
    await __putSnapshotRecord(old);
    const list = E.list.bind(E);
    E.list = async () => {
      throw new Error("folder unavailable");
    };
    try {
      __resetWorkspaceIndex(engine, { keepSnapshot: true });
      await ensureIndex();
      const s = searchWorkspace("OLDWORD-4", { limit: 50 }).catch((e) => String(e));
      const t3 = indexedNoteText("f/n3.md").catch((e) => String(e));
      const t4 = indexedNoteText("f/n4.md").catch((e) => String(e));
      const [sh, x3, x4] = await Promise.all([s, t3, t4]);
      const paths = typeof sh === "string" ? sh : sh.map((x) => x.path);
      console.log("  search for a deleted note's text:", JSON.stringify(paths), "| n3:", JSON.stringify(x3), "| n4 (deleted):", JSON.stringify(x4));
      // Later uses that don't go through ensureIndex (indexedNotes / indexedNoteText: the editor, embeds) while the folder stays unlistable.
      await tick(50);
      const later = await indexedNoteText("f/n4.md").catch((e) => String(e));
      console.log("  50 ms later, still unlistable: n4 (deleted) text:", JSON.stringify(later));
      expect(paths).not.toContain("f/n4.md");
      expect(x3).not.toContain("OLDWORD-3");
      expect(typeof x4 === "string" && x4.includes("OLDWORD")).toBe(false);
    } finally {
      E.list = list;
    }
  });

});

describe("W6.36 review 14.11: the v2 format", () => {
  const FILES = [
    { path: "a.md", name: "a.md", modified: 1, content: "alpha" },
    { path: "b.md", name: "b.md", modified: 2, content: "beta" },
  ];
  const keysFor = async (id = "v") => (await deriveRestKeys(crypto.getRandomValues(new Uint8Array(32)), id)).snapshot as SnapshotKeys;
  const seal = (k: SnapshotKeys, files = FILES, vault = "ws") => {
    const p = encodeSnapshotParts(vault, files);
    return sealSnapshot(k, vault, p.manifest, p.body);
  };

  it("(h) v1 records, mixed seals, a short body, another workspace, sealed without keys: all refused", async () => {
    const k = await keysFor();
    const a = await seal(k);
    const b = await seal(k, [{ ...FILES[0], content: "OTHER" }, FILES[1]]);
    const out: Record<string, boolean> = {};
    const refused = async (r: unknown, vault = "ws", keys: SnapshotKeys | null = k) => (await readSnapshotRecord(r, vault, keys ?? undefined)).refused;
    // A v1-shaped record (one part, sv 1), as round 1 wrote it.
    out.v1shape = await refused({ sealed: 1, sv: 1, vaultId: "v", vault: "ws", nonce: a.body.nonce, ct: a.body.ct, mac: a.body.mac });
    out.v2shapeSv1 = await refused({ ...a, sv: 1 });
    out.mixAB = await refused({ ...a, body: b.body });
    out.mixABsidB = await refused({ ...a, body: b.body, sid: b.sid });
    out.swap = await refused({ ...a, manifest: a.body, body: a.manifest });
    // A key holder's short body (n-1 texts) for an n-entry manifest.
    const p = encodeSnapshotParts("ws", FILES);
    const short = encodeSnapshotParts("ws", FILES.slice(0, 1));
    out.shortBody = await refused(await sealSnapshot(k, "ws", p.manifest, short.body));
    out.otherWs = await refused(await seal(k, FILES, "ws2"), "ws");
    out.otherKeys = await refused(a, "ws", await keysFor());
    out.sealedNoKeys = await refused(a, "ws", null);
    out.plainWithKeys = await refused(encodeSnapshot("ws", FILES));
    out.truncatedCt = await refused({ ...a, body: { ...a.body, ct: a.body.ct.subarray(0, a.body.ct.length - 1) } });
    out.manifestOnlyFromRecord = (await readSnapshotManifest({ ...a, body: b.body }, "ws", k)).refused === false; // the manifest alone is fine; the body is refused later
    console.log("  ", JSON.stringify(out), "| SEAL_VERSION", SEAL_VERSION);
    for (const [name, v] of Object.entries(out)) expect([name, v]).toEqual([name, true]);
  });
});
