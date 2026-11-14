/**
 * Review 12.11 (findings 1 and 2): the keyring's device list is
 * authenticated, revoked devices stay out, and a re-key cut off at any
 * write leaves a vault every device can open and sync.
 * Real engine, real WebCrypto, the simulated provider folder.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { memoryProvider } from "../sync/e2ee/provider";
import { E2eeSync, unlockVault, unlockWithDevice } from "../sync/e2ee/engine";
import { ageDecrypt, ageEncrypt, generateIdentity } from "../sync/e2ee/age";
import { bs, fromB64u, fromUtf8, randomBytes, toB64u, utf8 } from "../sync/e2ee/bytes";
import { HEADER_NAME, WrongPassphraseError } from "../sync/e2ee/header";
import { enrollDevice, KEYRING_NAME, KEYRING_PREV_NAME, keyringAad, keyringContents, readKeyring, RevokedDeviceEnrollError, RevokedError } from "../sync/e2ee/keyring";
import { memoryFiles } from "../sync/e2ee/localFiles";
import { FREEZE_TTL_MS, manifestName, openManifest, sealManifest } from "../sync/e2ee/manifest";
import { memoryStateStore } from "../sync/e2ee/state";
import { device, joinVault, newVault, PASSPHRASE, TEST_ITERATIONS, TEST_POLICY } from "./helpers/e2ee";

type Provider = ReturnType<typeof memoryProvider>;

/** The provider edits the keyring's plaintext JSON (it can't touch the sealed part). */
function tamper(p: Provider, edit: (ring: { devices: Record<string, { recipient: string; wrap: string }> }) => void) {
  const obj = p.objects.get(KEYRING_NAME)!;
  const ring = JSON.parse(fromUtf8(obj.data));
  edit(ring);
  p.objects.set(KEYRING_NAME, { data: utf8(JSON.stringify(ring)), etag: obj.etag });
}

async function wrapsFor(p: Provider, id: string, identity: string): Promise<Uint8Array | null> {
  const ring = JSON.parse(fromUtf8(p.objects.get(KEYRING_NAME)!.data));
  if (!ring.devices[id]) return null;
  return ageDecrypt(fromB64u(ring.devices[id].wrap), [{ identity }]).catch(() => null);
}

async function enrolled(provider: Provider, name: string, identity: string) {
  const { keys } = await unlockWithDevice(provider, name, identity);
  const files = memoryFiles();
  return { files, sync: new E2eeSync({ provider, keys, local: files, store: memoryStateStore(), access: { device: name, identity } }) };
}

/** A provider whose next matching put fails once (network down), when armed. */
function flaky() {
  let failOn: ((name: string) => boolean) | null = null;
  const p = memoryProvider({
    fault(op, name, phase) {
      if (failOn && op === "put" && phase === "before" && failOn(name)) {
        failOn = null;
        throw new Error("network down");
      }
    },
  });
  return { p, failNext: (f: (name: string) => boolean) => (failOn = f) };
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
    const oldWrap = JSON.parse(fromUtf8(p.objects.get(KEYRING_NAME)!.data)).devices.phone;
    const lost = await enrolled(p, "phone", phone.identity);
    await lost.sync.sync();

    await a.sync.rekey({ revoke: ["phone"] });
    // The provider puts the phone back into the plaintext map, twice over: its old wrap…
    tamper(p, (r) => (r.devices.phone = oldWrap));
    await expect(unlockWithDevice(p, "phone", phone.identity)).rejects.toBeInstanceOf(RevokedError);
    await expect(lost.sync.sync()).rejects.toBeInstanceOf(RevokedError);
    // …and its recipient, so that the next re-key would wrap for it.
    tamper(p, (r) => (r.devices.phone = { recipient: phone.recipient, wrap: oldWrap.wrap }));
    await a.sync.sync();
    const r = await a.sync.rekey();
    expect(r.devices).toEqual(["laptop"]);
    expect(await wrapsFor(p, "phone", phone.identity)).toBeNull();
    // A revoked id or key can't be enrolled again by mistake, at a re-key or without one.
    await expect(a.sync.rekey({ enroll: { phone: (await generateIdentity()).recipient } })).rejects.toBeInstanceOf(RevokedDeviceEnrollError);
    await expect(a.sync.rekey({ enroll: { "phone-2": phone.recipient } })).rejects.toBeInstanceOf(RevokedDeviceEnrollError);
    await expect(enrollDevice(p, a.sync.keys(), "phone-3", phone.recipient)).rejects.toBeInstanceOf(RevokedDeviceEnrollError);
    // The laptop is untouched by all of it.
    const kept = await enrolled(p, "laptop", laptop.identity);
    await kept.sync.sync();
    expect(kept.files.text("a.md")).toBe("before");
  });

  it("a keyring from before the sealed list is sealed at the first unlock: junk and revoked entries are dropped, later injections ignored", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    await a.sync.sync();
    const phone = await generateIdentity();
    const tablet = await generateIdentity();
    await a.sync.rekey({ enroll: { phone: phone.recipient, tablet: tablet.recipient } });
    await a.sync.rekey({ revoke: ["tablet"] });
    // Rewrite the keyring as an older build wrote it: no device list in the sealed part.
    const keys = a.sync.keys();
    const ring = JSON.parse(fromUtf8(p.objects.get(KEYRING_NAME)!.data));
    const contents = await keyringContents(ring, keys);
    delete contents.devices;
    const n = randomBytes(12);
    const c = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(n), additionalData: bs(keyringAad(ring.vaultId, ring.epoch, "sealed")) }, keys.keyring, bs(utf8(JSON.stringify(contents)))));
    ring.sealed = { n: toB64u(n), c: toB64u(c) };
    // What a provider may have slipped in meanwhile: junk, and the revoked tablet.
    ring.devices.junk = { recipient: "age1notarecipient", wrap: "AAAA" };
    ring.devices.tablet = { recipient: tablet.recipient, wrap: ring.devices.phone.wrap };
    p.objects.set(KEYRING_NAME, { data: utf8(JSON.stringify(ring)), etag: "legacy" });

    const b = await joinVault("B", p);
    await b.sync.sync(); // the first unlock with the current keys seals the list
    const sealed = await keyringContents((await readKeyring(p))!.file, b.sync.keys());
    expect(Object.keys(sealed.devices ?? {})).toEqual(["phone"]);
    const evil = await generateIdentity();
    const evilWrap = toB64u(await ageEncrypt(randomBytes(32), [{ x25519: evil.recipient }]));
    tamper(p, (r) => (r.devices.evil = { recipient: evil.recipient, wrap: evilWrap }));
    await b.sync.sync();
    const r = await b.sync.rekey();
    expect(r.devices).toEqual(["phone"]);
    expect(await wrapsFor(p, "evil", evil.identity)).toBeNull();
    expect(await wrapsFor(p, "tablet", tablet.identity)).toBeNull();
    expect(await wrapsFor(p, "phone", phone.identity)).not.toBeNull();
  });
});

describe("finding 2: a re-key cut off at any write", () => {
  it("after the keyring: another device finishes it, and every device keeps syncing", async () => {
    const { p, failNext } = flaky();
    const a = await newVault(p);
    a.files.set("a.md", "hello");
    await a.sync.sync();
    const b = await joinVault("B", p);
    await b.sync.sync();
    const newName = async () => manifestName((await unlockVault(p, PASSPHRASE, TEST_POLICY)).keys);
    failNext((n) => n !== KEYRING_NAME && n !== HEADER_NAME && p.objects.has(KEYRING_NAME) && JSON.parse(fromUtf8(p.objects.get(KEYRING_NAME)!.data)).epoch === 1);
    await expect(a.sync.rekey()).rejects.toThrow("network down");
    expect(p.objects.has(await newName())).toBe(false);
    // B: next round picks up epoch 1 and re-seals the frozen manifest under it.
    b.files.set("b.md", "from B");
    await b.sync.sync();
    expect(b.sync.keys().epoch).toBe(1);
    expect(p.objects.has(await newName())).toBe(true);
    // A carries on; a fresh device too.
    await a.sync.sync();
    expect(a.files.text("b.md")).toBe("from B");
    const c = await joinVault("C", p);
    await c.sync.sync();
    expect(c.files.text("a.md")).toBe("hello");
    expect(c.files.text("b.md")).toBe("from B");
  });

  it("only the exact frozen manifest is carried: an epoch-0 write after the freeze is not", async () => {
    const { p, failNext } = flaky();
    const a = await newVault(p);
    a.files.set("a.md", "hello");
    await a.sync.sync();
    const keys0 = a.sync.keys();
    const old = await manifestName(keys0);
    failNext((n) => n !== KEYRING_NAME && n !== old);
    await expect(a.sync.rekey()).rejects.toThrow("network down");
    // A holder of the epoch-0 keys (a device revoked by this re-key, say) writes over the frozen manifest.
    const { manifest } = await openManifest(keys0, p.objects.get(old)!.data, old);
    expect(manifest.frozen?.epoch).toBe(1);
    const planted = { ...manifest, protocol: 1, counter: manifest.counter + 1, files: { ...manifest.files, "evil.md": { ...manifest.files["a.md"], ver: 1 } } };
    delete planted.frozen;
    p.objects.set(old, { data: (await sealManifest(keys0, planted, old)).bytes, etag: "planted" });
    const b = await joinVault("B", p);
    await expect(b.sync.sync()).rejects.toThrow(/manifest is missing/);
    expect(b.files.files.has("evil.md")).toBe(false);
  });

  it("before the keyring: the frozen manifest still pulls; pushes wait; running the re-key again finishes it", async () => {
    const { p, failNext } = flaky();
    const a = await newVault(p);
    a.files.set("a.md", "one");
    await a.sync.sync();
    const b = await joinVault("B", p);
    await b.sync.sync();
    failNext((n) => n === KEYRING_NAME);
    await expect(a.sync.rekey()).rejects.toThrow("network down");
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
  });

  it("an abandoned freeze: after FREEZE_TTL_MS another device writes over it", async () => {
    let clock = Date.now(); // A freezes on the real clock
    const now = () => clock;
    const { p, failNext } = flaky();
    const a = await newVault(p);
    await a.sync.sync();
    const b = await joinVault("B", p, undefined, now);
    await b.sync.sync();
    failNext((n) => n === KEYRING_NAME);
    await expect(a.sync.rekey()).rejects.toThrow("network down");
    b.files.set("b.md", "from B");
    expect((await b.sync.sync()).rekeyPending).toBe(true);
    clock = Date.now() + FREEZE_TTL_MS + 1;
    const r = await b.sync.sync();
    expect(r.rekeyPending).toBeFalsy();
    expect(r.uploaded).toBe(1);
    await a.sync.sync();
    expect(a.files.text("b.md")).toBe("from B");
  });

  it("a re-key that stalls past half the freeze TTL before committing gives up instead", async () => {
    let clock = 1_800_000_000_000;
    let armed = false;
    const p = memoryProvider({
      fault(op, _name, phase) {
        if (armed && op === "get" && phase === "before") clock += FREEZE_TTL_MS;
      },
    });
    const a = await newVault(p);
    await a.sync.sync();
    const d = device("A2", p, (await unlockVault(p, PASSPHRASE, TEST_POLICY)).keys, undefined, () => clock);
    await d.sync.sync();
    const old = await manifestName(d.sync.keys());
    const put = p.put.bind(p);
    p.put = async (n, data, c) => {
      const out = await put(n, data, c);
      if (n === old) armed = true;
      return out;
    };
    await expect(d.sync.rekey()).rejects.toThrow(/precondition/);
    expect(p.objects.has(KEYRING_NAME)).toBe(false);
  });

  it("a passphrase change cut off before the header: the old passphrase opens the epoch before, the new one opens and finishes it", async () => {
    for (const startEpoch of [0, 1]) {
      const { p, failNext } = flaky();
      const a = await newVault(p);
      a.files.set("x.md", "x");
      await a.sync.sync();
      for (let i = 0; i < startEpoch; i++) await a.sync.rekey();
      const NEW = "a brand new passphrase 2026";
      failNext((n) => n === HEADER_NAME);
      await expect(a.sync.rekey({ newPassphrase: NEW, pbkdf2Iterations: TEST_ITERATIONS })).rejects.toThrow("network down");
      expect(p.objects.has(KEYRING_PREV_NAME)).toBe(startEpoch > 0);
      // The old passphrase: the epoch before the change, never the new one.
      const old = await unlockVault(p, PASSPHRASE, TEST_POLICY);
      expect(old.keys.epoch).toBe(startEpoch);
      // The new one: the new epoch; it writes the header the re-key could not.
      const fresh = await unlockVault(p, NEW, TEST_POLICY);
      expect(fresh.keys.epoch).toBe(startEpoch + 1);
      expect(p.objects.has(KEYRING_PREV_NAME)).toBe(false);
      await expect(unlockVault(p, PASSPHRASE, TEST_POLICY)).rejects.toBeInstanceOf(WrongPassphraseError);
      const d = device("D", p, fresh.keys);
      await d.sync.sync();
      expect(d.files.text("x.md")).toBe("x");
    }
  });
});
