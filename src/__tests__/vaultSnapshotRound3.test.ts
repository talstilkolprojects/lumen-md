/**
 * W6.36 — regressions for the round-3 crypto review of #529 (14.11, rr12).
 * Each case asserts the secure (or live) outcome:
 *  (j)/(j2) U1: a vault switch during the first build: no other vault's notes saved in the clear;
 *  (j3) the same between two vaults of the same kind (review 19 R1: the kind is not the vault);
 *  (l) U2: a build waiting for an unlock gives way to a vault switch; queries on the new vault answer;
 *  (m)/(n) U3: a lock during the build's clear or applyChanges' remove leaves no text in the engine;
 *  (p) T3 raced with T6; (q) a query issued just before a lock returns no text.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryBackend, getVaultBackend, setVaultBackend, setVaultEncryptionState, type VaultBackend } from "../storage/vault";
import * as session from "../storage/vault/encrypted/session";
import { setRestSealer } from "../storage/vault/restStore";
import { isSealedSnapshot } from "../storage/snapshotSeal";
import { __snapshotRecord } from "../storage/indexSnapshot";
import { __resetWorkspaceIndex, __saveSnapshotNow, ensureIndex, indexedFiles, searchWorkspace } from "../storage/workspaceIndex";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { VaultIndex, localEngine } from "../storage/vaultIndexLocal";
import type { IndexEngine } from "../storage/vaultIndexProtocol";

const PASS = "a long enough passphrase";
const N = 8;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T,>(p: Promise<T>, ms = 1500): Promise<T | "TIMEOUT"> => Promise.race([p, tick(ms).then(() => "TIMEOUT" as const)]);
const recText = async () => JSON.stringify((await __snapshotRecord()) ?? null);
let previous: VaultBackend | null;

beforeEach(() => {
  session.setKdfPolicyForTests({ minPbkdf2Iterations: 1000, minArgon2CostKiB: 8, argon2: { memoryKiB: 8, iterations: 1, parallelism: 1 } });
  previous = setVaultBackend(null);
});
afterEach(async () => {
  session.lock();
  setVaultBackend(previous);
  __resetWorkspaceIndex();
});

const notes = (prefix: string, word: string) => async (b: VaultBackend) => {
  for (let i = 0; i < N; i++) await b.write(`${prefix}/n${i}.md`, `# ${prefix} ${i}\n${word}-${i}`);
};
async function encryptedVault(id: string, write: (b: VaultBackend) => Promise<void>): Promise<VaultBackend> {
  const b = createMemoryBackend({ id });
  await write(b);
  setVaultBackend(b);
  await session.enableEncryption(PASS, { pbkdf2Iterations: 1000, confirmRecoveryKey: async () => true });
  return b;
}
/** A local engine whose calls can run a hook first; `raw` is the engine itself (for looking inside). */
function hooked(h: Partial<Record<"clear" | "remove" | "saveSnapshot" | "restoreSnapshot", (n: number) => Promise<void> | void>>) {
  const raw = localEngine(new VaultIndex());
  const counts: Record<string, number> = {};
  const wrap = <K extends keyof IndexEngine>(k: K) =>
    (async (...a: unknown[]) => {
      counts[k] = (counts[k] ?? 0) + 1;
      const r = (raw[k] as (...x: unknown[]) => Promise<unknown>)(...a);
      await h[k as keyof typeof h]?.(counts[k]);
      return r;
    }) as IndexEngine[K];
  const eng: IndexEngine = { ...raw, clear: wrap("clear"), remove: wrap("remove") };
  return { eng, raw, counts };
}

describe("W6.36 review 14.11 round 3", () => {
  it("(j) a vault switch during the first build: the encrypted vault's notes at shared paths are saved in the clear under the plain vault", async () => {
    const E = await encryptedVault("vault-E", notes("s", "ESECRET"));
    const P = createMemoryBackend({ id: "vault-P" });
    await notes("s", "plainword")(P);
    setVaultBackend(P);
    const { eng } = hooked({
      clear: (n) => {
        if (n === 2) {
          // the build has listed P and is about to read the notes: the user opens E (location.ts activate)
          setVaultBackend(E);
          notifyWorkspaceChanged({ kind: "structure" });
        }
      },
    });
    __resetWorkspaceIndex(() => eng);
    await ensureIndex();
    const inIndex = indexedFiles().length;
    setVaultBackend(P); // ... and back to P before anything else used the index
    notifyWorkspaceChanged({ kind: "structure" });
    await __saveSnapshotNow(); // the idle save the build scheduled
    const t = await recText();
    console.log("  summaries after build:", inIndex, "| record sealed:", isSealedSnapshot(await __snapshotRecord()), "| ESECRET in clear:", /ESECRET/.test(t), "|", t.slice(0, 120));
    expect(/ESECRET/.test(t)).toBe(false);
  });

  it("(j2) as (j), with equal mtimes in both vaults (synced copies): the follow-up refresh reads nothing, the index stays plain-labelled", async () => {
    const E = createMemoryBackend({ id: "vault-E", now: () => 1_000_000 });
    await notes("s", "ESECRET")(E);
    setVaultBackend(E);
    await session.enableEncryption(PASS, { pbkdf2Iterations: 1000, confirmRecoveryKey: async () => true });
    const P = createMemoryBackend({ id: "vault-P", now: () => 1_000_000 });
    await notes("s", "plainword")(P);
    setVaultBackend(P);
    const { eng } = hooked({
      clear: (n) => {
        if (n === 2) {
          // the build has listed P and is about to read the notes: the user opens E (location.ts activate)
          setVaultBackend(E);
          notifyWorkspaceChanged({ kind: "structure" });
        }
      },
    });
    __resetWorkspaceIndex(() => eng);
    await ensureIndex();
    const inIndex = indexedFiles().length;
    setVaultBackend(P); // ... and back to P before anything else used the index
    notifyWorkspaceChanged({ kind: "structure" });
    await __saveSnapshotNow(); // the idle save the build scheduled
    const t = await recText();
    console.log("  summaries after build:", inIndex, "| record sealed:", isSealedSnapshot(await __snapshotRecord()), "| ESECRET in clear:", /ESECRET/.test(t), "|", t.slice(0, 120));
    expect(/ESECRET/.test(t)).toBe(false);
  });

  it("(j3) review 19 R1: as (j2), with two vaults of the same kind (both \"desktop\"): a switch mid-build is still caught", async () => {
    const E = createMemoryBackend({ id: "desktop", now: () => 1_000_000 });
    await notes("s", "ESECRET")(E);
    setVaultBackend(E);
    await session.enableEncryption(PASS, { pbkdf2Iterations: 1000, confirmRecoveryKey: async () => true });
    const P = createMemoryBackend({ id: "desktop", now: () => 1_000_000 });
    await notes("s", "plainword")(P);
    setVaultBackend(P);
    const { eng } = hooked({
      clear: (n) => {
        if (n === 2) {
          // the build has listed P and is about to read the notes: the user opens E (location.ts activate)
          setVaultBackend(E);
          notifyWorkspaceChanged({ kind: "structure" });
        }
      },
    });
    __resetWorkspaceIndex(() => eng);
    await ensureIndex();
    const inIndex = indexedFiles().length;
    setVaultBackend(P); // ... and back to P before anything else used the index
    notifyWorkspaceChanged({ kind: "structure" });
    await __saveSnapshotNow(); // the idle save the build scheduled
    const t = await recText();
    console.log("  summaries after build:", inIndex, "| record sealed:", isSealedSnapshot(await __snapshotRecord()), "| ESECRET in clear:", /ESECRET/.test(t), "|", t.slice(0, 120));
    expect(/ESECRET/.test(t)).toBe(false);
  });

  it("(l) a build waiting for unlock, then a switch to a plain vault: queries on the plain vault still answer", async () => {
    await encryptedVault("vault-L", notes("l", "LSECRET"));
    session.lock();
    __resetWorkspaceIndex(() => localEngine(new VaultIndex()));
    void ensureIndex(); // waits for UNLOCKED_EVENT
    await tick(20);
    const P = createMemoryBackend({ id: "vault-P2" });
    await notes("p", "plainword")(P);
    setVaultBackend(P);
    notifyWorkspaceChanged({ kind: "structure" });
    const r = await withTimeout(searchWorkspace("plainword-3", { limit: 5 }), 2000);
    console.log("  search on the plain vault:", JSON.stringify(r === "TIMEOUT" ? r : r.map((h) => h.path)));
    expect(r).not.toBe("TIMEOUT");
  });

  it("(m) lock while the build awaits its own clear: the restore posted after the lock leaves texts in the engine", async () => {
    await encryptedVault("vault-M", notes("m", "MSECRET"));
    __resetWorkspaceIndex(() => localEngine(new VaultIndex()));
    await ensureIndex();
    await __saveSnapshotNow();
    let armed = true;
    const { eng, raw } = hooked({
      clear: () => {
        if (armed) {
          armed = false;
          session.lock(); // auto-lock fires while the open is under way
        }
      },
    });
    __resetWorkspaceIndex(() => eng, { keepSnapshot: true });
    void ensureIndex();
    await tick(200);
    const texts = await raw.texts();
    const has = JSON.stringify(texts).includes("MSECRET");
    console.log("  locked:", session.encryptionStatus().locked, "| summaries:", indexedFiles().length, "| texts in engine while locked:", texts.length, has);
    expect(has).toBe(false);
  });

  it("(n) lock during applyChanges' remove: the upserts land after the clear", async () => {
    await encryptedVault("vault-N", notes("n", "NSECRET"));
    let armed = false;
    const { eng, raw } = hooked({
      remove: () => {
        if (armed) {
          armed = false;
          session.lock();
        }
      },
    });
    __resetWorkspaceIndex(() => eng);
    await ensureIndex();
    const { deleteWorkspaceFile, writeWorkspaceFile } = await import("../storage/workspace");
    await writeWorkspaceFile("n/n3.md", "EDITED-NSECRET");
    await deleteWorkspaceFile("n/n4.md");
    armed = true;
    await withTimeout(ensureIndex(), 1000);
    await tick(50);
    const texts = await raw.texts();
    console.log("  locked:", session.encryptionStatus().locked, "| summaries:", indexedFiles().length, "| texts in engine while locked:", JSON.stringify(texts.map((t) => t.path)));
    expect(JSON.stringify(texts).includes("NSECRET")).toBe(false);
  });

  it("(p) T3 raced: the other tab writes the header between this tab's re-check and its plain save", async () => {
    const mem = createMemoryBackend({ id: "vault-R" });
    await notes("r", "RACESECRET")(mem);
    setVaultBackend(mem);
    const tab1Gate = getVaultBackend();
    let armed = false;
    const raw = localEngine(new VaultIndex());
    const eng: IndexEngine = {
      ...raw,
      saveSnapshot: async (v, k) => {
        if (armed) {
          armed = false;
          // tab 2 converts now, after tab 1 decided "plain"
          const view = new Proxy(mem, { get: (t, key) => { const x = (t as unknown as Record<string | symbol, unknown>)[key]; return typeof x === "function" ? (x as (...a: unknown[]) => unknown).bind(t) : x; } }) as VaultBackend;
          setVaultBackend(view);
          await session.enableEncryption(PASS, { pbkdf2Iterations: 1000, confirmRecoveryKey: async () => true });
          setVaultBackend(tab1Gate);
          setVaultEncryptionState("none");
          setRestSealer(null);
        }
        return raw.saveSnapshot(v, k);
      },
    };
    __resetWorkspaceIndex(() => eng);
    await ensureIndex();
    armed = true;
    await __saveSnapshotNow();
    const t = await recText();
    console.log("  record after tab 1's raced save:", t.slice(0, 60), "| RACESECRET in clear:", /RACESECRET/.test(t));
    expect(/RACESECRET/.test(t)).toBe(false);
  });

  it("(q) info: a search issued just before lock answers with the locked vault's text after the lock", async () => {
    await encryptedVault("vault-Q", notes("q", "QSECRET"));
    __resetWorkspaceIndex(() => localEngine(new VaultIndex()));
    await ensureIndex();
    const s = searchWorkspace("QSECRET-2", { limit: 5 });
    session.lock();
    const r = await withTimeout(s);
    console.log("  answer after lock:", JSON.stringify(r === "TIMEOUT" ? r : r.map((h) => h.path)));
    expect(r === "TIMEOUT" || r.length === 0).toBe(true);
  });
});
