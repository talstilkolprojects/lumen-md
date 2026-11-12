/**
 * Plan W4.17 — the keyring's rules as the module header states them, for
 * mutants of src/sync/e2ee/keyring.ts the engine suites missed:
 *   - the sealed part is checked field by field (contents, sealed device
 *     list, manifest label, revision, parent, chain, carry, header, aborted);
 *     a keyring whose sealed part breaks a rule doesn't open;
 *   - the digest covers what a device can check, and not the plaintext wraps;
 *   - a re-key is prepared only from the keyring the keys came from, with a
 *     fresh 32-byte secret, and never for a revoked id or key;
 *   - a refresh follows every rewrite and accepts only a keyring that
 *     descends from the one this device verified ("unproven" when it is too
 *     far behind for the chain to say).
 * Each forged keyring is sealed with the epoch's real keyring key, so only
 * the rule under test is broken. Real WebCrypto, the simulated provider.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { createVault } from "../sync/e2ee/engine";
import { generateIdentity } from "../sync/e2ee/age";
import { bs, randomBytes, toB64u, utf8 } from "../sync/e2ee/bytes";
import { DecryptError, type VaultKeys } from "../sync/e2ee/keys";
import { memoryProvider, PreconditionFailedError, type SyncProvider } from "../sync/e2ee/provider";
import {
  anchorOf,
  CHAIN_LENGTH,
  decodeKeyring,
  enrollDevice,
  KEYRING_NAME,
  keyringAad,
  keyringContents,
  keyringDigest,
  KeyringForkError,
  KeyringRollbackError,
  keysFromKeyring,
  newManifestLabel,
  prepareEpoch,
  PreReleaseKeyringError,
  readKeyring,
  refreshKeys,
  RevokedDeviceEnrollError,
  unwrapSecret,
  type KeyringContents,
  type KeyringFile,
} from "../sync/e2ee/keyring";
import { PASSPHRASE, TEST_ITERATIONS } from "./helpers/e2ee";

async function vault() {
  const provider = memoryProvider();
  const { keys } = await createVault(provider, PASSPHRASE, { pbkdf2Iterations: TEST_ITERATIONS });
  return { provider, keys };
}

/** Prepare the next epoch from the stored keyring and commit it, as E2eeSync.rekey does. */
async function rekey(provider: SyncProvider, keys: VaultKeys, opts: Parameters<typeof prepareEpoch>[2] = {}): Promise<VaultKeys> {
  const current = await readKeyring(provider);
  const p = await prepareEpoch(current, keys, opts);
  await provider.put(KEYRING_NAME, p.bytes, current ? { ifMatch: current.etag } : { ifNoneMatch: "*" });
  return p.keys;
}

const hex = (ch: string) => ch.repeat(64);

/** `file` with its sealed part replaced by `contents`, sealed with the epoch's real key (for `epoch`, `protocol`). */
async function reseal(keys: VaultKeys, file: KeyringFile, contents: unknown, epoch = file.epoch, protocol = file.protocol): Promise<KeyringFile> {
  const ad = protocol === 2 ? keyringAad(file.vaultId, epoch, "sealed") : utf8(`lumen-e2ee-keyring/${protocol}/${file.vaultId}/${epoch}/sealed`);
  const n = randomBytes(12);
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(n), additionalData: bs(ad) }, keys.keyring, bs(utf8(JSON.stringify(contents)))));
  return { ...file, epoch, protocol, sealed: { n: toB64u(n), c: toB64u(c) } };
}

/** A vault at epoch 1 and a way to open its keyring with the sealed part changed. */
async function epochOne() {
  const { provider, keys: k0 } = await vault();
  const keys = await rekey(provider, k0);
  const { file } = (await readKeyring(provider))!;
  const contents = await keyringContents(file, keys);
  /** Open a copy of the keyring at `epoch` whose sealed part is `edit(contents)`. */
  const open = async (edit: (c: KeyringContents) => unknown, epoch = 1, opts: { protocol?: number; allowPreRelease?: boolean } = {}) =>
    keysFromKeyring(await reseal(keys, file, edit(structuredClone(contents)), epoch, opts.protocol), keys.secret, keys, { allowPreRelease: opts.allowPreRelease });
  return { provider, k0, keys, file, contents, open };
}

describe("the sealed part is checked before a keyring opens", () => {
  it("opens the keyring as written, and refuses contents that aren't an object with `older` and `revoked`", async () => {
    const { open } = await epochOne();
    expect((await open((c) => c)).ring).toMatchObject({ rev: 0, aborted: [] });
    for (const edit of [() => null, () => 5, (c: KeyringContents) => ({ ...c, older: undefined }), (c: KeyringContents) => ({ ...c, older: "x" }), (c: KeyringContents) => ({ ...c, revoked: {} })]) {
      await expect(open(edit)).rejects.toThrow("Bad keyring contents");
    }
  });

  it("refuses a sealed part without the sealed device list as pre-release", async () => {
    const { open } = await epochOne();
    for (const devices of [undefined, "x", []]) await expect(open((c) => ({ ...c, devices }))).rejects.toBeInstanceOf(PreReleaseKeyringError);
  });

  it("needs this epoch's own random manifest label", async () => {
    const { open } = await epochOne();
    for (const manifest of ["manifest", "manifest/1", newManifestLabel(2), "notes/1/aaaaaaaaaaaaaaaaaaaaaa", 7]) {
      await expect(open((c) => ({ ...c, manifest })), String(manifest)).rejects.toThrow("Bad keyring manifest label");
    }
    const label = newManifestLabel(1);
    expect((await open((c) => ({ ...c, manifest: label }))).ring!.manifest).toBe(label);
  });

  it("needs a whole, non-negative revision and a hex parent", async () => {
    const { open } = await epochOne();
    for (const rev of [-1, 0.5, "0"]) await expect(open((c) => ({ ...c, rev }))).rejects.toThrow("Bad keyring revision");
    for (const parent of ["abc", hex("A"), 5]) await expect(open((c) => ({ ...c, parent }))).rejects.toThrow("Bad keyring parent");
  });

  it("accepts a chain that only moves forward, ending at the parent, and refuses every other", async () => {
    const { open } = await epochOne();
    const at9 = (chain: unknown, extra: Partial<KeyringContents> = {}) =>
      open((c) => ({ ...c, manifest: newManifestLabel(9), chain, parent: parentOf(chain), ...extra }), 9);
    /** The chain's last digest (any hex when that entry is itself malformed), or null for no chain. */
    function parentOf(chain: unknown): string | null {
      if (!Array.isArray(chain) || !chain.length) return null;
      const d = (chain[chain.length - 1] as unknown[])[2];
      return typeof d === "string" && /^[0-9a-f]{64}$/.test(d) ? d : hex("f");
    }
    // A new epoch starts again at revision 0; within an epoch the revision only grows.
    expect((await at9([[1, 0, hex("1")], [1, 1, hex("2")], [2, 0, hex("3")], [8, 4, hex("4")]])).ring!.rev).toBe(0);
    expect((await at9([[9, 0, hex("1")]], { rev: 1 })).ring!.rev).toBe(1);
    const full = Array.from({ length: CHAIN_LENGTH }, (_, i) => [1, i, hex("a")]);
    expect((await at9(full)).epoch).toBe(9);
    const bad: Array<[string, unknown, Partial<KeyringContents>?]> = [
      ["not a list", "x"],
      ["longer than CHAIN_LENGTH", [...full, [2, 0, hex("b")]]],
      ["an entry of two", [[1, 0]]],
      ["an entry of four", [[1, 0, hex("1"), 0]]],
      ["a text epoch", [["1", 0, hex("1")]]],
      ["a fractional revision", [[1, 0.5, hex("1")]]],
      ["a digest that isn't hex", [[1, 0, "xyz"]]],
      ["the same entry twice", [[1, 0, hex("1")], [1, 0, hex("2")]]],
      ["a revision going back", [[1, 1, hex("1")], [1, 0, hex("2")]]],
      ["an epoch going back", [[2, 0, hex("1")], [1, 5, hex("2")]]],
      ["an entry after this keyring's epoch", [[10, 0, hex("1")]]],
      ["an entry at this revision", [[9, 0, hex("1")]]],
      ["a revision 2 after revision 0", [[9, 0, hex("1")]], { rev: 2 }],
      ["a revision 1 after another epoch", [[8, 0, hex("1")]], { rev: 1 }],
      ["a revision 1 with no chain", [], { rev: 1 }],
      ["a parent that isn't the chain's last", [[1, 0, hex("1")]], { parent: hex("2") }],
      ["a parent with no chain", [], { parent: hex("1") }],
      ["a chain with no parent", [[1, 0, hex("1")]], { parent: null }],
    ];
    for (const [name, chain, extra] of bad) await expect(at9(chain, extra), name).rejects.toThrow("Bad keyring chain");
  });

  it("checks the carried manifest, the pending header and the aborted list, and reports them", async () => {
    const { open } = await epochOne();
    const carry = { label: newManifestLabel(1), epoch: 0, digest: hex("c") };
    const ring = (await open((c) => ({ ...c, carry, header: hex("d"), aborted: [hex("e")] }))).ring!;
    expect(ring).toMatchObject({ carry, header: hex("d"), aborted: [hex("e")] });
    for (const bad of [null, { ...carry, label: "x" }, { ...carry, epoch: 0.5 }, { ...carry, digest: 5 }]) {
      await expect(open((c) => ({ ...c, carry: bad }))).rejects.toThrow("Bad keyring carry");
    }
    for (const header of ["abc", 5]) await expect(open((c) => ({ ...c, header }))).rejects.toThrow("Bad keyring header");
    for (const aborted of ["x", [5], {}]) await expect(open((c) => ({ ...c, aborted }))).rejects.toThrow("Bad keyring aborted list");
  });

  it("opens a pre-release keyring only to reset it, and still checks `older` and `revoked`", async () => {
    const { open, contents } = await epochOne();
    const old = { older: contents.older, revoked: [] };
    await expect(open(() => old, 1, { protocol: 1 })).rejects.toBeInstanceOf(PreReleaseKeyringError);
    const reset = await open(() => old, 1, { protocol: 1, allowPreRelease: true });
    expect(reset.ring).toMatchObject({ preRelease: true, rev: 0, manifest: "manifest" });
    const label = newManifestLabel(1);
    expect((await open(() => ({ ...old, manifest: label }), 1, { protocol: 1, allowPreRelease: true })).ring!.manifest).toBe(label);
    for (const bad of [null, { revoked: [] }, { older: "x", revoked: [] }, { older: contents.older }, { older: contents.older, revoked: {} }]) {
      await expect(open(() => bad, 1, { protocol: 1, allowPreRelease: true })).rejects.toThrow(DecryptError);
    }
  });
});

describe("the digest and the anchor", () => {
  it("covers a pending header and the replaced keyring, even empty, and not the plaintext wraps", async () => {
    const { file } = await epochOne();
    const d = await keyringDigest(file);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(await keyringDigest({ ...file, header: "" })).not.toBe(d);
    expect(await keyringDigest({ ...file, header: "", prev: "" })).not.toBe(await keyringDigest({ ...file, header: "" }));
    expect(await keyringDigest({ ...file, devices: { x: { recipient: "age1x", wrap: "w" } } })).toBe(d);
    expect(decodeKeyring(utf8(JSON.stringify({ ...file, header: "" }))).header).toBe("");
  });

  it("anchors a vault without a keyring at 0.0, and a keyring at its epoch, revision and digest", async () => {
    const { k0, keys, file } = await epochOne();
    expect(anchorOf(k0)).toEqual({ epoch: 0, rev: 0, digest: "" });
    expect(anchorOf(keys)).toEqual({ epoch: 1, rev: 0, digest: await keyringDigest(file) });
  });
});

describe("preparing a re-key", () => {
  it("makes a fresh 32-byte secret, wrapped for the passphrase", async () => {
    const { provider, keys } = await epochOne();
    const next = await rekey(provider, keys);
    expect(next.epoch).toBe(2);
    expect(next.secret.length).toBe(32);
    const { file } = (await readKeyring(provider))!;
    expect(await unwrapSecret(file, { wrap: next.wrap! })).toEqual(next.secret);
  });

  it("only from the keyring the keys came from", async () => {
    const { provider, keys } = await epochOne();
    const id = await generateIdentity();
    await enrollDevice(provider, keys, "B", id.recipient); // rev 1, written by "another device"
    await expect(prepareEpoch(await readKeyring(provider), keys)).rejects.toBeInstanceOf(PreconditionFailedError);
    await expect(prepareEpoch(null, keys)).rejects.toBeInstanceOf(KeyringRollbackError);
  });

  it("never enrolls a revoked id or a revoked key again, and still enrolls a new device", async () => {
    const { provider, keys } = await epochOne();
    const b = await generateIdentity();
    const withB = await enrollDevice(provider, keys, "B", b.recipient);
    const after = await rekey(provider, withB, { revoke: ["B"] });
    const fresh = await generateIdentity();
    await expect(enrollDevice(provider, after, "B", fresh.recipient)).rejects.toBeInstanceOf(RevokedDeviceEnrollError);
    await expect(enrollDevice(provider, after, "D", b.recipient)).rejects.toBeInstanceOf(RevokedDeviceEnrollError);
    await expect(prepareEpoch(await readKeyring(provider), after, { enroll: { B: fresh.recipient } })).rejects.toBeInstanceOf(RevokedDeviceEnrollError);
    const withC = await enrollDevice(provider, after, "C", fresh.recipient);
    expect(Object.keys((await keyringContents((await readKeyring(provider))!.file, withC)).devices)).toEqual(["C"]);
  });
});

describe("refreshing the keys", () => {
  it("follows a rewrite at the same epoch", async () => {
    const { provider, keys } = await epochOne();
    const id = await generateIdentity();
    const written = await enrollDevice(provider, keys, "B", id.recipient);
    const r = await refreshKeys(provider, keys, { wrap: keys.wrap! });
    expect(r.ring).toMatchObject({ rev: 1, digest: written.ring!.digest });
    expect(await refreshKeys(provider, written, { wrap: keys.wrap! })).toBe(written);
  });

  it("accepts the next epoch from a device that saw a later revision of this one", async () => {
    const { provider, keys } = await epochOne();
    const b = await generateIdentity();
    const rev1 = await enrollDevice(provider, keys, "B", b.recipient);
    const anchor = anchorOf(rev1);
    expect(anchor.rev).toBe(1);
    await rekey(provider, rev1);
    const r = await refreshKeys(provider, keys, { wrap: keys.wrap! }, anchor);
    expect(r.epoch).toBe(2);
    expect(r.ring!.unproven).toBeUndefined();
  });

  it("refuses a keyring whose complete chain doesn't list what this device saw, or lists something else there", async () => {
    const { provider, keys } = await epochOne();
    const b = await generateIdentity();
    const rev1 = await enrollDevice(provider, keys, "B", b.recipient);
    await enrollDevice(provider, rev1, "B", b.recipient);
    await expect(refreshKeys(provider, keys, { wrap: keys.wrap! }, { epoch: 1, rev: 1, digest: hex("0") })).rejects.toThrow(/its chain has another 1\.1/);
    // Revision 1.5 never existed: a complete chain (three entries, under the cap) would list it.
    await rekey(provider, await refreshKeys(provider, keys, { wrap: keys.wrap! }));
    await expect(refreshKeys(provider, keys, { wrap: keys.wrap! }, { epoch: 1, rev: 5, digest: hex("0") })).rejects.toBeInstanceOf(KeyringForkError);
  });

  it("can't prove the descent of a device further behind than the chain reaches", async () => {
    const { provider, keys } = await epochOne();
    const b = await generateIdentity();
    const seen = [anchorOf(keys)];
    let k = keys;
    // Each enrollment rewrites the keyring at the same epoch (rev + 1), even for a device already on the list.
    for (let i = 0; i < CHAIN_LENGTH + 3; i++) {
      k = await enrollDevice(provider, k, "B", b.recipient);
      seen.push(anchorOf(k));
    }
    // The chain now starts at revision 3: devices that saw 0, 1 or 2 are too far behind for it.
    expect((await keyringContents((await readKeyring(provider))!.file, k)).chain[0].slice(0, 2)).toEqual([1, 3]);
    for (const rev of [0, 1, 2]) {
      const behind = await refreshKeys(provider, keys, { wrap: keys.wrap! }, seen[rev]);
      expect(behind.ring, `from 1.${rev}`).toMatchObject({ rev: CHAIN_LENGTH + 3, unproven: true });
    }
    // One the chain still reaches is proven, and a wrong digest there is a fork.
    expect((await refreshKeys(provider, keys, { wrap: keys.wrap! }, seen[10])).ring!.unproven).toBeUndefined();
    await expect(refreshKeys(provider, keys, { wrap: keys.wrap! }, { ...seen[10], digest: hex("0") })).rejects.toBeInstanceOf(KeyringForkError);
  });
});
