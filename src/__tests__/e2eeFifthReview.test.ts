/**
 * Fifth crypto review 12.11 (F1 … F7, Q2, I3): pairing messages that can't
 * be passed off as one another, a re-key that waits out another device's
 * freeze, revocations that hold at any later epoch, no demotion of a device
 * whose anchor verifies, a drop that needs consent and says "pair again",
 * the next passphrase's KDF from the authenticated header, pair() and
 * unlockWithDevice() that check the anchor first, and "cancel pairing".
 * Real engine, real WebCrypto, the simulated provider folder.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { memoryProvider, PreconditionFailedError, proveCas, type SyncProvider } from "../sync/e2ee/provider";
import { createVault, DropDevicesRequiredError, E2eeSync, KeyChangeInProgressError, PairingPendingError, unlockVault, unlockWithDevice } from "../sync/e2ee/engine";
import { ageDecrypt, ageEncrypt, generateIdentity } from "../sync/e2ee/age";
import { bs, concat, fromB64u, fromUtf8, randomBytes, sha256Hex, toB64u, utf8 } from "../sync/e2ee/bytes";
import { HEADER_NAME, PROTOCOL_VERSION } from "../sync/e2ee/header";
import { epochKeys, hmac, seal } from "../sync/e2ee/keys";
import { WeakKdfError } from "../sync/e2ee/kdf";
import { anchorOf, DroppedFromVaultError, KEYRING_NAME, keyringAad, KeyringForkError, keyringDigest, keysFromKeyring, RevokedError, rewriteKeyring } from "../sync/e2ee/keyring";
import { memoryFiles } from "../sync/e2ee/localFiles";
import { blobName, FREEZE_TTL_MS, manifestName, sealManifest } from "../sync/e2ee/manifest";
import { createPairingCode, createPairingRequest, pairingLabel, PairingError, readPairingAnswer } from "../sync/e2ee/pairing";
import { memoryStateStore } from "../sync/e2ee/state";
import { e2eeErrorText } from "../sync/e2ee/ui/errorText";
import { t } from "../i18n";
import { device, joinVault, newVault, PASSPHRASE, TEST_POLICY } from "./helpers/e2ee";

type Provider = ReturnType<typeof memoryProvider>;
const ringJson = (p: Provider) => JSON.parse(fromUtf8(p.objects.get(KEYRING_NAME)!.data));
const copyOf = (p: Provider) => {
  const c = memoryProvider();
  for (const [k, v] of p.objects) c.objects.set(k, { data: v.data.slice(), etag: v.etag });
  return c;
};

async function wrapsFor(p: Provider, id: string, identity: string): Promise<Uint8Array | null> {
  const ring = ringJson(p);
  if (!ring.devices[id]) return null;
  return ageDecrypt(fromB64u(ring.devices[id].wrap), [{ identity }]).catch(() => null);
}

function enrolled(provider: SyncProvider, name: string, identity: string, store = memoryStateStore(), files = memoryFiles()) {
  return unlockWithDevice(provider, name, identity, store.state).then(({ keys }) => ({ files, store, sync: new E2eeSync({ provider, keys, local: files, store, access: { device: name, identity } }) }));
}

/** A copy of `d`'s state for another E2eeSync on the same device (a restart). */
const sameDevice = (from: { store: ReturnType<typeof memoryStateStore> }, to: { store: ReturnType<typeof memoryStateStore> }) => {
  to.store.state = JSON.parse(JSON.stringify(from.store.state));
};

/** The provider makes a whole keyring (and manifest) of its own for a device's public key (N1); `listed`: on its sealed list. */
async function forgeFor(p: Provider, vaultId: string, deviceId: string, recipient: string, anchor: { epoch: number; rev: number; digest: string }, listed: boolean) {
  const S = randomBytes(32);
  const epoch = anchor.epoch + 1;
  const ek = await epochKeys(S, vaultId);
  const contents = { older: { "0": toB64u(randomBytes(32)) }, revoked: [], devices: listed ? { [deviceId]: recipient } : {}, manifest: `manifest/${epoch}/${toB64u(randomBytes(16))}`, rev: 0, parent: anchor.digest, chain: [[anchor.epoch, anchor.rev, anchor.digest]] };
  const n = randomBytes(12);
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(n), additionalData: bs(keyringAad(vaultId, epoch, "sealed")) }, ek.keyring, bs(utf8(JSON.stringify(contents)))));
  const file = {
    format: "lumen-e2ee-keyring",
    protocol: 2,
    vaultId,
    epoch,
    passphrase: { n: toB64u(randomBytes(12)), c: toB64u(randomBytes(48)) },
    devices: { [deviceId]: { recipient, wrap: toB64u(await ageEncrypt(S, [{ x25519: recipient }])) } },
    sealed: { n: toB64u(n), c: toB64u(c) },
  };
  const keys = await keysFromKeyring(file as never, S, { header: null as never, wrap: null });
  const text = utf8("text the provider chose");
  const rev = toB64u(randomBytes(12));
  const bname = await blobName(keys, "a.md", rev);
  await p.put(bname, await seal(keys.blobs, vaultId, "blob", bname, text));
  const mname = await manifestName(keys);
  const m = { protocol: PROTOCOL_VERSION, vaultId, counter: 99, files: { "a.md": { ver: 99, rev, hash: await sha256Hex(text), size: text.length, by: "x", e: epoch } }, history: [] };
  const sm = await sealManifest(keys, m as never, mname);
  await p.put(mname, sm.bytes);
  await p.put(KEYRING_NAME, utf8(JSON.stringify(file)));
  return { keys, manifest: { counter: m.counter, digest: sm.digest }, ring: { epoch, rev: 0, digest: await keyringDigest(file as never) } };
}

/** A vault with A (the creator) and a phone enrolled at epoch 1. */
async function withPhone() {
  const p = memoryProvider();
  const a = await newVault(p);
  a.files.set("a.md", "hello");
  await a.sync.sync();
  const phone = await generateIdentity();
  await a.sync.rekey({ enroll: { phone: phone.recipient } });
  await a.sync.sync();
  return { p, a, phone };
}

describe("F1: pairing messages are domain-separated", () => {
  it("the new device's request, relabelled as an answer or a one-way code (old or new prefix), pairs nothing", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    await a.sync.sync();
    await a.sync.rekey();
    await a.sync.sync();
    const laptop = await joinVault("laptop", p);
    await laptop.sync.sync();
    const request = await laptop.sync.pairingRequest();
    expect(request).toMatch(/^lumen-pair-request:2:1:/);
    const tail = request.slice("lumen-pair-request:2:".length);
    for (const prefix of ["lumen-pair-answer:2:", "lumen-pair:3:", "lumen-pair-answer:1:", "lumen-pair:2:"]) {
      await expect(laptop.sync.pair(prefix + tail)).rejects.toBeInstanceOf(PairingError);
    }
    expect((await laptop.sync.freshness()).source).toBe("unverified");
    // The honest answer still pairs it.
    await laptop.sync.pair(await a.sync.answerPairing(request));
    expect((await laptop.sync.freshness()).source).toBe("paired");
  });

  it("an answer names the request's hash: an answer to an earlier request doesn't pair, and a body of another kind's shape is refused", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    await a.sync.sync();
    await a.sync.rekey();
    await a.sync.sync();
    const laptop = await joinVault("laptop", p);
    await laptop.sync.sync();
    const first = await laptop.sync.pairingRequest();
    const answer = await a.sync.answerPairing(first);
    await laptop.sync.pairingRequest(); // a new request replaces the answered one
    await expect(laptop.sync.pair(answer)).rejects.toThrow(/another request/);

    const keys = laptop.sync.keys();
    const now = 1_800_000_000_000;
    const { request } = await createPairingRequest(keys, null, now);
    const ring = anchorOf(keys);
    const make = async (body: object) => {
      const json = utf8(JSON.stringify(body));
      return `lumen-pair-answer:2:${keys.epoch}:${toB64u(concat(await hmac(keys.pairing, concat(pairingLabel("answer"), json)), json))}`;
    };
    const body = { kind: "answer", vaultId: keys.vaultId, request: request.hash, nonce: request.nonce, counter: 1, digest: "d".repeat(64), epoch: keys.epoch, ringRev: ring.rev, ringDigest: ring.digest, answeredAt: now };
    await expect(readPairingAnswer(keys, await make(body), request, now)).resolves.toMatchObject({ counter: 1 });
    await expect(readPairingAnswer(keys, await make({ ...body, issuedAt: now }), request, now)).rejects.toThrow(/damaged/); // a one-way code's field
    await expect(readPairingAnswer(keys, await make({ ...body, kind: "request" }), request, now)).rejects.toThrow(/damaged/);
    await expect(readPairingAnswer(keys, await make({ ...body, request: "0".repeat(64) }), request, now)).rejects.toThrow(/another request/);
  });
});

describe("Q2: a re-key waits out another device's fresh freeze, on its own clock", () => {
  /** Lane K's t8 race, with the restored assertion (`phoneSecret` null right after both re-keys). */
  async function race(mode: "cas" | "ignore" | "lie") {
    const { p, a, phone } = await withPhone();
    const laptop = await generateIdentity();
    const ignoreFor = (name: string) => mode === "ignore" || (mode === "lie" && name === KEYRING_NAME);
    const gate = () => {
      let open!: () => void;
      const w = new Promise<void>((r) => (open = r));
      return { wait: () => w, open };
    };
    const hooked = (before?: (name: string) => Promise<void>, after?: (name: string) => void): SyncProvider => ({
      ...p,
      id: "hooked",
      async put(n, d, c) {
        if (before) await before(n);
        const r = await p.put(n, d, ignoreFor(n) ? undefined : c);
        after?.(n);
        return r;
      },
    });
    const bReached = gate();
    const aDone = gate();
    const pb = hooked(async (n) => {
      if (n === KEYRING_NAME) {
        bReached.open();
        await aDone.wait();
      }
    });
    const { keys: bKeys } = await unlockVault(p, PASSPHRASE, TEST_POLICY);
    const b = device("B", pb, bKeys);
    await b.sync.sync();
    await b.sync.pair(await a.sync.pairingCode());
    let bPromise: Promise<unknown> | null = null;
    const pa = hooked(
      async (n) => {
        if (!bPromise && n === KEYRING_NAME) {
          bPromise = b.sync.rekey({ enroll: { laptop: laptop.recipient } }).then(
            (r) => r,
            (e) => {
              bReached.open();
              return e;
            },
          );
          await bReached.wait();
        }
      },
      (n) => {
        if (n === KEYRING_NAME) aDone.open();
      },
    );
    const a2 = device("A2", pa, a.sync.keys());
    await a2.sync.sync();
    await a2.sync.pair(await a.sync.pairingCode());
    const ra = await a2.sync.rekey({ revoke: ["phone"] }).then((r) => r, (e) => e);
    if (!bPromise) aDone.open();
    const rb = bPromise ? await bPromise : await b.sync.rekey({ enroll: { laptop: laptop.recipient } }).then((x) => x, (e) => e);
    const phoneSecret = await wrapsFor(p, "phone", phone.identity);
    a2.files.set("after.md", "after revoking the phone");
    const aErr = await a2.sync.sync().then(() => null, (e) => e);
    return { ra, rb, phoneSecret, aErr, epoch: ringJson(p).epoch };
  }

  it("with real compare-and-swap, and with a storage that ignores it (the probe refuses both)", async () => {
    const cas = await race("cas");
    expect(cas.rb).toBeInstanceOf(KeyChangeInProgressError);
    expect(cas.phoneSecret).toBeNull();
    const ignore = await race("ignore");
    expect((ignore.ra as Error).name).toBe("CasUnsupportedError");
    expect((ignore.rb as Error).name).toBe("CasUnsupportedError");
    expect(ignore.epoch).toBe(1);
  });

  it("a storage that passes the probe and drops If-Match on the keyring only: the revoked phone gets no new secret at all", async () => {
    const r = await race("lie");
    expect(r.rb).toBeInstanceOf(KeyChangeInProgressError);
    expect((r.ra as { devices: string[] }).devices).toEqual([]);
    expect(r.phoneSecret).toBeNull(); // the original t8 assertion
    expect(r.aErr).toBeNull(); // no fork: B never wrote
    expect(e2eeErrorText(r.rb)).toBe(t("e2ee.rekey.busy"));
  });

  it("after FREEZE_TTL_MS on its own clock, a re-key freezes over a freeze whose re-key never committed", async () => {
    let clock = 1_800_000_000_000;
    let failOn: string | null = null;
    const p = memoryProvider({
      fault(op, name, phase) {
        if (op === "put" && phase === "before" && name === failOn) {
          failOn = null;
          throw new Error("network down");
        }
      },
    });
    await proveCas(p);
    const a = await newVault(p);
    await a.sync.sync();
    await a.sync.rekey();
    await a.sync.sync();
    const b = device("B", p, a.sync.keys(), undefined, () => clock);
    sameDevice(a, b);
    b.store.state!.deviceId = "B-device";
    delete b.store.state!.pairingUntil;
    failOn = KEYRING_NAME;
    await expect(a.sync.rekey()).rejects.toThrow("network down"); // A froze, then was cut off
    await expect(b.sync.rekey()).rejects.toBeInstanceOf(KeyChangeInProgressError);
    clock += FREEZE_TTL_MS - 1;
    await expect(b.sync.rekey()).rejects.toBeInstanceOf(PreconditionFailedError);
    clock += 2;
    expect((await b.sync.rekey()).epoch).toBe(2);
  });
});

describe("F2: a revocation holds at any later epoch", () => {
  /** A storage that, right after A's next keyring write, shows B's world from `copy` instead (it ignored the compare-and-swap). */
  function lying(base: Provider, copy: Provider) {
    let armed = true;
    const p: SyncProvider = {
      ...base,
      id: "lying",
      async put(n, d, c) {
        if (n !== KEYRING_NAME || !armed) return base.put(n, d, c);
        armed = false;
        const r = await base.put(n, d, c);
        for (const [k, v] of copy.objects) base.objects.set(k, { data: v.data.slice(), etag: `${v.etag}-b` });
        return r;
      },
    };
    return p;
  }

  it("B's keyring that replaced A's revocation was re-keyed once more (epoch 3): A's next round revokes the phone again on top of it", async () => {
    const { p, a, phone } = await withPhone();
    const copy = copyOf(p);
    const b = device("B", copy, a.sync.keys());
    sameDevice(a, b);
    b.store.state!.deviceId = "B-device";
    await b.sync.rekey({ enroll: { laptop: (await generateIdentity()).recipient } }); // epoch 2', unaware of A's revocation
    await b.sync.rekey(); // epoch 3', from 2'
    const pa = lying(p, copy);
    await proveCas(pa);
    const a2 = device("A2", pa, a.sync.keys());
    sameDevice(a, a2);
    const r = await a2.sync.rekey({ revoke: ["phone"] });
    expect(r.confirmed).toBe(false);
    expect(ringJson(p).epoch).toBe(3);
    expect(await wrapsFor(p, "phone", phone.identity)).not.toBeNull();
    const err = await a2.sync.sync().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(KeyringForkError);
    expect((err as KeyringForkError).revocationReapplied).toEqual(["phone"]);
    expect(ringJson(p).epoch).toBe(4);
    expect(await wrapsFor(p, "phone", phone.identity)).toBeNull();
    expect(Object.keys(ringJson(p).devices)).toEqual(["laptop"]);
    await expect(a2.sync.sync()).resolves.toBeTruthy();
    expect(e2eeErrorText(err)).toBe(t("e2ee.fork.reapplied"));
  });

  it("a keyring that descends from A's but lets the phone back in (by id, then by key under another id) is revoked again at A's next round", async () => {
    const { p, a, phone } = await withPhone();
    await a.sync.rekey({ revoke: ["phone"] });
    await a.sync.sync();
    const readmit = async (id: string) => {
      // A holder of the epoch's secret writes it without the engine's checks.
      const keys = a.sync.keys();
      await rewriteKeyring(p, keys, { wrap: keys.wrap! }, (c, f) => ({ contents: { ...c, revoked: [], devices: { ...c.devices, [id]: phone.recipient } }, file: f }));
    };
    await readmit("phone");
    expect(await wrapsFor(p, "phone", phone.identity)).not.toBeNull();
    const err = await a.sync.sync().then(() => null, (e) => e);
    expect((err as KeyringForkError).revocationReapplied).toEqual(["phone"]);
    expect(await wrapsFor(p, "phone", phone.identity)).toBeNull();
    await a.sync.sync();
    await readmit("phone-2");
    const err2 = await a.sync.sync().then(() => null, (e) => e);
    // The readmitting keyring also emptied the sealed revoked list: under G5 (seventh review) that is a readmission of "phone" too.
    expect((err2 as KeyringForkError).revocationReapplied).toEqual(["phone-2", "phone"]);
    expect(ringJson(p).devices["phone-2"]).toBeUndefined();
    // A re-key of A's leaves the key out too, whatever id it is listed under.
    await a.sync.sync();
    await readmit("phone-3");
    const rk = await a.sync.rekey();
    expect(rk.devices).toEqual([]);
    expect(ringJson(p).devices["phone-3"]).toBeUndefined();
    expect(ringJson(p).epoch).toBe(5);
  });

  it("the list of devices this device revoked is authenticated, and a fork it can't repair says the revocation may be undone", async () => {
    const { p, a } = await withPhone();
    const copy = copyOf(p);
    const b = device("B", copy, a.sync.keys());
    sameDevice(a, b);
    b.store.state!.deviceId = "B-device";
    await b.sync.rekey({ revoke: ["phone"] }); // 2' (another secret), which revoked the phone too: nothing to re-apply
    await a.sync.rekey({ revoke: ["phone"] });
    // A changed list doesn't verify.
    const t1 = device("A", p, a.sync.keys());
    sameDevice(a, t1);
    t1.store.state!.revokedHere!.devices = [];
    // Seventh review G5: set aside and said, not a wedge; the sealed lists this device adopted still hold.
    expect((await t1.sync.sync()).revokedListReset).toBe(true);
    expect(t1.store.state!.revokedHere).toBeUndefined();
    expect(t1.store.state!.sealedRevoked?.map((d) => d.device)).toEqual(["phone"]);
    expect((await t1.sync.sync()).revokedListReset).toBeUndefined();
    // The storage shows B's epoch 2': A can't repair it, and says what is at risk.
    p.objects.set(KEYRING_NAME, { ...copy.objects.get(KEYRING_NAME)! });
    const err = await a.sync.sync().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(KeyringForkError);
    expect((err as KeyringForkError).revocationReapplied).toEqual([]);
    expect((err as KeyringForkError).revocationAtRisk).toEqual(["phone"]);
    expect(e2eeErrorText(err)).toBe(t("e2ee.fork.atRisk"));
    expect(e2eeErrorText(new KeyringForkError("x"))).toBe(t("e2ee.fork.refused"));
  });
});

describe("F3: no demotion while the anchor verifies; no drop without consent", () => {
  it("a paired laptop away for 101 commits keeps uploading, and its revocation keeps the tablet", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    a.files.set("a.md", "hello");
    await a.sync.sync();
    const phone = await generateIdentity();
    const tablet = await generateIdentity();
    await a.sync.rekey({ enroll: { phone: phone.recipient, tablet: tablet.recipient } });
    await a.sync.sync();
    const laptop = await joinVault("laptop", p);
    await laptop.sync.sync();
    await laptop.sync.pair(await a.sync.pairingCode());
    for (let i = 0; i < 101; i++) {
      a.files.set("a.md", `edit ${i}`);
      await a.sync.sync();
    }
    laptop.files.set("l.md", "written after a while away");
    const r = await laptop.sync.sync();
    expect((await laptop.sync.freshness()).source).toBe("paired");
    expect(r.uploaded).toBe(1);
    const rk = await laptop.sync.rekey({ revoke: ["phone"] });
    expect(rk.devices).toEqual(["tablet"]);
    expect(rk.dropped).toBeUndefined();
  });

  it("a paired laptop away for more than 64 keyring revisions stays paired", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    await a.sync.sync();
    await a.sync.rekey();
    await a.sync.sync();
    const laptop = await joinVault("laptop", p);
    await laptop.sync.sync();
    await laptop.sync.pair(await a.sync.pairingCode());
    let keys = a.sync.keys();
    for (let i = 0; i < 66; i++) keys = await rewriteKeyring(p, keys, { wrap: keys.wrap! }, (c, f) => ({ contents: c, file: f }));
    laptop.files.set("l.md", "x");
    expect((await laptop.sync.sync()).uploaded).toBe(1);
    expect((await laptop.sync.freshness()).source).toBe("paired");
    expect(laptop.sync.keys().ring!.rev).toBe(66);
  });

  it("an unverified device's re-key that would leave devices out is refused until the user confirms who", async () => {
    const { p } = await withPhone();
    const b = await joinVault("B", p);
    await b.sync.sync();
    const err = await b.sync.rekey({ revoke: ["lost"] }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(DropDevicesRequiredError);
    expect((err as DropDevicesRequiredError).devices).toEqual(["phone"]);
    expect(e2eeErrorText(err)).toBe(t("e2ee.rekey.dropConfirm", { devices: "phone" }));
    expect(ringJson(p).epoch).toBe(1);
    expect(await b.sync.rekey({ dropDevices: true })).toMatchObject({ epoch: 2, devices: [], dropped: true });
  });
});

describe("F4: a device left out by a dropped re-key is told to pair again", () => {
  it("DroppedFromVaultError at the open and at the round; a marker the storage made up is a revocation; a later re-key carries the marker", async () => {
    const { p, a, phone } = await withPhone();
    const tablet = await generateIdentity();
    await a.sync.enroll("tablet", tablet.recipient);
    const tab = await enrolled(p, "tablet", tablet.identity);
    await tab.sync.sync();
    const evil = await joinVault("evil", p);
    await evil.sync.sync();
    const r = await evil.sync.rekey({ dropDevices: true });
    expect(r).toMatchObject({ dropped: true, devices: [] });
    expect(ringJson(p).dropped[0]).toMatchObject({ epoch: 2, devices: ["phone", "tablet"] });
    await expect(unlockWithDevice(p, "tablet", tablet.identity)).rejects.toBeInstanceOf(DroppedFromVaultError);
    await expect(tab.sync.sync()).rejects.toBeInstanceOf(DroppedFromVaultError);
    expect(e2eeErrorText(new DroppedFromVaultError(2))).toBe(t("e2ee.dropped"));
    // The owner re-enrolls the tablet; the phone's marker is carried by the next re-key.
    await a.sync.sync();
    await a.sync.enroll("tablet", tablet.recipient);
    await a.sync.rekey();
    expect(ringJson(p).dropped).toEqual([expect.objectContaining({ epoch: 2, devices: ["phone"] })]);
    await expect(unlockWithDevice(p, "tablet", tablet.identity)).resolves.toBeTruthy();
    await expect(unlockWithDevice(p, "phone", phone.identity)).rejects.toBeInstanceOf(DroppedFromVaultError);
    // A revoked device the storage marks as "dropped": the running device checks the marker and says removed.
    const q = await withPhone();
    const ph = await enrolled(q.p, "phone", q.phone.identity);
    await ph.sync.sync();
    await q.a.sync.rekey({ revoke: ["phone"] });
    const ring = ringJson(q.p);
    ring.dropped = [{ epoch: 2, at: 1, devices: ["phone"], mac: toB64u(randomBytes(32)) }];
    q.p.objects.set(KEYRING_NAME, { data: utf8(JSON.stringify(ring)), etag: "marked" });
    await expect(ph.sync.sync()).rejects.toBeInstanceOf(RevokedError);
    expect(e2eeErrorText(new RevokedError())).toBe(t("e2ee.revoked"));
  });
});

describe("F5: the next passphrase's KDF comes from the authenticated header", () => {
  it("a header the storage changed for that one read doesn't move an Argon2id vault to PBKDF2; neither does asking", async () => {
    const base = memoryProvider();
    const { keys, anchor } = await createVault(base, PASSPHRASE); // production default: Argon2id
    let armed = false;
    const p: SyncProvider = {
      ...base,
      async get(name) {
        const r = await base.get(name);
        if (armed && name === HEADER_NAME && r) {
          armed = false;
          const h = JSON.parse(fromUtf8(r.data));
          h.kdf = { alg: "pbkdf2-sha256", iterations: 600_000, salt: h.kdf.salt };
          return { data: utf8(JSON.stringify(h)), etag: r.etag };
        }
        return r;
      },
    };
    const a = device("A", p, keys);
    await a.sync.markCreated(anchor);
    await a.sync.sync();
    await expect(a.sync.rekey({ newPassphrase: "a new passphrase 2026", kdf: "pbkdf2-sha256" })).rejects.toBeInstanceOf(WeakKdfError);
    armed = true;
    await a.sync.rekey({ newPassphrase: "a new passphrase for the vault 2026" });
    expect(JSON.parse(fromUtf8(base.objects.get(HEADER_NAME)!.data)).kdf.alg).toBe("argon2id");
  });
});

describe("F6 and F7: the anchor first", () => {
  it("F6: pair() refuses a code made under keys that don't reproduce the device's anchor", async () => {
    const { p, a, phone } = await withPhone();
    const store = memoryStateStore();
    const files = memoryFiles();
    const d1 = await enrolled(p, "phone", phone.identity, store, files);
    await d1.sync.sync();
    await d1.sync.pair(await a.sync.pairingCode());
    const forged = await forgeFor(p, a.sync.keys().vaultId, "phone", phone.recipient, store.state!.ring!, true);
    const { keys } = await unlockWithDevice(p, "phone", phone.identity); // a restart without its state
    const d2 = new E2eeSync({ provider: p, keys, local: files, store, access: { device: "phone", identity: phone.identity } });
    const code = await createPairingCode(forged.keys, forged.manifest, Date.now(), forged.ring);
    const before = JSON.stringify(store.state!.ring);
    await expect(d2.pair(code)).rejects.toBeInstanceOf(KeyringForkError);
    expect(JSON.stringify(store.state!.ring)).toBe(before);
  });

  it("F7: with saved state, a forged keyring that leaves the device out is a fork, not a revocation", async () => {
    const { p, a, phone } = await withPhone();
    const store = memoryStateStore();
    const d = await enrolled(p, "phone", phone.identity, store);
    await d.sync.sync();
    await d.sync.pair(await a.sync.pairingCode());
    await forgeFor(p, a.sync.keys().vaultId, "phone", phone.recipient, store.state!.ring!, false);
    await expect(unlockWithDevice(p, "phone", phone.identity, store.state)).rejects.toBeInstanceOf(KeyringForkError);
    await expect(unlockWithDevice(p, "phone", phone.identity)).rejects.toBeInstanceOf(RevokedError); // without state it can't tell
  });
});

describe("I3: cancel pairing", () => {
  it("an urgent revocation needn't wait for an answer to expire; the new device forgets its request", async () => {
    const { p, a } = await withPhone();
    const laptop = await joinVault("laptop", p);
    await laptop.sync.sync();
    const answer = await a.sync.answerPairing(await laptop.sync.pairingRequest());
    await expect(a.sync.rekey({ revoke: ["phone"] })).rejects.toBeInstanceOf(PairingPendingError);
    await a.sync.cancelPairing();
    expect((await a.sync.rekey({ revoke: ["phone"] })).devices).toEqual([]);
    await laptop.sync.cancelPairing();
    await expect(laptop.sync.pair(answer)).rejects.toBeInstanceOf(PairingError);
    expect((await laptop.sync.freshness()).source).toBe("unverified");
  });
});
