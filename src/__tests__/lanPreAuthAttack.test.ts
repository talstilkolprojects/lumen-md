/**
 * Review W6.11 (weakness E56): the LAN host serves the vault header and the
 * keyring before a peer has proved it knows the passphrase (rpc.ts PRE_AUTH).
 * These are attack tests from the side of a device that has a link to the
 * host (it got through the QR or code exchange) but not the passphrase:
 *
 *   • offline guessing: the pre-proof bytes test a passphrase guess no cheaper
 *     than the header already does (same KDF, same salt);
 *   • metadata: the device map (ids, age recipients, how many) is not served;
 *   • replay and reflection: a recorded proof opens no other link;
 *   • a pre-proof copy of the keyring can't win a compare-and-swap;
 *   • a revoked device that keeps its old epoch keys can't prove itself.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { memoryProvider, PreconditionFailedError, type SyncProvider } from "../sync/e2ee/provider";
import { unlockVault, unlockWithDevice } from "../sync/e2ee/engine";
import { generateIdentity } from "../sync/e2ee/age";
import { decodeHeader, HEADER_NAME } from "../sync/e2ee/header";
import { decodeKeyring, KEYRING_NAME, KEYRING_PREV_NAME, unwrapSecret } from "../sync/e2ee/keyring";
import { deriveMasterKey, type KdfParams } from "../sync/e2ee/kdf";
import { DecryptError, hmac, passphraseKeys } from "../sync/e2ee/keys";
import { fromUtf8, randomBytes, toB64u, utf8 } from "../sync/e2ee/bytes";
import { memoryChannelPair, messenger, type LanChannel, type Message } from "../sync/e2ee/lan/channel";
import { lanHost, LanAuthError, remoteLanProvider } from "../sync/e2ee/lan/rpc";
import { newVault, PASSPHRASE, TEST_POLICY } from "./helpers/e2ee";

/** A vault at epoch 1 with two enrolled devices, served by a LAN host. */
async function hosted() {
  const bucket = memoryProvider();
  const owner = await newVault(bucket);
  owner.files.set("a.md", "# secret note");
  await owner.sync.sync();
  const phone = await generateIdentity();
  const laptop = await generateIdentity();
  await owner.sync.rekey({ enroll: { "tal-phone": phone.recipient, "tal-laptop": laptop.recipient } });
  const host = lanHost({ bucket, keys: () => owner.sync.keys() });
  const link = () => {
    const [h, p] = memoryChannelPair();
    host.attach(h);
    return p;
  };
  return { bucket, owner, host, link, phone, laptop };
}

/** A raw client: whatever an attacker's own code would send. */
function raw(channel: LanChannel) {
  const m = messenger(channel);
  let id = 1000;
  const waiting = new Map<number, (msg: Message) => void>();
  m.onMessage((msg) => waiting.get(msg.header.id as number)?.(msg));
  return (header: Record<string, unknown>) =>
    new Promise<Message>((resolve) => {
      const n = id++;
      waiting.set(n, resolve);
      m.send({ ...header, id: n });
    });
}

const proof = (role: "host" | "peer", theirs: string, mine: string) => utf8(`lumen-lan:1|${role}|${theirs}|${mine}`);

async function opensWrap(bucketKeyring: Uint8Array, passphrase: string, kdf: KdfParams): Promise<boolean> {
  const file = decodeKeyring(bucketKeyring);
  const { wrap } = await passphraseKeys(await deriveMasterKey(passphrase, kdf), file.vaultId);
  try {
    await unwrapSecret(file, { wrap });
    return true;
  } catch (e) {
    expect(e).toBeInstanceOf(DecryptError);
    return false;
  }
}

describe("the LAN host before the proof (E56)", () => {
  it("offline guessing: the keyring tests a guess only at the header's own KDF cost, with its salt", async () => {
    const d = await hosted();
    const stranger = remoteLanProvider(d.link());
    const header = decodeHeader((await stranger.get(HEADER_NAME))!.data, TEST_POLICY);
    const ring = (await stranger.get(KEYRING_NAME))!.data;
    expect(header.kdf.alg).toBe("pbkdf2-sha256");
    // The right passphrase opens the wrap (so does the header's MAC: nothing new), a wrong one doesn't.
    expect(await opensWrap(ring, PASSPHRASE, header.kdf)).toBe(true);
    expect(await opensWrap(ring, "wrong guess", header.kdf)).toBe(false);
    // No shortcut: one iteration fewer, another salt, or no salt stretching at all, and even the right passphrase fails.
    if (header.kdf.alg !== "pbkdf2-sha256") throw new Error("test vault uses PBKDF2");
    expect(await opensWrap(ring, PASSPHRASE, { ...header.kdf, iterations: header.kdf.iterations - 1 })).toBe(false);
    expect(await opensWrap(ring, PASSPHRASE, { ...header.kdf, salt: toB64u(randomBytes(16)) })).toBe(false);
    expect(await opensWrap(ring, PASSPHRASE, { ...header.kdf, iterations: 1 })).toBe(false);
    // The sealed part needs the epoch secret (32 random bytes), not the passphrase: nothing to guess there.
    const file = decodeKeyring(ring);
    expect(Object.keys(file).sort()).toEqual(["devices", "epoch", "format", "passphrase", "protocol", "sealed", "vaultId"]);
  });

  it("metadata: no device id, no age recipient and no device count before the proof; all of it after", async () => {
    const d = await hosted();
    const stranger = remoteLanProvider(d.link());
    const pre = await stranger.get(KEYRING_NAME);
    const text = fromUtf8(pre!.data);
    for (const leak of ["tal-phone", "tal-laptop", d.phone.recipient, d.laptop.recipient, "age-encryption.org"]) expect(text).not.toContain(leak);
    expect(decodeKeyring(pre!.data).devices).toEqual({});
    expect(pre!.etag.startsWith("pre-auth:")).toBe(true);
    // Object names, the .prev keyring and the listing stay closed.
    await expect(stranger.list()).rejects.toBeInstanceOf(LanAuthError);
    await expect(stranger.get(KEYRING_PREV_NAME)).rejects.toBeInstanceOf(LanAuthError);

    // An honest new device unlocks from those bytes, proves itself, and then reads the whole keyring.
    const keys = (await unlockVault(stranger, PASSPHRASE, TEST_POLICY)).keys;
    expect(keys.epoch).toBe(1);
    await stranger.authenticate(keys);
    const full = await stranger.get(KEYRING_NAME);
    expect(Object.keys(decodeKeyring(full!.data).devices).sort()).toEqual(["tal-laptop", "tal-phone"]);
    expect(full!.etag).toBe((await d.bucket.get(KEYRING_NAME))!.etag);
  });

  it("a compare-and-swap made with the pre-proof copy of the keyring fails, and the keyring is unchanged", async () => {
    const d = await hosted();
    const remote = remoteLanProvider(d.link());
    const pre = (await remote.get(KEYRING_NAME))!;
    const keys = (await unlockVault(remote, PASSPHRASE, TEST_POLICY)).keys;
    await remote.authenticate(keys);
    const before = (await d.bucket.get(KEYRING_NAME))!;
    await expect(remote.put(KEYRING_NAME, pre.data, { ifMatch: pre.etag })).rejects.toBeInstanceOf(PreconditionFailedError);
    const after = (await d.bucket.get(KEYRING_NAME))!;
    expect(after.etag).toBe(before.etag);
    expect(Object.keys(decodeKeyring(after.data).devices)).toHaveLength(2);
  });

  it("replay and reflection: a recorded proof opens no other link", async () => {
    const d = await hosted();
    const pairing = d.owner.sync.keys().pairing;
    // Link 1: an honest device proves itself; an eavesdropper records both proofs.
    const one = raw(d.link());
    const n1 = String((await one({ op: "challenge" })).header.nonce);
    const peerNonce = toB64u(randomBytes(16));
    const peerTag = toB64u(await hmac(pairing, proof("peer", n1, peerNonce)));
    const ok = await one({ op: "auth", nonce: peerNonce, tag: peerTag });
    expect(ok.header.error).toBeUndefined();
    const hostTag = String(ok.header.tag);
    // Link 2: a new host nonce, so the recorded peer proof is refused.
    const two = raw(d.link());
    const n2 = String((await two({ op: "challenge" })).header.nonce);
    expect(n2).not.toBe(n1);
    expect((await two({ op: "auth", nonce: peerNonce, tag: peerTag })).header.error).toBe("auth");
    // Link 3: the host's own proof, reflected as a peer's (its nonces fitted to the new link), is refused too.
    const three = raw(d.link());
    await three({ op: "challenge" });
    expect((await three({ op: "auth", nonce: n1, tag: hostTag })).header.error).toBe("auth");
    // And a refused link can't read anything else.
    expect((await two({ op: "list" })).header.error).toBe("auth");
  });

  it("a revoked device with its old epoch keys can't prove itself, and the pre-proof keyring has no wrap for it", async () => {
    const d = await hosted();
    const stolen = await unlockWithDevice(d.bucket, "tal-phone", d.phone.identity);
    expect(stolen.keys.epoch).toBe(1);
    await d.owner.sync.rekey({ revoke: ["tal-phone"] });
    const remote = remoteLanProvider(d.link());
    const pre = decodeKeyring((await remote.get(KEYRING_NAME))!.data);
    expect(pre.epoch).toBe(2);
    await expect(unwrapSecret(pre, { device: "tal-phone", identity: d.phone.identity })).rejects.toThrow();
    await expect(remote.authenticate(stolen.keys)).rejects.toBeInstanceOf(LanAuthError);
  });

  it("a malformed keyring in the bucket is not passed on before the proof", async () => {
    const bucket = memoryProvider();
    const owner = await newVault(bucket);
    await owner.sync.rekey();
    const bad: SyncProvider = {
      id: "bad",
      get: async (n) => (n === KEYRING_NAME ? { data: utf8("{not json"), etag: "x" } : bucket.get(n)),
      put: (n, data, cond) => bucket.put(n, data, cond),
      delete: (n) => bucket.delete(n),
      list: () => bucket.list(),
    };
    const host = lanHost({ bucket: bad, keys: () => owner.sync.keys() });
    const [h, p] = memoryChannelPair();
    host.attach(h);
    await expect(remoteLanProvider(p).get(KEYRING_NAME)).rejects.toThrow(/refused/);
  });
});
