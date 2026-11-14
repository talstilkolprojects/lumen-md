/**
 * Ninth crypto review 12.11 (H1, H2, H3, H4): a refusal from a key change
 * that has committed since, or a run of freezes that was called off, no
 * longer cuts short the wait on a new honest key change (t8); a revocation
 * that keeps losing to same-epoch keyring rewrites says to take the storage
 * login away first; two engines (tabs) of one device don't make a pairing
 * code while one of them changes keys; and "left out" no longer claims the
 * device wasn't removed.
 * Real engine, real WebCrypto, the simulated provider folder.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { memoryProvider, PreconditionFailedError, type PutCondition } from "../sync/e2ee/provider";
import { createVault, DeviceBusyError, E2eeSync, KEY_CHANGE_LOCK_WAIT_MS, KeyChangeInProgressError, PairingDuringKeyChangeError, RevocationContestedError, unlockVault, unlockWithDevice } from "../sync/e2ee/engine";
import { generateIdentity } from "../sync/e2ee/age";
import { fromUtf8 } from "../sync/e2ee/bytes";
import type { VaultKeys } from "../sync/e2ee/keys";
import { KEYRING_NAME, readKeyring, rewriteKeyring } from "../sync/e2ee/keyring";
import { memoryFiles } from "../sync/e2ee/localFiles";
import { FREEZE_TTL_MS, FROZEN_PROTOCOL, HISTORY_LENGTH, manifestName, openManifest, pathRecord, sealManifest } from "../sync/e2ee/manifest";
import { memoryStateStore } from "../sync/e2ee/state";
import { e2eeErrorText } from "../sync/e2ee/ui/errorText";
import { t } from "../i18n";
import { device, newVault, PASSPHRASE, TEST_ITERATIONS, TEST_POLICY, pairConfirmed } from "./helpers/e2ee";

type Provider = ReturnType<typeof memoryProvider>;
const ringEpoch = (p: Provider) => JSON.parse(fromUtf8(p.objects.get(KEYRING_NAME)!.data)).epoch as number;

/** A promise you open from outside. */
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { wait: () => p, open };
}

/** `base`, with hooks around every call, and optionally a stall before one keyring PUT. */
function hooked(base: Provider, after?: (op: string, name: string) => Promise<void>) {
  let stall: { hold: ReturnType<typeof gate>; reached: ReturnType<typeof gate> } | null = null;
  const p = {
    id: "hooked",
    objects: base.objects,
    get: (name: string) => base.get(name),
    async put(name: string, data: Uint8Array, cond?: PutCondition): Promise<{ etag: string }> {
      if (name === KEYRING_NAME && stall) {
        const s = stall;
        stall = null;
        s.reached.open();
        await s.hold.wait();
      }
      const r = await base.put(name, data, cond);
      await after?.("put", name);
      return r;
    },
    delete: (name: string) => base.delete(name),
    list: () => base.list(),
  };
  /** Stall the next keyring PUT: resolves `reached` when it gets there, goes on at `release()`. */
  const stallNext = () => {
    const s = { hold: gate(), reached: gate() };
    stall = s;
    return { reached: s.reached.wait(), release: s.hold.open };
  };
  return { p, stallNext };
}

/** A holder of the epoch's secret writes a fresh frozen successor of the live manifest, without the engine. */
async function freezeAs(p: Provider, keys: VaultKeys, by: string, at: number): Promise<void> {
  const name = await manifestName(keys);
  const obj = (await p.get(name))!;
  const { manifest: m, digest } = await openManifest(keys, obj.data, name);
  const rest = { ...m };
  delete (rest as { frozen?: unknown }).frozen;
  const next = { ...rest, protocol: FROZEN_PROTOCOL, counter: m.counter + 1, files: pathRecord(m.files), history: [...m.history, [m.counter, digest] as [number, string]].slice(-HISTORY_LENGTH), frozen: { epoch: keys.epoch + 1, at, by } };
  await p.put(name, (await sealManifest(keys, next, name)).bytes, { ifMatch: obj.etag });
}

/** A at epoch 1 with a phone enrolled, and B, an honest second device paired from A, whose keyring PUT can be stalled. */
async function twoDevices() {
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const p = memoryProvider();
  const { keys, anchor } = await createVault(p, PASSPHRASE, { pbkdf2Iterations: TEST_ITERATIONS });
  const a = device("A", p, keys, undefined, now);
  await a.sync.markCreated(anchor);
  a.files.set("a.md", "hello");
  await a.sync.sync();
  const phone = await generateIdentity();
  await a.sync.rekey({ enroll: { phone: phone.recipient } });
  await a.sync.sync();
  const { keys: phoneKeys } = await unlockWithDevice(p, "phone", phone.identity, null);
  const hb = hooked(p);
  const { keys: bKeys } = await unlockVault(p, PASSPHRASE, TEST_POLICY);
  const b = device("B", hb.p, bKeys, undefined, now);
  await b.sync.sync();
  // W8.5: B is paired through the comparison. A copy of A issues the code, so A itself stays
  // free to change keys (a device that confirmed a comparison holds key changes for the new
  // device's window, cancel or not: review 13, S13-1).
  const issuer = device("A-issuer", p, a.sync.keys(), undefined, now);
  issuer.store.state = JSON.parse(JSON.stringify(a.store.state));
  await pairConfirmed(b, issuer, await issuer.sync.pairingCode());
  await a.sync.cancelPairing();
  /** B starts an honest re-key and stalls at its keyring PUT. */
  const bStarts = async () => {
    const s = hb.stallNext();
    const done = b.sync.rekey({}).then(
      (x) => x,
      (e: unknown) => e,
    );
    await Promise.race([s.reached, done]);
    return { done, release: s.release };
  };
  return { p, a, b, phoneKeys, now, tick: (ms: number) => (clock += ms), bStarts };
}

describe("H1: t8 is kept inside the 24-hour window", () => {
  it("a refusal from a key change another device finished doesn't shorten the wait on a new one", async () => {
    const { a, tick, bStarts } = await twoDevices();
    const b1 = await bStarts();
    await expect(a.sync.rekey({ revoke: ["phone"] })).rejects.toBeInstanceOf(KeyChangeInProgressError);
    b1.release();
    expect((await b1.done as { epoch: number }).epoch).toBe(2);
    await a.sync.sync();
    expect(a.store.state!.rekeyBlocked).toBeUndefined(); // the epoch moved: void
    tick(3 * 60 * 60 * 1000); // three hours later, B starts another honest key change
    const b2 = await bStarts();
    await expect(a.sync.rekey({})).rejects.toBeInstanceOf(KeyChangeInProgressError);
    b2.release();
    expect((await b2.done as { epoch: number }).epoch).toBe(3);
  });

  it("a refusal recorded at an earlier epoch (or without one, from an earlier build) starts the wait again", async () => {
    const { a, now, bStarts } = await twoDevices();
    a.store.state!.rekeyBlocked = { since: now() - FREEZE_TTL_MS - 60_000 }; // no epoch: void
    const b1 = await bStarts();
    await expect(a.sync.rekey({})).rejects.toBeInstanceOf(KeyChangeInProgressError);
    expect(a.store.state!.rekeyBlocked).toEqual({ since: now(), epoch: 1 });
    b1.release();
    await b1.done;
  });

  it("after a call-off with nothing to upload, a round and a re-key both wait on a fresh honest freeze", async () => {
    const { p, a, phoneKeys, now, tick, bStarts } = await twoDevices();
    await freezeAs(p, phoneKeys, "phone", now());
    expect((await a.sync.sync()).rekeyPending).toBe(true);
    tick(FREEZE_TTL_MS + 60_000);
    const off = await a.sync.sync(); // calls the stale freeze off; nothing to upload
    expect(off.retries).toBe(1);
    expect(a.store.state!.frozenSeen).toBeUndefined();
    tick(60 * 60 * 1000);
    const b1 = await bStarts();
    expect((await a.sync.sync()).rekeyPending).toBe(true); // waits, doesn't call B's freeze off
    await expect(a.sync.rekey({})).rejects.toBeInstanceOf(KeyChangeInProgressError);
    b1.release();
    expect((await b1.done as { epoch: number }).epoch).toBe(2);
  });
});

describe("H2: a revocation contested by same-epoch keyring rewrites", () => {
  it("says so from the second loss in a row, still a PreconditionFailedError; a commit clears it", async () => {
    const p = memoryProvider();
    const a0 = await newVault(p);
    a0.files.set("a.md", "hello");
    await a0.sync.sync();
    const phone = await generateIdentity();
    await a0.sync.rekey({ enroll: { phone: phone.recipient } });
    await a0.sync.sync();
    const { keys: phoneKeys } = await unlockWithDevice(p, "phone", phone.identity, null);
    const access = { device: "phone", identity: phone.identity };
    const thief = new E2eeSync({ provider: p, keys: phoneKeys, local: memoryFiles(), store: memoryStateStore(), access });
    await thief.sync();
    let churn = true;
    // The phone polls the storage and bumps the keyring's rev whenever A writes a manifest.
    const h = hooked(p, async (_op, name) => {
      if (!churn || name === KEYRING_NAME || name === "lumen-e2ee-vault") return;
      const k = thief.keys();
      const cur = await readKeyring(p);
      if (cur && cur.file.epoch === k.epoch) {
        try {
          await rewriteKeyring(p, k, access, (c, f) => ({ contents: c, file: f }));
          await thief.sync().catch(() => undefined);
        } catch {
          /* why: the phone raced another write; it tries again on the next one */
        }
      }
    });
    const a = new E2eeSync({ provider: h.p, keys: a0.sync.keys(), local: a0.files, store: a0.store });
    const tries: unknown[] = [];
    for (let i = 0; i < 3; i++) tries.push(await a.rekey({ revoke: ["phone"] }).then((x) => x, (e: unknown) => e));
    expect(tries[0]).toBeInstanceOf(PreconditionFailedError);
    expect(tries[0]).not.toBeInstanceOf(RevocationContestedError);
    expect(tries[1]).toBeInstanceOf(RevocationContestedError);
    expect(tries[2]).toBeInstanceOf(PreconditionFailedError);
    expect((tries[2] as RevocationContestedError).losses).toBe(3);
    expect(e2eeErrorText(tries[1])).toBe(t("e2ee.rekey.contested", { devices: "phone" }));
    expect(ringEpoch(p)).toBe(1);
    // The user took the storage login away: the removal goes through, and the count is gone.
    churn = false;
    const done = await a.rekey({ revoke: ["phone"] });
    expect(done.epoch).toBe(2);
    expect(a0.store.state!.revokeContested).toBeUndefined();
  });
});

describe("H3: two tabs of one device", () => {
  it("no pairing code or answer from tab 2 while tab 1's revocation is in flight; one after it vouches for the new epoch", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    a.files.set("a.md", "hello");
    await a.sync.sync();
    const phone = await generateIdentity();
    await a.sync.rekey({ enroll: { phone: phone.recipient } });
    await a.sync.sync();
    const slow = hooked(p);
    const tab1 = new E2eeSync({ provider: slow.p, keys: a.sync.keys(), local: a.files, store: a.store });
    const tab2 = new E2eeSync({ provider: p, keys: a.sync.keys(), local: a.files, store: a.store });
    await tab2.sync(); // tab 2 read the state before tab 1's key change
    const s = slow.stallNext();
    const rk = tab1.rekey({ revoke: ["phone"] });
    await s.reached;
    await expect(tab2.pairingCode()).rejects.toBeInstanceOf(PairingDuringKeyChangeError);
    await expect(tab2.answerPairing("lumen-pair-request:2:x")).rejects.toBeInstanceOf(PairingDuringKeyChangeError);
    s.release();
    expect((await rk).epoch).toBe(2);
    // After it, tab 2 (keys of epoch 1 in memory) reads the stored state again and takes up epoch 2.
    const code = await tab2.pairingCode();
    expect(code.split(":")[2]).toBe("2");
    expect(tab2.keys().epoch).toBe(2);
  });

  it("a code tab 2 made just before tab 1's key change holds that key change back (the stored pairing lock)", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    a.files.set("a.md", "hello");
    await a.sync.sync();
    await a.sync.rekey({});
    await a.sync.sync();
    const tab1 = new E2eeSync({ provider: p, keys: a.sync.keys(), local: a.files, store: a.store });
    const tab2 = new E2eeSync({ provider: p, keys: a.sync.keys(), local: a.files, store: a.store });
    await tab1.sync(); // tab 1 cached the state without a pairing lock
    await tab2.pairingCode();
    await expect(tab1.rekey({})).rejects.toMatchObject({ name: "PairingPendingError" });
  });
});

describe("H4: the left-out message", () => {
  it("doesn't claim the device wasn't removed", () => {
    const text = t("e2ee.dropped");
    expect(text).not.toMatch(/wasn't removed/);
    expect(text).toMatch(/or this device was removed/);
  });
});

describe("review 16 follow-ups (K6-1, K6-2, K6-3)", () => {
  async function vault() {
    const p = memoryProvider();
    const a = await newVault(p);
    a.files.set("a.md", "hello");
    await a.sync.sync();
    const phone = await generateIdentity();
    await a.sync.rekey({ enroll: { phone: phone.recipient } });
    await a.sync.sync();
    return { p, a };
  }

  it("K6-1: a stale tab's round keeps the other tab's revocation record and anchor", async () => {
    const { p, a } = await vault();
    const tab1 = new E2eeSync({ provider: p, keys: a.sync.keys(), local: a.files, store: a.store });
    const tab2 = new E2eeSync({ provider: p, keys: a.sync.keys(), local: a.files, store: a.store });
    await tab2.sync(); // tab 2 cached the state before tab 1's key change
    await tab1.rekey({ revoke: ["phone"] });
    const after1 = JSON.parse(JSON.stringify(a.store.state));
    await tab2.sync();
    const after2 = a.store.state!;
    expect(after2.revokedHere?.devices.map((d) => d.device)).toEqual(["phone"]);
    expect(after2.rekeyed).toEqual(after1.rekeyed);
    expect(after2.anchor!.counter).toBeGreaterThanOrEqual(after1.anchor.counter);
    expect(tab2.keys().epoch).toBe(2);
  });

  it("K6-3: two tabs that started on an empty store (two device ids) still share the lock", async () => {
    const { p, a } = await vault();
    const slow = hooked(p);
    const store = memoryStateStore();
    const files = memoryFiles();
    const tab1 = new E2eeSync({ provider: slow.p, keys: a.sync.keys(), local: files, store });
    const tab2 = new E2eeSync({ provider: p, keys: a.sync.keys(), local: files, store });
    await Promise.all([tab1.freshness(), tab2.freshness()]); // each makes its own device id
    await tab1.sync();
    await tab1.confirmFreshness();
    await tab2.sync();
    await tab2.confirmFreshness();
    const s = slow.stallNext();
    const rk = tab1.rekey({ revoke: ["phone"] });
    await s.reached;
    await expect(tab2.pairingCode()).rejects.toBeInstanceOf(PairingDuringKeyChangeError);
    s.release();
    expect((await rk).epoch).toBe(2);
  });

  it("K6-2: refusals the storage makes up, with nothing rewritten, are not 'contested'", async () => {
    const { p, a } = await vault();
    let refuse = true;
    const lying = { ...p, id: "lying", objects: p.objects, get: (n: string) => p.get(n), delete: (n: string) => p.delete(n), list: () => p.list(),
      put: (n: string, d: Uint8Array, c?: PutCondition) => (refuse && n === KEYRING_NAME ? Promise.reject(new PreconditionFailedError(n)) : p.put(n, d, c)) };
    const tab = new E2eeSync({ provider: lying, keys: a.sync.keys(), local: a.files, store: a.store });
    for (let i = 0; i < 3; i++) {
      const e = await tab.rekey({ revoke: ["phone"] }).then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(PreconditionFailedError);
      expect(e).not.toBeInstanceOf(RevocationContestedError);
    }
    refuse = false;
    expect((await tab.rekey({ revoke: ["phone"] })).epoch).toBe(2);
  });
});

describe("review 34 follow-ups (K34-1, K34-2)", () => {
  /** `base`, with the next GET held until `release()`: a storage request that hangs. */
  function hangNextGet(base: Provider) {
    let hang = false;
    const hold = gate();
    const reached = gate();
    const p = { ...base, id: "hanging", objects: base.objects, put: (n: string, d: Uint8Array, c?: PutCondition) => base.put(n, d, c), delete: (n: string) => base.delete(n), list: () => base.list(),
      async get(n: string) {
        if (hang) {
          hang = false;
          reached.open();
          await hold.wait();
        }
        return base.get(n);
      } };
    return { p, arm: () => (hang = true), reached: reached.wait(), release: hold.open };
  }

  it("K34-1: a revocation fails clearly, within the bound, while another tab's round hangs on the storage; then it goes through", async () => {
    const base = memoryProvider();
    const a = await newVault(base);
    a.files.set("a.md", "hello");
    await a.sync.sync();
    const phone = await generateIdentity();
    await a.sync.rekey({ enroll: { phone: phone.recipient } });
    await a.sync.sync();
    const h = hangNextGet(base);
    const tab1 = new E2eeSync({ provider: h.p, keys: a.sync.keys(), local: a.files, store: a.store });
    const tab2 = new E2eeSync({ provider: base, keys: a.sync.keys(), local: a.files, store: a.store });
    h.arm();
    const round = tab1.sync();
    await h.reached;
    const t0 = Date.now();
    await expect(tab2.rekey({ revoke: ["phone"] })).rejects.toBeInstanceOf(DeviceBusyError);
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(KEY_CHANGE_LOCK_WAIT_MS - 50);
    expect(waited).toBeLessThan(KEY_CHANGE_LOCK_WAIT_MS + 5_000);
    expect(e2eeErrorText(new DeviceBusyError())).toBe(t("e2ee.busy"));
    h.release();
    await round;
    expect((await tab2.rekey({ revoke: ["phone"] })).epoch).toBe(2); // the round let go: it goes through
  }, 60_000);

  it("K34-2: a code asked for while another tab only syncs says 'busy', not 'changing keys'", async () => {
    const base = memoryProvider();
    const a = await newVault(base);
    a.files.set("a.md", "hello");
    await a.sync.sync();
    await a.sync.rekey({});
    await a.sync.sync();
    const h = hangNextGet(base);
    const tab1 = new E2eeSync({ provider: h.p, keys: a.sync.keys(), local: a.files, store: a.store });
    const tab2 = new E2eeSync({ provider: base, keys: a.sync.keys(), local: a.files, store: a.store });
    h.arm();
    const round = tab1.sync();
    await h.reached;
    await expect(tab2.pairingCode()).rejects.toBeInstanceOf(DeviceBusyError);
    h.release();
    await round;
    expect((await tab2.pairingCode()).split(":")[2]).toBe("1"); // the round let go: a code for epoch 1
  });
});
