/**
 * Third crypto review 12.11 (plan W6.4, N1 … N7): anchors bound to the
 * epoch's secret, keyring writes read back, a re-key replaced by a sibling
 * revoked again, a CAS probe the provider can't single out, two-way
 * pairing, unverified devices that don't upload, and tampered wraps told
 * apart from revocations.
 * Real engine, real WebCrypto, the simulated provider folder.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { CasUnsupportedError, memoryProvider, PreconditionFailedError, PROBE_RACE_ROUNDS, proveCas, type SyncProvider } from "../sync/e2ee/provider";
import { E2eeSync, PairingPendingError, unlockVault, unlockWithDevice, UnverifiedDeviceError } from "../sync/e2ee/engine";
import { ageDecrypt, ageEncrypt, generateIdentity } from "../sync/e2ee/age";
import { bs, fromB64u, fromUtf8, randomBytes, sha256Hex, toB64u, utf8 } from "../sync/e2ee/bytes";
import { PROTOCOL_VERSION } from "../sync/e2ee/header";
import { epochKeys, seal } from "../sync/e2ee/keys";
import { KEYRING_NAME, keyringAad, KeyringForkError, keysFromKeyring, TamperedWrapError } from "../sync/e2ee/keyring";
import { memoryFiles } from "../sync/e2ee/localFiles";
import { blobName, manifestName, sealManifest } from "../sync/e2ee/manifest";
import { PairingEpochError, PairingError, PAIRING_TTL_MS } from "../sync/e2ee/pairing";
import { memoryStateStore } from "../sync/e2ee/state";
import { device, joinVault, newVault, PASSPHRASE, TEST_POLICY } from "./helpers/e2ee";

type Provider = ReturnType<typeof memoryProvider>;
const ringJson = (p: Provider) => JSON.parse(fromUtf8(p.objects.get(KEYRING_NAME)!.data));
const snap = (p: Provider) => new Map([...p.objects].map(([k, v]) => [k, { data: v.data.slice(), etag: v.etag }]));

async function wrapsFor(p: Provider, id: string, identity: string): Promise<Uint8Array | null> {
  const ring = ringJson(p);
  if (!ring.devices[id]) return null;
  return ageDecrypt(fromB64u(ring.devices[id].wrap), [{ identity }]).catch(() => null);
}

function enrolled(provider: SyncProvider, name: string, identity: string, store = memoryStateStore(), files = memoryFiles()) {
  return unlockWithDevice(provider, name, identity, store.state).then(({ keys }) => ({ files, store, sync: new E2eeSync({ provider, keys, local: files, store, access: { device: name, identity } }) }));
}

/** The provider makes a whole keyring and manifest of its own for a device's public key (N1). */
async function forgeFor(p: Provider, vaultId: string, deviceId: string, recipient: string, anchor: { epoch: number; rev: number; digest: string }) {
  const S = randomBytes(32);
  const epoch = anchor.epoch + 1;
  const ek = await epochKeys(S, vaultId);
  const contents = { older: { "0": toB64u(randomBytes(32)) }, revoked: [], devices: { [deviceId]: recipient }, manifest: `manifest/${epoch}/${toB64u(randomBytes(16))}`, rev: 0, parent: anchor.digest, chain: [[anchor.epoch, anchor.rev, anchor.digest]] };
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
  await p.put(mname, (await sealManifest(keys, m as never, mname)).bytes);
  await p.put(KEYRING_NAME, utf8(JSON.stringify(file)));
}

describe("N1: an anchor bound to the epoch's secret", () => {
  it("a device that opens with its own key refuses a keyring the provider made for its public key, at the open and at the round", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    a.files.set("a.md", "the user's text");
    await a.sync.sync();
    const phone = await generateIdentity();
    await a.sync.rekey({ enroll: { phone: phone.recipient } });
    await a.sync.sync();
    const store = memoryStateStore();
    const files = memoryFiles();
    const d1 = await enrolled(p, "phone", phone.identity, store, files);
    await d1.sync.sync();
    expect(store.state!.ring!.check).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await forgeFor(p, a.sync.keys().vaultId, "phone", phone.recipient, store.state!.ring!);
    // With its saved state, the open itself refuses…
    await expect(unlockWithDevice(p, "phone", phone.identity, store.state)).rejects.toBeInstanceOf(KeyringForkError);
    // …and without it at the open, the first round does, before anything is read or written.
    const { keys } = await unlockWithDevice(p, "phone", phone.identity);
    const d2 = new E2eeSync({ provider: p, keys, local: files, store, access: { device: "phone", identity: phone.identity } });
    files.set("new.md", "after the restart");
    await expect(d2.sync()).rejects.toBeInstanceOf(KeyringForkError);
    expect(files.text("a.md")).toBe("the user's text");
  });

  it("the passphrase path checks the anchor too: keys of another lineage at the same epoch are refused at the open", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    await a.sync.sync();
    await a.sync.rekey();
    await a.sync.sync();
    const state = a.store.state!;
    const fork = memoryProvider();
    for (const [k, v] of snap(p)) fork.objects.set(k, v);
    const b = device("B", fork, a.sync.keys());
    b.store.state = JSON.parse(JSON.stringify(state));
    delete b.store.state!.pairingUntil;
    await b.sync.rekey(); // epoch 2 on the copy
    await a.sync.rekey(); // epoch 2 here: same number, another secret
    const { keys: bKeys } = await unlockVault(fork, PASSPHRASE, TEST_POLICY);
    expect(bKeys.epoch).toBe(2);
    await expect(unlockVault(fork, PASSPHRASE, TEST_POLICY, { state: a.store.state })).rejects.toBeInstanceOf(KeyringForkError);
    await expect(unlockVault(p, PASSPHRASE, TEST_POLICY, { state: a.store.state })).resolves.toBeTruthy();
  });
});

describe("N2: every keyring write is read back", () => {
  /** A provider that passes the probe, then lets `other` overwrite the keyring right after each of A's keyring writes. */
  function lying(base: Provider, other: () => Promise<void>) {
    let armed = true;
    const p: SyncProvider = {
      ...base,
      id: "lying",
      async put(n, d, c) {
        if (n !== KEYRING_NAME || !armed) return base.put(n, d, c);
        armed = false;
        const r = await base.put(n, d, c);
        await other();
        return r;
      },
    };
    return p;
  }

  it("a re-key replaced by another device's right after it was written reports it, and the next round revokes again on top", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    a.files.set("a.md", "hello");
    await a.sync.sync();
    const phone = await generateIdentity();
    await a.sync.rekey({ enroll: { phone: phone.recipient } });
    await a.sync.sync();
    // B re-keyed from the same keyring, unaware of the revocation; the provider applies it after A's write, without its condition.
    const b = device("B", p, a.sync.keys());
    b.store.state = JSON.parse(JSON.stringify(a.store.state));
    const before = snap(p);
    const copy = memoryProvider();
    for (const [k, v] of before) copy.objects.set(k, v);
    const bOnCopy = device("B", copy, a.sync.keys());
    bOnCopy.store.state = JSON.parse(JSON.stringify(a.store.state));
    await bOnCopy.sync.rekey({ enroll: { laptop: (await generateIdentity()).recipient } });
    const bRing = copy.objects.get(KEYRING_NAME)!;
    const bManifest = await manifestName(bOnCopy.sync.keys());
    const pa = lying(p, async () => {
      p.objects.set(KEYRING_NAME, { data: bRing.data.slice(), etag: "b" });
      p.objects.set(bManifest, { ...copy.objects.get(bManifest)! });
    });
    await proveCas(pa);
    const a2 = device("A2", pa, a.sync.keys());
    a2.store.state = JSON.parse(JSON.stringify(a.store.state));
    const r = await a2.sync.rekey({ revoke: ["phone"] });
    expect(r.confirmed).toBe(false);
    expect(r.warning).toMatch(/revocation of "phone" may not have taken effect/);
    expect(await wrapsFor(p, "phone", phone.identity)).not.toBeNull(); // B's keyring stands for now
    const err = await a2.sync.sync().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(KeyringForkError);
    expect((err as KeyringForkError).revocationReapplied).toEqual(["phone"]);
    expect(ringJson(p).epoch).toBe(3);
    expect(await wrapsFor(p, "phone", phone.identity)).toBeNull();
    await expect(a2.sync.sync()).resolves.toBeTruthy();
    void b;
  });

  it("an enrollment replaced right after it was written fails instead of claiming success", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    await a.sync.sync();
    await a.sync.rekey();
    const old = snap(p).get(KEYRING_NAME)!;
    const pa = lying(p, async () => void p.objects.set(KEYRING_NAME, { data: old.data.slice(), etag: "old" }));
    await proveCas(pa);
    const a2 = device("A2", pa, a.sync.keys());
    a2.store.state = JSON.parse(JSON.stringify(a.store.state));
    await expect(a2.sync.enroll("x", (await generateIdentity()).recipient)).rejects.toMatchObject({ name: "KeyringCommitLostError" });
  });

  it("the CAS probe writes random blob-like names and sizes, races two creates, and refuses a provider without atomic create-only", async () => {
    const base = memoryProvider();
    const seen: Array<{ name: string; size: number }> = [];
    const p: SyncProvider = { ...base, id: "watched", put: (n, d, c) => (seen.push({ name: n, size: d.length }), base.put(n, d, c)) };
    await proveCas(p);
    const names = new Set(seen.map((s) => s.name));
    expect(names.size).toBe(1 + PROBE_RACE_ROUNDS); // the probe object and one per race round (W6.27)
    for (const s of seen) {
      expect(s.name).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(s.size).toBeGreaterThanOrEqual(285);
    }
    expect(base.objects.size).toBe(0);
    // Two probes never share a name.
    const again: SyncProvider = { ...base, id: "again", put: (n, d, c) => (names.has(n) ? Promise.reject(new Error("reused")) : base.put(n, d, c)) };
    await proveCas(again);
    // Drive-like: create-only isn't atomic → sync-only.
    await expect(proveCas({ ...base, id: "gdrive", atomicCreate: false })).rejects.toBeInstanceOf(CasUnsupportedError);
    // Racing creates that both "win" are caught where the race shows.
    const racy: SyncProvider = {
      ...base,
      id: "racy",
      async put(n, d, c) {
        if (c && "ifNoneMatch" in c) {
          const had = base.objects.has(n);
          await new Promise((r) => setTimeout(r, 1));
          if (had) throw new PreconditionFailedError(n);
          return base.put(n, d);
        }
        return base.put(n, d, c);
      },
    };
    await expect(proveCas(racy)).rejects.toBeInstanceOf(CasUnsupportedError);
  });
});

describe("N3: pairing", () => {
  it("two-way: the answering device checks the request against the vault now — a new device shown the epoch before a revocation is refused there", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    a.files.set("a.md", "x");
    await a.sync.sync();
    const phone = await generateIdentity();
    await a.sync.rekey({ enroll: { phone: phone.recipient } });
    await a.sync.sync();
    const before = snap(p);
    // Another verified device revokes the phone; A hasn't synced since.
    const other = device("O", p, a.sync.keys());
    other.store.state = JSON.parse(JSON.stringify(a.store.state));
    await other.sync.rekey({ revoke: ["phone"] });
    const now = snap(p);
    // The provider shows the laptop the epoch-1 world.
    for (const [k, v] of before) p.objects.set(k, v);
    const laptop = await joinVault("laptop", p);
    await laptop.sync.sync();
    const request = await laptop.sync.pairingRequest();
    expect(request).toMatch(/^lumen-pair-request:2:1:/);
    for (const [k, v] of now) p.objects.set(k, v);
    const err = await a.sync.answerPairing(request).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(PairingEpochError);
    expect((err as PairingEpochError).kind).toBe("older");
    expect((await laptop.sync.freshness()).verified).toBe(false);
  });

  it("two-way: an answer pairs only the device whose request it answers", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    await a.sync.sync();
    await a.sync.rekey();
    await a.sync.sync();
    const b = await joinVault("B", p);
    const c = await joinVault("C", p);
    await b.sync.sync();
    await c.sync.sync();
    const forB = await a.sync.answerPairing(await b.sync.pairingRequest());
    await c.sync.pairingRequest();
    await expect(c.sync.pair(forB)).rejects.toBeInstanceOf(PairingError);
    await b.sync.pair(forB);
    expect((await b.sync.freshness()).source).toBe("paired");
    await expect(b.sync.pair(forB)).rejects.toBeInstanceOf(PairingError); // one use
  });

  it("one-way: a code lasts 2 minutes, and its issuer makes no key change meanwhile", async () => {
    let clock = 1_800_000_000_000;
    const p = memoryProvider();
    const a0 = await newVault(p);
    await a0.sync.sync();
    const a = device("A", p, a0.sync.keys(), undefined, () => clock);
    a.store.state = a0.store.state;
    await a.sync.rekey();
    const code = await a.sync.pairingCode();
    await expect(a.sync.rekey()).rejects.toBeInstanceOf(PairingPendingError);
    await expect(a.sync.enroll("x", (await generateIdentity()).recipient)).rejects.toBeInstanceOf(PairingPendingError);
    clock += PAIRING_TTL_MS + 1;
    const late = await joinVault("late", p, undefined, () => clock);
    await late.sync.sync();
    await expect(late.sync.pair(code)).rejects.toBeInstanceOf(PairingError);
    expect((await a.sync.rekey()).epoch).toBe(2);
  });
});

describe("N5 and N6", () => {
  it("N5: a wrap the provider swapped is reported as tampered, not as a revocation, and the next rewrite makes it again", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    await a.sync.sync();
    const phone = await generateIdentity();
    await a.sync.rekey({ enroll: { phone: phone.recipient } });
    const ring = ringJson(p);
    ring.devices.phone.wrap = toB64u(await ageEncrypt(randomBytes(32), [{ x25519: phone.recipient }]));
    p.objects.set(KEYRING_NAME, { data: utf8(JSON.stringify(ring)), etag: "swapped" });
    await expect(unlockWithDevice(p, "phone", phone.identity)).rejects.toBeInstanceOf(TamperedWrapError);
    await a.sync.sync();
    await a.sync.enroll("laptop", (await generateIdentity()).recipient);
    await expect(unlockWithDevice(p, "phone", phone.identity)).resolves.toBeTruthy();
  });

  it("N6: an unverified device keeps its changes until it is confirmed; then they go up", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    await a.sync.sync();
    const b = await joinVault("B", p);
    await b.sync.sync();
    b.files.set("b.md", "from B");
    const r = await b.sync.sync();
    expect(r).toMatchObject({ uploaded: 0, waiting: ["b.md"] });
    await expect(b.sync.enroll("x", (await generateIdentity()).recipient)).rejects.toBeInstanceOf(UnverifiedDeviceError);
    await b.sync.confirmFreshness();
    expect((await b.sync.sync()).uploaded).toBe(1);
    await a.sync.sync();
    expect(a.files.text("b.md")).toBe("from B");
  });
});
