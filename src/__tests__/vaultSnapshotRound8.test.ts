/**
 * W6.36 — regressions for review 29 of #604 (rr29). Each case asserts the secure outcome:
 *  (w1) Z5: a worker death during a save, and a switch to an encrypted vault during the refill: no plain put
 *       of its text ever reaches IndexedDB;
 *  (w2)–(w5) switches and locks around the retry loop and a save; (w6) Z6: refresh's listing outlives a switch.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryBackend, setVaultBackend, type VaultBackend } from "../storage/vault";
import * as session from "../storage/vault/encrypted/session";
import { __snapshotRecord } from "../storage/indexSnapshot";
import { __resetWorkspaceIndex, __saveSnapshotNow, ensureIndex, indexedNoteText, searchWorkspace } from "../storage/workspaceIndex";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { VaultIndex, localEngine } from "../storage/vaultIndexLocal";
import type { IndexEngine } from "../storage/vaultIndexProtocol";

const PASS = "a long enough passphrase";
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
let lastIndex: VaultIndex | null = null;
const engine = () => localEngine((lastIndex = new VaultIndex()));
const recText = async () => JSON.stringify((await __snapshotRecord()) ?? null);
const within = <T,>(p: Promise<T>, ms: number): Promise<T | "TIMEOUT"> => Promise.race([p, tick(ms).then(() => "TIMEOUT" as const)]);
let previous: VaultBackend | null;

beforeEach(() => {
  session.setKdfPolicyForTests({ minPbkdf2Iterations: 1000, minArgon2CostKiB: 8, argon2: { memoryKiB: 8, iterations: 1, parallelism: 1 } });
  previous = setVaultBackend(null);
});
afterEach(() => {
  session.lock();
  setVaultBackend(previous);
  __resetWorkspaceIndex();
});

const fill = (n: number, word: string) => async (b: VaultBackend) => {
  for (let i = 0; i < n; i++) await b.write(`s/n${i}.md`, `# s ${i}\n${word}-${i}`);
};
async function pair(n = 6, kind = "desktop") {
  const E = createMemoryBackend({ id: kind });
  await fill(n, "ESECRET")(E);
  setVaultBackend(E);
  await session.enableEncryption(PASS, { pbkdf2Iterations: 1000, confirmRecoveryKey: async () => true });
  const P = createMemoryBackend({ id: kind });
  await fill(n, "plainword")(P);
  setVaultBackend(P);
  return { E, P };
}
function switchTo(b: VaultBackend): void {
  setVaultBackend(b);
  notifyWorkspaceChanged({ kind: "structure" });
}
/** Run `hook` once on the first call of `b[m]` after `arm()`. */
function onCall<K extends "list" | "read" | "stat">(b: VaultBackend, m: K, hook: () => void | Promise<void>) {
  const orig = (b[m] as (...a: unknown[]) => Promise<unknown>).bind(b);
  let armed = false;
  let calls = 0;
  (b as unknown as Record<string, unknown>)[m] = async (...a: unknown[]) => {
    calls++;
    if (armed) {
      armed = false;
      await hook();
    }
    return orig(...a);
  };
  return { arm: () => (armed = true), calls: () => calls, restore: () => ((b as unknown as Record<string, unknown>)[m] = orig) };
}

describe("W6.36 review 29: the refill and the save", () => {
  it("(w1) worker death during a save; the refill reads E while it is opened; the retried save never writes E plain under P", async () => {
    const { E, P } = await pair(48);
    // A "worker" engine (kind worker) whose next save fails, as when the worker dies.
    let failSave = false;
    const factory = (): IndexEngine => {
      const raw = localEngine(new VaultIndex());
      return { ...raw, kind: "worker", saveSnapshot: async (v, k) => { if (failSave) { failSave = false; throw new Error("worker died"); } return raw.saveSnapshot(v, k); } } as IndexEngine;
    };
    __resetWorkspaceIndex(factory);
    await ensureIndex(); // P built in the "worker"; no record yet, so the refill reads every note
    const h = onCall(P, "read", () => switchTo(E)); // the user opens E during the refill's reads
    h.arm();
    // every value written to IndexedDB, as it goes to disk (a record may be deleted again right after)
    const put = IDBObjectStore.prototype.put;
    const written: string[] = [];
    IDBObjectStore.prototype.put = function (v: unknown, k?: IDBValidKey) {
      try { written.push(JSON.stringify(v)); } catch { written.push("?"); }
      return put.call(this, v, k);
    };
    failSave = true;
    try {
      await __saveSnapshotNow().catch(() => undefined);
    } finally {
      IDBObjectStore.prototype.put = put;
      h.restore();
    }
    const leaked = written.filter((w) => /ESECRET/.test(w) && !/"sealed"/.test(w));
    const t = await recText();
    console.log("  puts:", written.length, "| plain puts with ESECRET:", leaked.length, "|", (leaked[0] ?? "").slice(0, 140), "| record now:", t.slice(0, 60));
    expect(leaked.length).toBe(0);
  });

  it("(w2) a switch during the retry loop: P -> E mid-build, E -> P mid-retry: nothing in the clear, P answers", async () => {
    const { E, P } = await pair();
    const hp = onCall(P, "list", () => switchTo(E));
    const he = onCall(E, "list", () => switchTo(P));
    hp.arm();
    he.arm();
    __resetWorkspaceIndex(engine);
    const r = await within(ensureIndex(), 30000);
    const hits = (await searchWorkspace("plainword")).length;
    const leak = (await searchWorkspace("ESECRET")).length;
    await __saveSnapshotNow();
    await tick(7000); // any idle save scheduled meanwhile
    const t = await recText();
    console.log("  settled:", r !== "TIMEOUT", "| P lists:", hp.calls(), "E lists:", he.calls(), "| P hits:", hits, "ESECRET hits:", leak, "| ESECRET in clear:", /ESECRET/.test(t));
    expect(r).not.toBe("TIMEOUT");
    expect(/ESECRET/.test(t)).toBe(false);
    expect(leak).toBe(0);
    expect(hits).toBe(6);
  });

  it("(w3) a switch storm (8 switches, one at every build's listing): the run settles and the next call answers", async () => {
    const { E, P } = await pair();
    let n = 0;
    const lp = P.list.bind(P);
    const le = E.list.bind(E);
    P.list = async (d) => { if (d === "" && n < 8) { n++; switchTo(E); } return lp(d); };
    E.list = async (d) => { if (d === "" && n < 8) { n++; switchTo(P); } return le(d); };
    __resetWorkspaceIndex(engine);
    const r = await within(ensureIndex(), 60000);
    P.list = lp;
    E.list = le;
    const r2 = await within(searchWorkspace("plainword"), 30000);
    const active = n % 2 === 0 ? "P" : "E";
    await __saveSnapshotNow();
    const t = await recText();
    console.log("  switches:", n, "| first run settled:", r !== "TIMEOUT", "| next search:", r2 === "TIMEOUT" ? "TIMEOUT" : (r2 as unknown[]).length, "| active:", active, "| ESECRET in clear:", /ESECRET/.test(t));
    expect(r).not.toBe("TIMEOUT");
    expect(r2).not.toBe("TIMEOUT");
    expect(/ESECRET/.test(t)).toBe(false);
  });

  it("(w4) a lock during the retry for E: no reads while locked; switching back to P ends the wait; nothing in clear", async () => {
    const { E, P } = await pair();
    const hp = onCall(P, "list", () => switchTo(E));
    const he = onCall(E, "list", () => session.lock()); // E's retry build: the vault locks (auto-lock)
    hp.arm();
    he.arm();
    let readsWhileLocked = 0;
    const re = E.read.bind(E);
    E.read = async (p) => { if (session.encryptionStatus().locked && p.endsWith(".md")) readsWhileLocked++; return re(p); };
    __resetWorkspaceIndex(engine);
    const run = ensureIndex();
    const early = await within(run, 3000); // waits for the unlock (T4)
    switchTo(P); // the user goes back to P instead
    const r = await within(run, 30000);
    const r2 = await within(searchWorkspace("plainword"), 30000);
    await __saveSnapshotNow();
    await tick(7000);
    const t = await recText();
    console.log("  waited while locked:", early === "TIMEOUT", "| settled after switch:", r !== "TIMEOUT", "| P hits:", r2 === "TIMEOUT" ? "TIMEOUT" : (r2 as unknown[]).length, "| E note reads while locked:", readsWhileLocked, "| ESECRET in clear:", /ESECRET/.test(t));
    expect(r).not.toBe("TIMEOUT");
    expect(r2).not.toBe("TIMEOUT");
    expect(readsWhileLocked).toBe(0);
    expect(/ESECRET/.test(t)).toBe(false);
  });

  it("(w5) a save asked for before a switch (the switch lands inside its snapshotMode): it writes nothing", async () => {
    const { E, P } = await pair();
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    const h = onCall(P, "stat", () => switchTo(E)); // snapshotMode's header re-check (T3) stats the vault
    h.arm();
    await __saveSnapshotNow();
    h.restore();
    const t = await recText();
    console.log("  stat hook ran:", h.calls() > 0, "| record:", t.slice(0, 100));
    expect(/ESECRET/.test(t)).toBe(false);
    expect(t).toBe("null");
  });

  it("(w6) refresh's listing outlives a switch to E: E reaches the engine unlabelled; back to P; the idle timer writes nothing of E", async () => {
    const { E, P } = await pair();
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    // a structural change makes the next use refresh (re-list) P; the switch lands inside that listing
    const h = onCall(P, "list", () => switchTo(E));
    notifyWorkspaceChanged({ kind: "structure" });
    h.arm();
    await ensureIndex(); // refresh: listing of P, switch, then applyChanges with the new epoch reads E
    let inEngine: string | null = null;
    for (const x of lastIndex?.notes() ?? []) if (x.path === "s/n1.md") inEngine = x.content;
    switchTo(P);
    await tick(7000); // the save the stray applyChanges scheduled
    const t1 = await recText();
    await ensureIndex();
    await __saveSnapshotNow();
    const t = await recText();
    const n1 = await indexedNoteText("s/n1.md");
    console.log("  engine after the stray apply:", JSON.stringify(inEngine), "| record after timer:", t1.slice(0, 60), "| after P build: ESECRET in clear:", /ESECRET/.test(t), "| P n1:", JSON.stringify(n1));
    expect(/ESECRET/.test(t1)).toBe(false);
    expect(/ESECRET/.test(t)).toBe(false);
    expect(n1).toContain("plainword");
  });
});
