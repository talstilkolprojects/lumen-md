/**
 * W6.36 — regressions for review 33 of #604 (rr33), every IndexedDB write captured. Each case asserts the
 * secure outcome:
 *  (v1) Z7: a refill that gives way never empties a newer build's engine;
 *  (v2)–(v5) worker deaths during a save, a build's fill, refresh's applyChanges and the retry loop, with a lock or
 *       a switch at that moment: no plain write of the encrypted vault's text, and the active vault answers.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMemoryBackend, setVaultBackend, type VaultBackend } from "../storage/vault";
import * as session from "../storage/vault/encrypted/session";
import { __resetWorkspaceIndex, __saveSnapshotNow, ensureIndex, searchWorkspace } from "../storage/workspaceIndex";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { VaultIndex, localEngine } from "../storage/vaultIndexLocal";
import type { IndexEngine } from "../storage/vaultIndexProtocol";

const PASS = "a long enough passphrase";
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const within = <T,>(p: Promise<T>, ms: number): Promise<T | "TIMEOUT"> => Promise.race([p, tick(ms).then(() => "TIMEOUT" as const)]);
let previous: VaultBackend | null;

// ── every IndexedDB write ─────────────────────────────────────────────
const writes: string[] = [];
const put0 = IDBObjectStore.prototype.put;
const add0 = IDBObjectStore.prototype.add;
beforeAll(() => {
  const cap = (v: unknown) => {
    try {
      writes.push(JSON.stringify(v) ?? "undefined");
    } catch {
      writes.push("?");
    }
  };
  IDBObjectStore.prototype.put = function (v: unknown, k?: IDBValidKey) {
    cap(v);
    return put0.call(this, v, k);
  };
  IDBObjectStore.prototype.add = function (v: unknown, k?: IDBValidKey) {
    cap(v);
    return add0.call(this, v, k);
  };
});
afterAll(() => {
  IDBObjectStore.prototype.put = put0;
  IDBObjectStore.prototype.add = add0;
});
const plainLeaks = () => writes.filter((w) => /ESECRET/.test(w) && !/"sealed"/.test(w));

beforeEach(() => {
  session.setKdfPolicyForTests({ minPbkdf2Iterations: 1000, minArgon2CostKiB: 8, argon2: { memoryKiB: 8, iterations: 1, parallelism: 1 } });
  previous = setVaultBackend(null);
  writes.length = 0;
});
afterEach(() => {
  session.lock();
  setVaultBackend(previous);
  __resetWorkspaceIndex();
});

const fill = (n: number, word: string) => async (b: VaultBackend) => {
  for (let i = 0; i < n; i++) await b.write(`s/n${i}.md`, `# s ${i}\n${word}-${i}`);
};
async function pair(n = 6) {
  const E = createMemoryBackend({ id: "desktop" });
  await fill(n, "ESECRET")(E);
  setVaultBackend(E);
  await session.enableEncryption(PASS, { pbkdf2Iterations: 1000, confirmRecoveryKey: async () => true });
  const P = createMemoryBackend({ id: "desktop" });
  await fill(n, "plainword")(P);
  setVaultBackend(P);
  return { E, P };
}
function switchTo(b: VaultBackend): void {
  setVaultBackend(b);
  notifyWorkspaceChanged({ kind: "structure" });
}
type Op = "search" | "saveSnapshot" | "upsert";
/** A "worker" engine: `die(op, hook)` makes the next call of `op` fail (the worker died), after running `hook`. */
function dyingWorker() {
  let next: { op: Op; hook?: () => void | Promise<void> } | null = null;
  const factory = (): IndexEngine => {
    const raw = localEngine(new VaultIndex());
    const wrap = <K extends Op>(op: K) =>
      (async (...a: unknown[]) => {
        if (next?.op === op) {
          const h = next.hook;
          next = null;
          await h?.();
          throw new Error("worker died");
        }
        return (raw[op] as (...x: unknown[]) => Promise<unknown>)(...a);
      }) as IndexEngine[K];
    return { ...raw, kind: "worker", search: wrap("search"), saveSnapshot: wrap("saveSnapshot"), upsert: wrap("upsert") } as IndexEngine;
  };
  return { factory, die: (op: Op, hook?: () => void | Promise<void>) => (next = { op, hook }) };
}
function onFirst<K extends "list" | "read">(b: VaultBackend, m: K, hook: () => void | Promise<void>) {
  const orig = (b[m] as (...a: unknown[]) => Promise<unknown>).bind(b);
  let armed = false;
  (b as unknown as Record<string, unknown>)[m] = async (...a: unknown[]) => {
    if (armed) {
      armed = false;
      await hook();
    }
    return orig(...a);
  };
  return { arm: () => (armed = true), restore: () => ((b as unknown as Record<string, unknown>)[m] = orig) };
}
const hits = async (q: string) => {
  const r = await within(searchWorkspace(q, { limit: 1000 }), 30000);
  return r === "TIMEOUT" ? "TIMEOUT" : r.length;
};

describe("W6.36 review 33: worker deaths and switches", () => {
  it("(v1) Z7: the refill's abort leaves a newer build's engine alone: E answers", async () => {
    const { E, P } = await pair(6);
    const w = dyingWorker();
    __resetWorkspaceIndex(w.factory);
    await ensureIndex(); // P, in the "worker"
    let eBuilt: unknown = null;
    const h = onFirst(P, "read", async () => {
      switchTo(E); // the user opens E during the refill
      eBuilt = await within(ensureIndex(), 30000); // E is built (in the new in-thread engine) before the refill's read returns
    });
    h.arm();
    w.die("search");
    await searchWorkspace("plainword").catch(() => []); // the worker dies: refill of P's notes, aborted by the switch
    h.restore();
    const first = await hits("ESECRET");
    await ensureIndex();
    const again = await hits("ESECRET");
    console.log("  E built during the refill:", eBuilt !== "TIMEOUT", "| E hits after the abort:", first, "| after another ensureIndex:", again, "| plain ESECRET writes:", plainLeaks().length);
    expect(plainLeaks().length).toBe(0);
    expect(again).toBe(6);
  });

  it("(v2) worker death during a save, a lock during the refill: no plain ESECRET write; E answers after unlock", async () => {
    const E = createMemoryBackend({ id: "desktop" });
    await fill(48, "ESECRET")(E);
    setVaultBackend(E);
    await session.enableEncryption(PASS, { pbkdf2Iterations: 1000, confirmRecoveryKey: async () => true });
    const w = dyingWorker();
    __resetWorkspaceIndex(w.factory);
    await ensureIndex();
    const h = onFirst(E, "read", () => session.lock());
    h.arm();
    w.die("saveSnapshot");
    const save = __saveSnapshotNow().catch(() => undefined);
    await tick(300);
    await session.unlock(PASS);
    await within(save, 30000);
    h.restore();
    await tick(7000);
    const n = await hits("ESECRET");
    console.log("  E hits after unlock:", n, "| writes:", writes.length, "| plain ESECRET writes:", plainLeaks().length);
    expect(plainLeaks().length).toBe(0);
    expect(n).toBe(48);
  });

  it("(v3) worker death inside a build's fill with a switch at that moment: no plain ESECRET write; E answers", async () => {
    const { E, P } = await pair(6);
    const w = dyingWorker();
    __resetWorkspaceIndex(w.factory);
    w.die("upsert", () => switchTo(E));
    await within(ensureIndex().catch(() => undefined), 30000);
    await tick(7000);
    const n = await hits("ESECRET");
    switchTo(P);
    const p = await hits("plainword");
    await __saveSnapshotNow();
    await tick(7000);
    console.log("  E hits:", n, "| P hits:", p, "| plain ESECRET writes:", plainLeaks().length);
    expect(plainLeaks().length).toBe(0);
    expect(n).toBe(6);
    expect(p).toBe(6);
  });

  it("(v4) worker death inside refresh's applyChanges with a switch at that moment: no plain ESECRET write", async () => {
    const { E, P } = await pair(6);
    const w = dyingWorker();
    __resetWorkspaceIndex(w.factory);
    await ensureIndex();
    await P.write("s/n2.md", "# s 2\nplainword-2 edited"); // a save: the next use refreshes (applyChanges upserts it)
    w.die("upsert", () => switchTo(E));
    await within(ensureIndex().catch(() => undefined), 30000);
    await tick(7000);
    const n = await hits("ESECRET");
    switchTo(P);
    const p = await hits("plainword");
    await __saveSnapshotNow();
    await tick(7000);
    console.log("  E hits:", n, "| P hits:", p, "| plain ESECRET writes:", plainLeaks().length);
    expect(plainLeaks().length).toBe(0);
    expect(p).toBe(6);
  });

  it("(v5) worker death inside the retry loop: P -> E mid-build, E's retry upsert kills the worker and opens P: no plain ESECRET write", async () => {
    const { E, P } = await pair(6);
    const w = dyingWorker();
    const hp = onFirst(P, "list", () => {
      switchTo(E);
      w.die("upsert", () => switchTo(P)); // in E's retry build
    });
    hp.arm();
    __resetWorkspaceIndex(w.factory);
    const r = await within(ensureIndex().catch(() => undefined), 30000);
    const p = await hits("plainword");
    const e = await hits("ESECRET");
    await __saveSnapshotNow();
    await tick(7000);
    console.log("  settled:", r !== "TIMEOUT", "| P hits:", p, "ESECRET hits in P:", e, "| plain ESECRET writes:", plainLeaks().length);
    expect(plainLeaks().length).toBe(0);
    expect(e).toBe(0);
    expect(p).toBe(6);
  });
});
