/**
 * W6.36 — regressions for review 22, vaults of different kinds (rr22 kinds). Each case asserts the secure outcome.
 *  (z1)/(z1b) Z1: after a vault switch mid-build, no stale save writes the encrypted vault's notes in the clear
 *  under the plain vault's key (forced rebuild with the save called by hand; and the real idle timer).
 * Not here: z4 (a copied or planted vault-id shares the plain record: Z2, documented) and z6c (a change nobody
 * announces, e.g. another tab: Z3).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryBackend, setVaultBackend, type VaultBackend } from "../storage/vault";
import * as session from "../storage/vault/encrypted/session";
import { isSealedSnapshot } from "../storage/snapshotSeal";
import { __putSnapshotRecord, __snapshotRecord } from "../storage/indexSnapshot";
import { __resetWorkspaceIndex, __saveSnapshotNow, __setCheckBounds, ensureIndex, searchWorkspace } from "../storage/workspaceIndex";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { VaultIndex, localEngine } from "../storage/vaultIndexLocal";

const PASS = "a long enough passphrase";
const N = 6;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
let lastIndex: VaultIndex | null = null;
const engine = () => localEngine((lastIndex = new VaultIndex()));
/** What the engine holds now, read inside it (no ensureIndex: a probe must not start a build). */
const engineText = (path: string) => { for (const n of lastIndex?.notes() ?? []) if (n.path === path) return n.content; return null; };
const recText = async () => JSON.stringify((await __snapshotRecord()) ?? null);
const recVault = async () => ((await __snapshotRecord()) as { vault?: string } | undefined)?.vault ?? null;
let previous: VaultBackend | null;

beforeEach(() => {
  session.setKdfPolicyForTests({ minPbkdf2Iterations: 1000, minArgon2CostKiB: 8, argon2: { memoryKiB: 8, iterations: 1, parallelism: 1 } });
  previous = setVaultBackend(null);
});
afterEach(() => {
  session.lock();
  setVaultBackend(previous);
  __setCheckBounds();
  __resetWorkspaceIndex();
});

const fill = (prefix: string, word: string) => async (b: VaultBackend) => {
  for (let i = 0; i < N; i++) await b.write(`${prefix}/n${i}.md`, `# ${prefix} ${i}\n${word}-${i}`);
};
async function encrypt(b: VaultBackend): Promise<void> {
  setVaultBackend(b);
  await session.enableEncryption(PASS, { pbkdf2Iterations: 1000, confirmRecoveryKey: async () => true });
}
function switchTo(b: VaultBackend): void {
  setVaultBackend(b); // location.ts activate
  notifyWorkspaceChanged({ kind: "structure" });
}
/** Hold `b.list` once armed: the call waits until `release()`; `entered` resolves when it is called. */
function holdList(b: VaultBackend) {
  const list = b.list.bind(b);
  let armed = false;
  let enter!: () => void;
  let entered = new Promise<void>((r) => (enter = r));
  let release!: () => void;
  let released = new Promise<void>((r) => (release = r));
  let count = 0;
  b.list = async (d) => {
    count++;
    if (armed) {
      armed = false;
      enter();
      await released;
    }
    return list(d);
  };
  return {
    arm: () => {
      armed = true;
      entered = new Promise<void>((r) => (enter = r));
      released = new Promise<void>((r) => (release = r));
    },
    entered: () => entered,
    release: () => release(),
    count: () => count,
    restore: () => (b.list = list),
  };
}
async function waitFor(cond: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await tick(100);
  }
  return cond();
}

describe("W6.36 review 22 (kinds)", () => {
  it("(z1) the stray refresh reads E into the engine; back to P; P's rebuild relabels it plain before its clear; the scheduled save never writes E in the clear", async () => {
    const E = createMemoryBackend({ id: "vault-E" });
    await fill("s", "ESECRET")(E);
    await encrypt(E);
    const P = createMemoryBackend({ id: "vault-P" });
    await fill("s", "plainword")(P);
    setVaultBackend(P);
    const h = holdList(P);
    let switched = false;
    // The switch, once P's build has set filledVault (its listing starts after that).
    const list = P.list.bind(P);
    P.list = async (d) => {
      if (!switched) {
        switched = true;
        const r = await list(d);
        switchTo(E);
        return r;
      }
      return list(d);
    };
    try {
      __resetWorkspaceIndex(engine);
      await ensureIndex(); // P's build gives way; its follow-up refresh reads E
      const inEngine = engineText("s/n1.md");
      switchTo(P); // back, within the 5 s of the stray save
      h.arm();
      const b = ensureIndex(true); // a rebuild of P that waits for its listing
      await h.entered();
      await __saveSnapshotNow(); // the save the stray refresh scheduled, landing now
      h.release();
      await b;
      const t = await recText();
      console.log("  engine after the stray refresh:", JSON.stringify(inEngine), "| record sealed:", isSealedSnapshot(await __snapshotRecord()), "| ESECRET in clear:", /ESECRET/.test(t), "| key:", await recVault(), "| contents[1]:", JSON.stringify(((await __snapshotRecord()) as { contents?: string[] } | undefined)?.contents?.[1] ?? null));
      expect(/ESECRET/.test(t)).toBe(false);
    } finally {
      h.restore();
    }
  });

  it("(z1b) as z1 on the production path: a failed check, the switch away and back, and the real idle timer", async () => {
    const E = createMemoryBackend({ id: "vault-E" });
    await fill("s", "ESECRET")(E);
    await encrypt(E);
    const P = createMemoryBackend({ id: "vault-P" });
    await fill("s", "plainword")(P);
    setVaultBackend(P);
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow(); // P's plain record: the next open is trusted
    const list = P.list.bind(P);
    let phase = 0;
    let enter!: () => void;
    const entered = new Promise<void>((r) => (enter = r));
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    P.list = async (d) => {
      if (phase === 0) {
        phase = 1; // the check of the trusted open: the listing fails (an I/O error) -> fail closed, distrust
        throw new Error("EIO: the folder could not be listed");
      }
      if (phase === 1) {
        phase = 2; // the rebuild's listing (filledVault = P by now): the user opens E
        const r = await list(d);
        switchTo(E);
        return r;
      }
      if (phase === 3) {
        phase = 4; // P's next rebuild (still distrusted): its listing is slow (a big folder)
        enter();
        await released;
      }
      return list(d);
    };
    try {
      __resetWorkspaceIndex(engine, { keepSnapshot: true });
      await searchWorkspace("plainword").catch(() => []); // trusted open, check fails, rebuild gives way, stray refresh reads E
      await waitFor(async () => phase >= 2, 5000);
      await tick(50);
      const inEngine = engineText("s/n1.md");
      switchTo(P); // back to P, well within the 5 s
      phase = 3;
      const b = ensureIndex();
      await Promise.race([entered, tick(3000)]);
      // The real scheduled save (5 s + idle) lands while the listing runs: wait for it (no timing assumed beyond 20 s).
      const saved = await waitFor(async () => /ESECRET/.test(await recText()), 20000);
      release();
      await b;
      const t = await recText();
      console.log("  phase:", phase, "| engine after the stray refresh:", JSON.stringify(inEngine), "| save seen:", saved, "| sealed:", isSealedSnapshot(await __snapshotRecord()), "| ESECRET in clear:", /ESECRET/.test(t), "| key:", await recVault(), "| contents[1]:", JSON.stringify(((await __snapshotRecord()) as { contents?: string[] } | undefined)?.contents?.[1] ?? null));
      expect(/ESECRET/.test(t)).toBe(false);
    } finally {
      release();
      P.list = list;
    }
  });

});
