/**
 * Seventh crypto review 12.11 (G1, G2, G3, G5): the freeze wait is bounded
 * per key change, so the device being revoked can't hold its revocation
 * back by re-freezing; a replayed dropped marker doesn't turn a revocation
 * into "pair again"; no pairing code while this device changes keys; and
 * the sealed revoked list only grows, with a local list that fails to verify
 * set aside, not wedging every round.
 * Real engine, real WebCrypto, the simulated provider folder.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { memoryProvider, type StoredObject, type SyncProvider } from "../sync/e2ee/provider";
import { createVault, E2eeSync, KeyChangeInProgressError, PairingDuringKeyChangeError, PairingPendingError, unlockWithDevice } from "../sync/e2ee/engine";
import { ageDecrypt, generateIdentity } from "../sync/e2ee/age";
import { fromB64u, fromUtf8, utf8 } from "../sync/e2ee/bytes";
import type { VaultKeys } from "../sync/e2ee/keys";
import { KEYRING_NAME, KeyringForkError, rewriteKeyring } from "../sync/e2ee/keyring";
import { memoryFiles } from "../sync/e2ee/localFiles";
import { FREEZE_TTL_MS, FROZEN_PROTOCOL, HISTORY_LENGTH, manifestName, openManifest, pathRecord, sealManifest } from "../sync/e2ee/manifest";
import { memoryStateStore } from "../sync/e2ee/state";
import { e2eeErrorText, e2eeResultNotices } from "../sync/e2ee/ui/errorText";
import { t } from "../i18n";
import { device, joinVault, newVault, PASSPHRASE, TEST_ITERATIONS } from "./helpers/e2ee";

type Provider = ReturnType<typeof memoryProvider>;
const ringJson = (p: Provider) => JSON.parse(fromUtf8(p.objects.get(KEYRING_NAME)!.data));
const errName = (e: unknown) => (e as Error)?.name ?? String(e);

async function wrapsFor(p: Provider, id: string, identity: string): Promise<Uint8Array | null> {
  const ring = ringJson(p);
  if (!ring.devices[id]) return null;
  return ageDecrypt(fromB64u(ring.devices[id].wrap), [{ identity }]).catch(() => null);
}

async function enrolled(provider: SyncProvider, name: string, identity: string, store = memoryStateStore()) {
  const { keys } = await unlockWithDevice(provider, name, identity, store.state);
  return { keys, store, sync: new E2eeSync({ provider, keys, local: memoryFiles(), store, access: { device: name, identity } }) };
}

/** A holder of the epoch's secret (the device being revoked) writes a fresh frozen successor of the live manifest, without the engine. */
async function freezeAs(p: Provider, keys: VaultKeys, by: string, at: number): Promise<void> {
  const name = await manifestName(keys);
  const obj = (await p.get(name)) as StoredObject;
  const { manifest: m, digest } = await openManifest(keys, obj.data, name);
  const rest = { ...m };
  delete rest.frozen;
  const next = { ...rest, protocol: FROZEN_PROTOCOL, counter: m.counter + 1, files: pathRecord(m.files), history: [...m.history, [m.counter, digest] as [number, string]].slice(-HISTORY_LENGTH), frozen: { epoch: keys.epoch + 1, at, by } };
  const sealed = await sealManifest(keys, next, name);
  await p.put(name, sealed.bytes, { ifMatch: obj.etag });
}

/** A vault on a test clock, with a phone enrolled and synced (the thief holds its key and the storage login). */
async function withThief() {
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
  const thief = await enrolled(p, "phone", phone.identity);
  await thief.sync.sync();
  return { p, a, phone, thief, now, tick: (ms: number) => (clock += ms) };
}

describe("G1: the freeze wait is bounded per key change", () => {
  it("the phone re-freezes every 9 minutes: A still revokes it FREEZE_TTL_MS after its first attempt, then changes the passphrase", async () => {
    const { p, a, phone, thief, now, tick } = await withThief();
    const results: string[] = [];
    let epoch: number | null = null;
    for (let i = 0; i < 6 && epoch === null; i++) {
      await freezeAs(p, thief.keys, `phone-${i}`, now());
      const r = await a.sync.rekey({ revoke: ["phone"] }).then((x) => x, (e) => e);
      if ((r as { epoch?: number }).epoch) epoch = (r as { epoch: number }).epoch;
      results.push(epoch ? `epoch ${epoch}` : errName(r));
      tick(9 * 60_000);
    }
    // Attempts at 0 and 9 minutes wait; the one at 18 minutes (over the TTL since the first) freezes over.
    expect(results).toEqual(["KeyChangeInProgressError", "KeyChangeInProgressError", "epoch 2"]);
    expect(await wrapsFor(p, "phone", phone.identity)).toBeNull();
    expect(a.store.state!.rekeyBlocked).toBeUndefined(); // cleared by the commit
    expect((await a.sync.rekey({ newPassphrase: "a new passphrase for the vault 2026" })).epoch).toBe(3);
    a.files.set("b.md", "after");
    expect((await a.sync.sync()).uploaded).toBe(1);
  });

  it("t8 stays: a fresh foreign freeze is still waited on in full, and a refusal given up a day ago doesn't shorten it", async () => {
    const { p, a, thief, now, tick } = await withThief();
    await freezeAs(p, thief.keys, "B-device", now());
    await expect(a.sync.rekey()).rejects.toBeInstanceOf(KeyChangeInProgressError);
    tick(25 * 60 * 60 * 1000); // the user gave up; much later, another device starts a key change
    await freezeAs(p, thief.keys, "B-device", now());
    await expect(a.sync.rekey()).rejects.toBeInstanceOf(KeyChangeInProgressError);
    tick(FREEZE_TTL_MS - 1000);
    await expect(a.sync.rekey()).rejects.toBeInstanceOf(KeyChangeInProgressError);
    tick(2000);
    expect((await a.sync.rekey()).epoch).toBe(2);
  });

  it("a round's wait runs from the first of an unbroken run of freezes, whatever their digests", async () => {
    const { p, a, thief, now, tick } = await withThief();
    a.files.set("held.md", "waits for the key change");
    await freezeAs(p, thief.keys, "phone", now());
    expect((await a.sync.sync()).rekeyPending).toBe(true);
    tick(6 * 60_000);
    await freezeAs(p, thief.keys, "phone", now());
    expect((await a.sync.sync()).rekeyPending).toBe(true);
    tick(6 * 60_000); // 12 minutes after the first freeze, 6 after the newest
    await freezeAs(p, thief.keys, "phone", now());
    const r = await a.sync.sync();
    expect(r.rekeyPending).toBeUndefined();
    expect(r.uploaded).toBe(1);
    expect(a.store.state!.frozenSeen).toBeUndefined(); // the run is over: a later freeze is waited on in full
  });
});

describe("G2: a dropped marker counts only for the first epoch the device lacks", () => {
  it("an old genuine marker put back after a real revocation still gives RevokedError; enrolling again drops the device's marker", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    a.files.set("a.md", "hello");
    await a.sync.sync();
    const tablet = await generateIdentity();
    await a.sync.rekey({ enroll: { tablet: tablet.recipient } });
    await a.sync.sync();
    const u = await joinVault("U", p);
    await u.sync.sync();
    await u.sync.rekey({ dropDevices: true }); // epoch 2: the tablet is left out, with a marker
    const marker = ringJson(p).dropped;
    expect(marker.map((m: { epoch: number }) => m.epoch)).toEqual([2]);
    await a.sync.sync();
    await a.sync.enroll("tablet", tablet.recipient);
    expect(ringJson(p).dropped).toBeUndefined(); // enrolled again: no longer left out
    const tab = await enrolled(p, "tablet", tablet.identity);
    await tab.sync.sync();
    await a.sync.rekey({ revoke: ["tablet"] }); // epoch 3
    await expect(tab.sync.sync()).rejects.toThrow(/removed from the vault/);
    const ring = ringJson(p);
    ring.dropped = marker; // the storage kept it (it is outside the digest)
    p.objects.set(KEYRING_NAME, { data: utf8(JSON.stringify(ring)), etag: "replayed" });
    expect(await tab.sync.sync().then(() => "ok", errName)).toBe("RevokedError");
  });
});

describe("G3: no pairing code while this device changes keys", () => {
  async function stalled() {
    const p = memoryProvider();
    const a = await newVault(p);
    a.files.set("a.md", "hello");
    await a.sync.sync();
    const phone = await generateIdentity();
    await a.sync.rekey({ enroll: { phone: phone.recipient } });
    await a.sync.sync();
    let armed = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atPut = new Promise<void>((r) => (reached = r));
    const slow: SyncProvider = {
      ...p,
      get: (n) => p.get(n),
      list: () => p.list(),
      delete: (n) => p.delete(n),
      async put(n, d, c) {
        if (n === KEYRING_NAME && armed) {
          armed = false;
          reached();
          await gate;
        }
        return p.put(n, d, c);
      },
    };
    const a2 = device("A2", slow, a.sync.keys());
    a2.store.state = JSON.parse(JSON.stringify(a.store.state));
    a2.store.state!.deviceId = "A2";
    await a2.sync.sync();
    return { p, a2, arm: () => (armed = true), atPut, release };
  }

  it("asked mid-revocation (the keyring write stalled), the code is refused at once; afterwards it vouches for the new epoch", async () => {
    const { p, a2, arm, atPut, release } = await stalled();
    arm();
    const rk = a2.sync.rekey({ revoke: ["phone"] });
    await atPut;
    const err = await a2.sync.pairingCode().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(PairingDuringKeyChangeError);
    expect(e2eeErrorText(err)).toBe(t("e2ee.pair.rekeying"));
    release();
    expect((await rk).epoch).toBe(2);
    expect(await a2.sync.pairingCode()).toMatch(/^lumen-pair:4:2:/);
    expect(ringJson(p).epoch).toBe(2);
  });

  it("a pairing lock that became valid during the key change stops it before the keyring commit", async () => {
    const { p, a2 } = await stalled();
    // Another path on this device sets the lock after the re-key's first check (the second check is the one right before the commit).
    const engine = a2.sync as unknown as { state: { pairingUntil?: number }; checkNoPairingPending: () => Promise<void> };
    const check = engine.checkNoPairingPending.bind(a2.sync);
    let calls = 0;
    engine.checkNoPairingPending = async () => {
      if (++calls === 2) engine.state.pairingUntil = Date.now() + 60_000;
      return check();
    };
    const count = () => p.objects.size;
    const before = count();
    const e = await a2.sync.rekey({ revoke: ["phone"] }).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(PairingPendingError);
    expect(calls).toBe(2);
    expect(ringJson(p).epoch).toBe(1);
    expect(count()).toBe(before); // the new epoch's manifest was taken back; the old one is frozen by this device
  });
});

describe("G5: the sealed revoked list only grows; a local list that fails to verify is set aside", () => {
  async function revokedPhone() {
    const p = memoryProvider();
    const a = await newVault(p);
    a.files.set("a.md", "hello");
    await a.sync.sync();
    const phone = await generateIdentity();
    const tablet = await generateIdentity();
    await a.sync.rekey({ enroll: { phone: phone.recipient, tablet: tablet.recipient } });
    await a.sync.sync();
    await a.sync.rekey({ revoke: ["phone"] });
    await a.sync.sync();
    return { p, a, phone };
  }

  it("a restored state without revokedHere still refuses a keyring that lets the phone back in, and revokes it again", async () => {
    const { p, a, phone } = await revokedPhone();
    const keys = a.sync.keys();
    await rewriteKeyring(p, keys, { wrap: keys.wrap! }, (c, f) => ({ contents: { ...c, revoked: [], devices: { ...c.devices, phone: phone.recipient } }, file: f }));
    const restored = device("A", p, a.sync.keys());
    restored.store.state = JSON.parse(JSON.stringify(a.store.state));
    delete restored.store.state!.revokedHere;
    const err = await restored.sync.sync().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(KeyringForkError);
    expect((err as KeyringForkError).revocationReapplied).toEqual(["phone"]);
    expect(await wrapsFor(p, "phone", phone.identity)).toBeNull();
    expect(ringJson(p).epoch).toBe(3);
  });

  it("a keyring that only takes the phone off the sealed revoked list (not enrolled) is refused too", async () => {
    const { p, a } = await revokedPhone();
    const keys = a.sync.keys();
    await rewriteKeyring(p, keys, { wrap: keys.wrap! }, (c, f) => ({ contents: { ...c, revoked: [] }, file: f }));
    const restored = device("A", p, a.sync.keys());
    restored.store.state = JSON.parse(JSON.stringify(a.store.state));
    delete restored.store.state!.revokedHere;
    const err = await restored.sync.sync().then(() => null, (e) => e);
    expect((err as KeyringForkError).revocationReapplied).toEqual(["phone"]);
  });

  it("a local list that fails to verify is set aside and said once; the sealed list still holds", async () => {
    const { p, a } = await revokedPhone();
    const d = device("A", p, a.sync.keys());
    d.store.state = JSON.parse(JSON.stringify(a.store.state));
    d.store.state!.revokedHere!.mac = "AAAA";
    const r = await d.sync.sync();
    expect(r.revokedListReset).toBe(true);
    expect(e2eeResultNotices(r)).toEqual([t("e2ee.revokedHere.reset")]);
    expect((await d.sync.sync()).revokedListReset).toBeUndefined();
    expect(d.store.state!.sealedRevoked?.map((x) => x.device)).toEqual(["phone"]);
    const err = await d.sync.enroll("phone", (await generateIdentity()).recipient).then(() => null, (e) => e);
    expect(errName(err)).toBe("RevokedDeviceEnrollError");
  });
});
