/**
 * W6.36 — regressions for review 22 (rr22). Each case asserts the secure outcome.
 *  (z1)/(z1b) Z1: after a vault switch mid-build, no stale save writes the encrypted vault's notes in the clear
 *  under the plain vault's key (forced rebuild with the save called by hand; and the real idle timer).
 * Not here: z4 (a copied or planted vault-id shares the plain record: Z2, documented) and z6c (a change nobody
 * announces, e.g. another tab: Z3).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryBackend, setVaultBackend, type VaultBackend } from "../storage/vault";
import * as session from "../storage/vault/encrypted/session";
import { isSealedSnapshot } from "../storage/snapshotSeal";
import { __putSnapshotRecord, __snapshotRecord, encodeSnapshot } from "../storage/indexSnapshot";
import { __resetWorkspaceIndex, __saveSnapshotNow, __setCheckBounds, ensureIndex, indexedNoteText, searchWorkspace, snapshotCounters } from "../storage/workspaceIndex";
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

describe("W6.36 review 22", () => {
  it("(z1) the stray refresh reads E into the engine; back to P; P's rebuild relabels it plain before its clear; the scheduled save never writes E in the clear", async () => {
    const E = createMemoryBackend({ id: "desktop" });
    await fill("s", "ESECRET")(E);
    await encrypt(E);
    const P = createMemoryBackend({ id: "desktop" });
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
    const E = createMemoryBackend({ id: "desktop" });
    await fill("s", "ESECRET")(E);
    await encrypt(E);
    const P = createMemoryBackend({ id: "desktop" });
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

  it("(z2) fallback key: two read-only vaults of one kind (E encrypted, P plain) both file under the kind; nothing in the clear", async () => {
    const ro = (b: VaultBackend) => {
      const w = b.write.bind(b);
      b.write = async (p, d) => {
        if (p.startsWith(".lumen/")) throw new Error("EACCES: read-only");
        return w(p, d);
      };
    };
    const E = createMemoryBackend({ id: "desktop", now: () => 1_000_000 });
    await fill("s", "ESECRET")(E);
    await encrypt(E);
    ro(E);
    const P = createMemoryBackend({ id: "desktop", now: () => 1_000_000 });
    await fill("s", "plainword")(P);
    ro(P);
    setVaultBackend(E);
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow();
    const eRec = (await __snapshotRecord()) as { vault?: string; sealed?: number } | undefined;
    switchTo(P);
    __resetWorkspaceIndex(engine, { keepSnapshot: true });
    await ensureIndex();
    const hits = (await searchWorkspace("plainword")).map((h) => h.path).sort();
    await __saveSnapshotNow();
    const t = await recText();
    console.log("  E record: sealed", isSealedSnapshot(eRec), "vault", eRec?.vault, "| P record vault:", await recVault(), "| P hits:", hits.length, "| P fromSnapshot:", snapshotCounters.fromSnapshot, "| ESECRET in clear:", /ESECRET/.test(t));
    expect(/ESECRET/.test(t)).toBe(false);
    expect(hits.length).toBe(N);
  });

  it("(z3) shared UUID: P is a synced copy of E (same vault-id); E encrypted later; nothing in the clear and no cross restore", async () => {
    const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const E = createMemoryBackend({ id: "folder", now: () => 1_000_000 });
    await fill("s", "ESECRET")(E);
    await E.write(".lumen/vault-id", ID + "\n");
    const P = createMemoryBackend({ id: "folder", now: () => 1_000_000 });
    await fill("s", "ESECRET")(P); // the copy, same text, same mtimes
    await P.write(".lumen/vault-id", ID + "\n");
    await encrypt(E); // E encrypted (its vault-id is converted too)
    for (let i = 0; i < N; i++) await P.write(`s/n${i}.md`, `# s ${i}\nplainword-${i}`); // P edited afterwards
    // P: plain record under folder:ID
    setVaultBackend(P);
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow();
    const pKey = await recVault();
    // E: opens with the plain record of the same key on disk
    switchTo(E);
    __resetWorkspaceIndex(engine, { keepSnapshot: true });
    await ensureIndex();
    const eFrom = snapshotCounters.fromSnapshot;
    const eHits = (await searchWorkspace("ESECRET")).length;
    const ePlainHits = (await searchWorkspace("plainword")).length;
    await __saveSnapshotNow();
    const sealed = isSealedSnapshot(await __snapshotRecord());
    // back to P: takes nothing of E
    switchTo(P);
    __resetWorkspaceIndex(engine, { keepSnapshot: true });
    await ensureIndex();
    const pFrom = snapshotCounters.fromSnapshot;
    await __saveSnapshotNow();
    const t = await recText();
    console.log("  P key:", pKey, "| E fromSnapshot:", eFrom, "E hits ESECRET/plain:", eHits, ePlainHits, "| E record sealed:", sealed, "| P fromSnapshot after:", pFrom, "| ESECRET in clear:", /ESECRET/.test(t));
    expect(/ESECRET/.test(t)).toBe(false);
    expect(ePlainHits).toBe(0);
    expect(eHits).toBe(N);
  });

  it("(z4b) odd vault-id content: never a path, never part of the key; the file is replaced", async () => {
    const A = createMemoryBackend({ id: "folder" });
    await fill("s", "aword")(A);
    await A.write(".lumen/vault-id", "../../../etc/passwd\u0000:" + "x".repeat(10));
    const reads: string[] = [];
    const rt = A.readText.bind(A);
    A.readText = async (p) => {
      reads.push(p);
      return rt(p);
    };
    setVaultBackend(A);
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow();
    const key = await recVault();
    const file = await rt(".lumen/vault-id");
    const stray = reads.filter((p) => p !== ".lumen/vault-id" && !p.endsWith(".md"));
    console.log("  key:", key, "| file now:", JSON.stringify(file), "| other reads:", JSON.stringify(stray));
    expect(key).toMatch(/^folder:[0-9a-f-]{36}$/);
    expect(stray).toEqual([]);
  });

  it("(z5) first-write race: a switch while A's id is being written: B's record is filed under B's own id", async () => {
    const A = createMemoryBackend({ id: "folder" });
    await fill("a", "aword")(A);
    const B = createMemoryBackend({ id: "folder" });
    await fill("b", "bword")(B);
    const BID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await B.write(".lumen/vault-id", BID);
    const w = A.write.bind(A);
    let hit = false;
    A.write = async (p, d) => {
      if (p === ".lumen/vault-id" && !hit) {
        hit = true;
        switchTo(B); // the user opens B while A's id is being written
        await tick(30);
      }
      return w(p, d);
    };
    setVaultBackend(A);
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await ensureIndex();
    const hits = (await searchWorkspace("bword")).length;
    await __saveSnapshotNow();
    const key = await recVault();
    const t = await recText();
    console.log("  hit:", hit, "| record key:", key, "| B hits:", hits, "| aword in record:", /aword/.test(t));
    expect(key).toBe(`folder:${BID}`);
    expect(/aword/.test(t)).toBe(false);
  });

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
  async function plainTrusted(word: string): Promise<VaultBackend> {
    const b = createMemoryBackend({ id: "folder" });
    for (let i = 0; i < N; i++) await b.write(`n${i}.md`, `# n${i}\n${word}-${i}`);
    setVaultBackend(b);
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow();
    return b;
  }

  it("(z6a) Y1: a save then a delete during the slow check: the kept listing is dropped, texts right", async () => {
    const V = await plainTrusted("OLDTEXT");
    __setCheckBounds({ checkMs: 400, viewMs: 200 });
    const s = slowList(V, 1200);
    try {
      __resetWorkspaceIndex(engine, { keepSnapshot: true });
      await ensureIndex();
      await tick(50);
      const { writeWorkspaceFile, deleteWorkspaceFile } = await import("../storage/workspace");
      await writeWorkspaceFile("n3.md", "# n3\nNEWTEXT-3");
      await deleteWorkspaceFile("n4.md");
      await tick(500);
      const t3 = await indexedNoteText("n3.md");
      const t4 = await indexedNoteText("n4.md");
      console.log("  listings:", s.count(), "| n3:", JSON.stringify(t3), "| n4:", JSON.stringify(t4));
      expect(t3).toContain("NEWTEXT");
      expect(t4).toBeNull();
    } finally {
      s.restore();
    }
  });

  it("(z6b) Y1: a content event with paths during the slow check: re-read after the reuse", async () => {
    const V = await plainTrusted("OLDTEXT");
    __setCheckBounds({ checkMs: 400, viewMs: 200 });
    const s = slowList(V, 1200);
    try {
      __resetWorkspaceIndex(engine, { keepSnapshot: true });
      await ensureIndex();
      await tick(50);
      // written behind the backend's events (say, another module), announced as a content change
      const raw = V as VaultBackend & { __silent?: boolean };
      await raw.write("n2.md", "# n2\nNEWTEXT-2"); // emits a write; also announce as content
      notifyWorkspaceChanged({ kind: "content", paths: ["n2.md"] } as never);
      await tick(500);
      const t = await indexedNoteText("n2.md");
      console.log("  listings:", s.count(), "| n2:", JSON.stringify(t));
      expect(t).toContain("NEWTEXT");
    } finally {
      s.restore();
    }
  });

  it("(z7) the same vault through a new backend object (reconnect): answers right, the record key is unchanged", async () => {
    const V = createMemoryBackend({ id: "desktop" });
    await fill("s", "vword")(V);
    setVaultBackend(V);
    __resetWorkspaceIndex(engine);
    await ensureIndex();
    await __saveSnapshotNow();
    const k1 = await recVault();
    // a new object over the same folder (createTauriBackend again after "pick folder" of the same root)
    const V2: VaultBackend = { ...V, id: "desktop" } as VaultBackend;
    for (const k of ["list", "stat", "read", "readText", "write", "mkdir", "rename", "remove", "watch", "notifyExternal", "available"] as const) (V2 as never as Record<string, unknown>)[k] = (V as never as Record<string, (...a: unknown[]) => unknown>)[k].bind(V);
    switchTo(V2);
    const hits = (await searchWorkspace("vword")).length;
    await __saveSnapshotNow();
    const k2 = await recVault();
    __resetWorkspaceIndex(engine, { keepSnapshot: true });
    await ensureIndex();
    const from = snapshotCounters.fromSnapshot;
    console.log("  key before:", k1, "| after reconnect:", k2, "| hits:", hits, "| next open fromSnapshot:", from);
    expect(hits).toBe(N);
    expect(k2).toBe(k1);
  });

  it("(z8) a record under the old kind-only key is refused once and replaced", async () => {
    const V = createMemoryBackend({ id: "folder", now: () => 3_000_000 });
    for (let i = 0; i < N; i++) await V.write(`n${i}.md`, `realtext-${i}`);
    setVaultBackend(V);
    // the old-format record (kind only), with a forged text at the right size/mtime
    await __putSnapshotRecord(encodeSnapshot("folder", Array.from({ length: N }, (_, i) => ({ path: `n${i}.md`, name: `n${i}.md`, modified: 3_000_000, content: `FORGEDTE-${i}` }))));
    __resetWorkspaceIndex(engine, { keepSnapshot: true });
    await ensureIndex();
    const t = await indexedNoteText("n1.md");
    const from = snapshotCounters.fromSnapshot;
    await __saveSnapshotNow();
    const key = await recVault();
    console.log("  n1:", JSON.stringify(t), "| fromSnapshot:", from, "| record key now:", key);
    expect(t).toContain("realtext");
    expect(key).toMatch(/^folder:[0-9a-f-]{36}$/);
  });
});
