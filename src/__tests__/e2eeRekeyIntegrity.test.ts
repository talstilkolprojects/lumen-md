/**
 * Review 12.11 (findings 1 and 2) and its re-review (RR-1 … RR-10): the
 * keyring's device list is authenticated, revoked devices stay out, a
 * keyring that doesn't descend from the verified one is refused, a re-key
 * commits with one keyring write, a freeze is called off through the
 * keyring, and only verified devices on a provider with working conditional
 * writes change keys or devices.
 * Real engine, real WebCrypto, the simulated provider folder.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { CasUnsupportedError, memoryProvider, PreconditionFailedError, proveCas, type SyncProvider } from "../sync/e2ee/provider";
import { E2eeSync, PairingPendingError, unlockVault, unlockWithDevice, UnverifiedDeviceError } from "../sync/e2ee/engine";
import { ageDecrypt, ageEncrypt, generateIdentity } from "../sync/e2ee/age";
import { bs, fromB64u, fromUtf8, randomBytes, toB64u, utf8 } from "../sync/e2ee/bytes";
import { HEADER_NAME, WrongPassphraseError } from "../sync/e2ee/header";
import {
  KEYRING_NAME,
  keyringContents,
  keyringDigest,
  KeyringForkError,
  KeyringRollbackError,
  PreReleaseKeyringError,
  RevokedDeviceEnrollError,
  TamperedWrapError,
} from "../sync/e2ee/keyring";
import { memoryFiles } from "../sync/e2ee/localFiles";
import { FREEZE_TTL_MS, manifestName, manifestNameFor, openManifest, sealManifest } from "../sync/e2ee/manifest";
import { memoryStateStore } from "../sync/e2ee/state";
import { pairConfirmed, relayBetween, device, joinTrusted, joinVault, newVault, PASSPHRASE, TEST_ITERATIONS, TEST_POLICY, type Device } from "./helpers/e2ee";

type Provider = ReturnType<typeof memoryProvider>;

/**
 * A pairing code made by a copy of `d` (its keys and state now), so `d`
 * itself stays free to change keys: a device makes no key change while a
 * code of its own is valid (third review N3).
 */
async function codeFrom(p: SyncProvider, d: Device): Promise<string> {
  const issuer = device(`${d.name}-issuer`, p, d.sync.keys());
  issuer.store.state = JSON.parse(JSON.stringify(d.store.state));
  codeIssuer = issuer;
  return issuer.sync.pairingCode();
}
/** The device `codeFrom` made its last code on (it confirms the comparison, plan W8.5). */
let codeIssuer: Device | null = null;

/** The provider edits the keyring's plaintext JSON (it can't touch the sealed part). */
function tamper(p: Provider, edit: (ring: { devices: Record<string, { recipient: string; wrap: string }> }) => void) {
  const obj = p.objects.get(KEYRING_NAME)!;
  const ring = JSON.parse(fromUtf8(obj.data));
  edit(ring);
  p.objects.set(KEYRING_NAME, { data: utf8(JSON.stringify(ring)), etag: obj.etag });
}

const ringJson = (p: Provider) => JSON.parse(fromUtf8(p.objects.get(KEYRING_NAME)!.data));

async function wrapsFor(p: Provider, id: string, identity: string): Promise<Uint8Array | null> {
  const ring = ringJson(p);
  if (!ring.devices[id]) return null;
  return ageDecrypt(fromB64u(ring.devices[id].wrap), [{ identity }]).catch(() => null);
}

async function enrolled(provider: SyncProvider, name: string, identity: string) {
  const { keys } = await unlockWithDevice(provider, name, identity);
  const files = memoryFiles();
  return { files, sync: new E2eeSync({ provider, keys, local: files, store: memoryStateStore(), access: { device: name, identity } }) };
}

/** A provider whose next matching put fails once (network down), when armed. Its conditional writes are proven up front. */
async function flaky() {
  let failOn: ((name: string) => boolean) | null = null;
  const p = memoryProvider({
    fault(op, name, phase) {
      if (failOn && op === "put" && phase === "before" && failOn(name)) {
        failOn = null;
        throw new Error("network down");
      }
    },
  });
  await proveCas(p);
  return { p, failNext: (f: (name: string) => boolean) => (failOn = f) };
}

/** Rewrite the stored keyring as a pre-release build (protocol 1) wrote it: no sealed list, no chain. */
async function asPreRelease(p: Provider, keys: ReturnType<E2eeSync["keys"]>) {
  const ring = ringJson(p);
  const c = await keyringContents(ring, keys);
  const ad = (role: string) => utf8(`lumen-e2ee-keyring/1/${ring.vaultId}/${ring.epoch}/${role}`);
  const seal = async (key: CryptoKey, data: Uint8Array, role: string) => {
    const n = randomBytes(12);
    return { n: toB64u(n), c: toB64u(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(n), additionalData: bs(ad(role)) }, key, bs(data)))) };
  };
  ring.protocol = 1;
  ring.passphrase = await seal(keys.wrap!, keys.secret, "passphrase");
  ring.sealed = await seal(keys.keyring, utf8(JSON.stringify({ older: c.older, revoked: c.revoked, manifest: c.manifest })), "sealed");
  p.objects.set(KEYRING_NAME, { data: utf8(JSON.stringify(ring)), etag: "pre-release" });
  return ring;
}

describe("finding 1: the device list is authenticated", () => {
  it("a recipient the provider adds gets no wrap at the next re-key, and the manifest stays closed to it", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    a.files.set("secret.md", "the source's name");
    await a.sync.sync();
    await a.sync.rekey();
    const evil = await generateIdentity();
    tamper(p, (r) => (r.devices.evil = { recipient: evil.recipient, wrap: "AAAA" }));
    await a.sync.sync();
    const r = await a.sync.rekey({ revoke: ["phone"] });
    expect(r.devices).toEqual([]);
    expect(await wrapsFor(p, "evil", evil.identity)).toBeNull();
  });

  it("a revoked device the provider puts back (its real key, its old wrap) stays out", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    a.files.set("a.md", "before");
    await a.sync.sync();
    const phone = await generateIdentity();
    const laptop = await generateIdentity();
    await a.sync.rekey({ enroll: { phone: phone.recipient, laptop: laptop.recipient } });
    const oldWrap = ringJson(p).devices.phone;
    const lost = await enrolled(p, "phone", phone.identity);
    await lost.sync.sync();

    await a.sync.rekey({ revoke: ["phone"] });
    // The provider puts the phone back into the plaintext map, twice over: its old wrap…
    tamper(p, (r) => (r.devices.phone = oldWrap));
    // (third review N5: a wrap that doesn't open the keyring says so, not "removed")
    await expect(unlockWithDevice(p, "phone", phone.identity)).rejects.toBeInstanceOf(TamperedWrapError);
    await expect(lost.sync.sync()).rejects.toBeInstanceOf(TamperedWrapError);
    // …and its recipient, so that the next re-key would wrap for it.
    tamper(p, (r) => (r.devices.phone = { recipient: phone.recipient, wrap: oldWrap.wrap }));
    await a.sync.sync();
    const r = await a.sync.rekey();
    expect(r.devices).toEqual(["laptop"]);
    expect(await wrapsFor(p, "phone", phone.identity)).toBeNull();
    // A revoked id or key can't be enrolled again by mistake, at a re-key or without one.
    await expect(a.sync.rekey({ enroll: { phone: (await generateIdentity()).recipient } })).rejects.toBeInstanceOf(RevokedDeviceEnrollError);
    await expect(a.sync.rekey({ enroll: { "phone-2": phone.recipient } })).rejects.toBeInstanceOf(RevokedDeviceEnrollError);
    await expect(a.sync.enroll("phone-3", phone.recipient)).rejects.toBeInstanceOf(RevokedDeviceEnrollError);
    // The laptop is untouched by all of it.
    const kept = await enrolled(p, "laptop", laptop.identity);
    await kept.sync.sync();
    expect(kept.files.text("a.md")).toBe("before");
  });

  it("RR-1: a pre-release keyring (no sealed list) is refused at every open; the passphrase resets it for nobody else", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    a.files.set("a.md", "kept");
    await a.sync.sync();
    const phone = await generateIdentity();
    await a.sync.rekey({ enroll: { phone: phone.recipient } });
    const ring = await asPreRelease(p, a.sync.keys());
    // A well-formed age file to the provider's own key: the old filter let this through.
    const evil = await generateIdentity();
    const evilWrap = toB64u(await ageEncrypt(randomBytes(32), [{ x25519: evil.recipient }]));
    tamper(p, (r) => (r.devices.evil = { recipient: evil.recipient, wrap: evilWrap }));
    await expect(joinVault("B", p)).rejects.toBeInstanceOf(PreReleaseKeyringError);
    await expect(unlockWithDevice(p, "phone", phone.identity)).rejects.toBeInstanceOf(PreReleaseKeyringError);
    await expect(a.sync.sync()).rejects.toBeInstanceOf(PreReleaseKeyringError); // even on a device that knew the real one
    // The reset: the passphrase, explicitly.
    const { keys } = await unlockVault(p, PASSPHRASE, TEST_POLICY, { resetPreReleaseKeyring: true });
    const r = device("R", p, keys);
    await expect(r.sync.sync()).rejects.toBeInstanceOf(PreReleaseKeyringError);
    const out = await r.sync.rekey();
    expect(out.epoch).toBe(ring.epoch + 1);
    expect(out.devices).toEqual([]);
    expect(await wrapsFor(p, "evil", evil.identity)).toBeNull();
    expect(await wrapsFor(p, "phone", phone.identity)).toBeNull();
    const c = await joinVault("C", p);
    await c.sync.sync();
    expect(c.files.text("a.md")).toBe("kept");
    // The phone enrolls again, from a verified device (here: confirmed by hand).
    await c.sync.confirmFreshness();
    await c.sync.enroll("phone", phone.recipient);
    expect(await wrapsFor(p, "phone", phone.identity)).not.toBeNull();
  });
});

describe("RR-2: the keyring chain", () => {
  it("another keyring at the same epoch (sealed with another secret) is a fork; an older revision is a rollback", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    await a.sync.sync();
    await a.sync.rekey(); // 1.0
    const rev0 = p.objects.get(KEYRING_NAME)!;
    const laptop = await generateIdentity();
    await a.sync.enroll("laptop", laptop.recipient); // 1.1
    expect(ringJson(p).epoch).toBe(1);
    // The provider undoes the enrollment by serving 1.0 again.
    const rev1 = p.objects.get(KEYRING_NAME)!;
    p.objects.set(KEYRING_NAME, { data: rev0.data, etag: "replayed" });
    await expect(a.sync.sync()).rejects.toBeInstanceOf(KeyringRollbackError);
    p.objects.set(KEYRING_NAME, rev1);
    await a.sync.sync();
    // A second device re-keys from 1.1 on a copy the first never sees (withheld): same epoch number 2 twice.
    const fork = memoryProvider();
    for (const [k, v] of p.objects) fork.objects.set(k, { data: v.data.slice(), etag: v.etag });
    const b = device("B", fork, a.sync.keys());
    await b.sync.sync();
    const forB = await codeFrom(p, a);
    await pairConfirmed(b, codeIssuer!, forB, relayBetween(p, fork));
    await b.sync.rekey();
    await a.sync.rekey();
    p.objects.set(KEYRING_NAME, fork.objects.get(KEYRING_NAME)!);
    await expect(a.sync.sync()).rejects.toBeInstanceOf(KeyringForkError);
  });

  it("each keyring names its parent and revision; a fresh device follows the chain", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    await a.sync.sync();
    await a.sync.rekey();
    const d1 = await keyringDigest(ringJson(p));
    await a.sync.enroll("x", (await generateIdentity()).recipient);
    const d2 = await keyringDigest(ringJson(p));
    await a.sync.rekey();
    const c = await keyringContents(ringJson(p), a.sync.keys());
    expect(c.rev).toBe(0);
    expect(c.parent).toBe(d2);
    expect(d1).not.toBe(d2);
    expect(c.chain).toEqual([
      [1, 0, d1],
      [1, 1, d2],
    ]);
    expect(c.manifest).toMatch(/^manifest\/2\/[A-Za-z0-9_-]{22}$/);
  });
});

describe("finding 2: a re-key cut off at any write", () => {
  it("before the keyring (the new manifest or the keyring write lost): nothing committed; pulls go on, pushes wait; running it again finishes", async () => {
    for (const cut of ["manifest", "keyring"] as const) {
      const { p, failNext } = await flaky();
      const a = await newVault(p);
      a.files.set("a.md", "one");
      await a.sync.sync();
      const b = await joinTrusted("B", p);
      await b.sync.sync();
      const old = await manifestName(a.sync.keys());
      failNext((n) => (cut === "keyring" ? n === KEYRING_NAME : n !== KEYRING_NAME && n !== old && n !== HEADER_NAME));
      await expect(a.sync.rekey()).rejects.toThrow("network down");
      expect(p.objects.has(KEYRING_NAME)).toBe(false);
      a.files.set("a.md", "two");
      b.files.set("b.md", "from B");
      const rb = await b.sync.sync();
      expect(rb.rekeyPending).toBe(true);
      expect(rb.uploaded).toBe(0);
      const r = await a.sync.rekey();
      expect(r.epoch).toBe(1);
      await a.sync.sync();
      await b.sync.sync();
      await a.sync.sync();
      expect(a.files.text("b.md")).toBe("from B");
      expect(b.files.text("a.md")).toBe("two");
    }
  });

  it("RR-3: junk at the new epoch's manifest is replaced from the frozen manifest the keyring names; a write over that frozen one changes nothing", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    a.files.set("a.md", "hello");
    await a.sync.sync();
    const keys0 = a.sync.keys();
    const old = await manifestName(keys0);
    await a.sync.rekey();
    // A holder of the epoch-0 keys (a device revoked by this re-key, say) writes over the frozen manifest…
    const { manifest } = await openManifest(keys0, p.objects.get(old)!.data, old);
    expect(manifest.frozen?.epoch).toBe(1);
    const planted = { ...manifest, protocol: 1, counter: manifest.counter + 1, files: { ...manifest.files, "evil.md": { ...manifest.files["a.md"], ver: 1 } } };
    delete planted.frozen;
    p.objects.set(old, { data: (await sealManifest(keys0, planted, old)).bytes, etag: "planted" });
    const b = await joinVault("B", p);
    await b.sync.sync();
    expect(b.files.files.has("evil.md")).toBe(false);
    expect(b.files.text("a.md")).toBe("hello");
    // …and junk lands under the new manifest's name: devices put the frozen manifest's successor back.
    const name = await manifestName(a.sync.keys());
    p.objects.set(old, { data: (await sealManifest(keys0, manifest, old)).bytes, etag: "restored" }); // the frozen one, intact
    p.objects.set(name, { data: randomBytes(300), etag: "junk" });
    const c = await joinTrusted("C", p);
    await c.sync.sync();
    expect(c.files.text("a.md")).toBe("hello");
    c.files.set("c.md", "after");
    await c.sync.sync();
    await b.sync.sync();
    expect(b.files.text("c.md")).toBe("after");
  });

  it("RR-4: a freeze abandoned at epoch 0 — after FREEZE_TTL_MS on its own clock, a device finishes the re-key for the passphrase", async () => {
    let clock = 1_800_000_000_000;
    const now = () => clock;
    const { p, failNext } = await flaky();
    const a = await newVault(p);
    await a.sync.sync();
    const b = await joinTrusted("B", p, undefined, now);
    await b.sync.sync();
    failNext((n) => n === KEYRING_NAME);
    await expect(a.sync.rekey()).rejects.toThrow("network down");
    b.files.set("b.md", "from B");
    expect((await b.sync.sync()).rekeyPending).toBe(true);
    clock += FREEZE_TTL_MS - 1;
    expect((await b.sync.sync()).rekeyPending).toBe(true);
    clock += 2;
    const r = await b.sync.sync();
    expect(r.rekeyPending).toBeFalsy();
    expect(r.uploaded).toBe(1);
    expect(b.sync.keys().epoch).toBe(1);
    await a.sync.sync();
    expect(a.files.text("b.md")).toBe("from B");
  });

  it("RR-4: a freeze called off at epoch 1 goes through the keyring, so the re-keyer's late commit fails and nothing is lost", async () => {
    let clock = 1_800_000_000_000;
    const p = memoryProvider();
    const a = await newVault(p);
    a.files.set("a.md", "v1");
    await a.sync.sync();
    await a.sync.rekey(); // epoch 1
    await a.sync.sync();
    const b = await joinTrusted("B", p, undefined, () => clock);
    await b.sync.sync();
    // A's keyring write is held until B has waited out the freeze and written over it.
    let fired = false;
    const held: SyncProvider = {
      ...p,
      id: "held",
      async put(n, d, c) {
        if (!fired && n === KEYRING_NAME) {
          fired = true;
          b.files.set("a.md", "v2 from B");
          expect((await b.sync.sync()).rekeyPending).toBe(true);
          clock += FREEZE_TTL_MS;
          const rb = await b.sync.sync();
          expect(rb.uploaded).toBe(1);
        }
        return p.put(n, d, c);
      },
    };
    const a2 = device("A2", held, a.sync.keys());
    await a2.sync.sync();
    await pairConfirmed(a2, a, await a.sync.pairingCode());
    await expect(a2.sync.rekey()).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(ringJson(p).epoch).toBe(1);
    expect((await keyringContents(ringJson(p), b.sync.keys())).aborted).toHaveLength(1);
    // B's blob v1 is held one round, then deleted; the vault has v2 for everyone.
    await b.sync.sync();
    await b.sync.sync();
    const c = await joinVault("C", p);
    const rc = await c.sync.sync();
    expect(rc.incomplete).toBe(false);
    expect(c.files.text("a.md")).toBe("v2 from B");
    await a2.sync.sync();
    expect(a2.files.text("a.md")).toBe("v2 from B");
    // The re-key runs again cleanly.
    expect((await a2.sync.rekey()).epoch).toBe(2);
  });

  it("a passphrase change cut off before the header: the old passphrase opens the epoch before, the new one opens and finishes it; then the keyring forgets both", async () => {
    for (const startEpoch of [0, 1]) {
      const { p, failNext } = await flaky();
      const a = await newVault(p);
      a.files.set("x.md", "x");
      await a.sync.sync();
      for (let i = 0; i < startEpoch; i++) await a.sync.rekey();
      const NEW = "a brand new passphrase 2026";
      failNext((n) => n === HEADER_NAME);
      await expect(a.sync.rekey({ newPassphrase: NEW, pbkdf2Iterations: TEST_ITERATIONS })).rejects.toThrow("network down");
      expect(typeof ringJson(p).header).toBe("string");
      expect(typeof ringJson(p).prev).toBe(startEpoch > 0 ? "string" : "undefined");
      // The old passphrase: the epoch before the change, never the new one.
      const old = await unlockVault(p, PASSPHRASE, TEST_POLICY);
      expect(old.keys.epoch).toBe(startEpoch);
      // The new one: the new epoch; it writes the header the re-key could not.
      const fresh = await unlockVault(p, NEW, TEST_POLICY);
      expect(fresh.keys.epoch).toBe(startEpoch + 1);
      await expect(unlockVault(p, PASSPHRASE, TEST_POLICY)).rejects.toBeInstanceOf(WrongPassphraseError);
      const d = device("D", p, fresh.keys);
      await d.sync.sync();
      expect(d.files.text("x.md")).toBe("x");
      // RR-6: the next round drops the pending header and the previous keyring.
      expect(ringJson(p).header).toBeUndefined();
      expect(ringJson(p).prev).toBeUndefined();
      await a.sync.sync().catch(() => undefined);
    }
  });
});

describe("re-review 12.11: who may change keys", () => {
  it("RR-5/N6: a device opened with the passphrase alone pulls, keeps its changes, can't enroll, and re-keys for the passphrase only until paired", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    a.files.set("a.md", "x");
    await a.sync.sync();
    const phone = await generateIdentity();
    await a.sync.rekey({ enroll: { phone: phone.recipient } });
    await a.sync.sync();
    const b = await joinVault("B", p);
    await b.sync.sync();
    expect(b.files.text("a.md")).toBe("x");
    // N6: its edits wait on it.
    b.files.set("b.md", "from B");
    const held = await b.sync.sync();
    expect(held.uploaded).toBe(0);
    expect(held.waiting).toEqual(["b.md"]);
    await expect(b.sync.enroll("t", (await generateIdentity()).recipient)).rejects.toBeInstanceOf(UnverifiedDeviceError);
    // It can't vouch for the device list: its re-key would wrap the next epoch for no device (they pair again),
    // so it needs the user's consent, after the UI showed who (fifth review F3).
    await expect(b.sync.rekey()).rejects.toMatchObject({ name: "DropDevicesRequiredError", devices: ["phone"] });
    const r = await b.sync.rekey({ dropDevices: true });
    expect(r).toMatchObject({ epoch: 2, devices: [], dropped: true, confirmed: true });
    expect(await wrapsFor(p, "phone", phone.identity)).toBeNull();
    // Paired (two-way), it uploads what waited, and its re-keys carry the device list again.
    await a.sync.sync();
    await pairConfirmed(b, a, await a.sync.answerPairing(await b.sync.pairingRequest()));
    expect((await b.sync.sync()).uploaded).toBe(1);
    await a.sync.sync();
    expect(a.files.text("b.md")).toBe("from B");
    await expect(a.sync.enroll("laptop", (await generateIdentity()).recipient)).rejects.toBeInstanceOf(PairingPendingError); // its answer is still valid (N3)
    await b.sync.enroll("laptop", (await generateIdentity()).recipient);
    expect((await b.sync.rekey()).devices).toEqual(["laptop"]);
  });

  it("RR-5: a pairing code names the keyring; a code from another lineage at the same revision is refused", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    await a.sync.sync();
    await a.sync.rekey();
    const code = await a.sync.pairingCode();
    expect(code).toMatch(/^lumen-pair:4:1:/);
    // The same vault on a withheld copy, re-sealed at 1.1 differently on each side.
    const other = memoryProvider();
    for (const [k, v] of p.objects) other.objects.set(k, { data: v.data.slice(), etag: v.etag });
    const x = device("X", other, a.sync.keys());
    await x.sync.sync();
    await pairConfirmed(x, a, code, relayBetween(p, other));
    await x.sync.enroll("x", (await generateIdentity()).recipient);
    await expect(a.sync.enroll("y", (await generateIdentity()).recipient)).rejects.toBeInstanceOf(PairingPendingError); // its own code is still valid (N3)
    const a2 = device("A2", p, a.sync.keys());
    a2.store.state = JSON.parse(JSON.stringify(a.store.state));
    delete a2.store.state!.pairingUntil;
    delete a2.store.state!.pairingKept; // W8.5: nor the hold of the comparison A confirmed
    await a2.sync.enroll("y", (await generateIdentity()).recipient);
    await expect(x.sync.pair(await codeFrom(p, a2))).rejects.toBeInstanceOf(KeyringForkError);
  });

  it("RR-7: a provider that ignores If-Match / If-None-Match syncs, but re-key and enroll are refused", async () => {
    const base = memoryProvider();
    const loose: SyncProvider = { ...base, id: "loose", put: (n, d) => base.put(n, d) };
    const a = await newVault(base);
    a.files.set("a.md", "x");
    await a.sync.sync();
    await a.sync.rekey();
    const b = device("B", loose, a.sync.keys());
    await b.sync.sync();
    await pairConfirmed(b, a, await a.sync.pairingCode());
    b.files.set("b.md", "y");
    expect((await b.sync.sync()).uploaded).toBe(1);
    const names = new Set(base.objects.keys());
    await expect(b.sync.rekey()).rejects.toBeInstanceOf(CasUnsupportedError);
    await expect(b.sync.enroll("t", (await generateIdentity()).recipient)).rejects.toBeInstanceOf(CasUnsupportedError);
    expect([...base.objects.keys()].filter((n) => !names.has(n))).toEqual([]); // the probe's objects are gone
    expect(ringJson(base).epoch).toBe(1);
  });

  it("RR-10: a passphrase change keeps the KDF family unless asked", async () => {
    const p = memoryProvider();
    const a = await newVault(p); // PBKDF2 (the tests' cheap parameters)
    await a.sync.sync();
    await a.sync.rekey({ newPassphrase: "second passphrase 2026" });
    const kdf = JSON.parse(fromUtf8(p.objects.get(HEADER_NAME)!.data)).kdf;
    expect(kdf.alg).toBe("pbkdf2-sha256");
    expect(kdf.iterations).toBe(600_000);
  });

  it("RR-3: manifest labels are random per epoch: a name computed from epoch 0's names key in advance is never used", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    await a.sync.sync();
    const k0 = a.sync.keys();
    const guesses = await Promise.all([1, 2, 3].map((n) => manifestNameFor(k0, `manifest/${n}`)));
    for (const g of guesses) await p.put(g, randomBytes(300));
    await a.sync.rekey();
    await a.sync.rekey();
    const name = await manifestName(a.sync.keys());
    expect(guesses).not.toContain(name);
    const c = await joinVault("C", p);
    await c.sync.sync();
    expect(c.sync.keys().epoch).toBe(2);
  });
});
