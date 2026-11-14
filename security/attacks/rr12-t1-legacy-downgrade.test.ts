/**
 * In the repo (W10.D6): the lane-K round-2 version of the re-review test.
 * The legacy vault comes from a fixture the pre-fix engine wrote, instead of
 * importing a pre-fix checkout. No assertion changed.
 *
 * RR-1, adapted for lane K round 2: the legacy path is gone. A pre-release
 * keyring (made by the real pre-fix engine, bb83b845a) is refused at every
 * open; the passphrase can reset it to a new epoch wrapped for nobody else.
 * Secure behaviour: the attacker never gets a wrap, in (a) and (b).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { P, E, K, B, AGE, H, wrapFor, readWithSecret } from "./common";

/**
 * The pre-release vault, as the real pre-fix engine (bb83b845a) wrote it:
 * newVault, a note, then `rekey({ enroll: { phone } })`, dumped object by
 * object (fixtures/legacy-vault.json, generated once from a checkout of
 * bb83b845a; the review imported that checkout live). The phone's identity
 * is a throwaway test key.
 */
const LEGACY = JSON.parse(readFileSync("security/attacks/fixtures/legacy-vault.json", "utf8")) as {
  phone: { identity: string; recipient: string };
  objects: Record<string, { data: string; etag: string }>;
};

async function legacyVault() {
  const p = P.memoryProvider();
  for (const [name, o] of Object.entries(LEGACY.objects)) p.objects.set(name, { data: B.fromB64u(o.data), etag: o.etag });
  return { p, phone: LEGACY.phone };
}
async function evilEntry() {
  const evil = await AGE.generateIdentity();
  const wrap = B.toB64u(await AGE.ageEncrypt(B.randomBytes(32), [{ x25519: evil.recipient }]));
  return { evil, entry: { recipient: evil.recipient, wrap } };
}
function editRing(p: ReturnType<typeof P.memoryProvider>, f: (r: any) => void) {
  const o = p.objects.get(K.KEYRING_NAME)!;
  const r = JSON.parse(B.fromUtf8(o.data));
  f(r);
  p.objects.set(K.KEYRING_NAME, { data: B.utf8(JSON.stringify(r)), etag: o.etag });
}
async function reset(p: ReturnType<typeof P.memoryProvider>) {
  const { keys } = await E.unlockVault(p, H.PASSPHRASE, H.TEST_POLICY, { resetPreReleaseKeyring: true });
  return H.device("R", p, keys);
}

describe("RR-1 legacy keyring (round 2)", () => {
  it("(a) TOFU is gone: a pre-release keyring with a provider-added recipient is refused; the reset wraps for nobody", async () => {
    const { p, phone } = await legacyVault();
    const { evil, entry } = await evilEntry();
    editRing(p, (r) => (r.devices.evil = entry));
    await expect(H.joinVault("B", p)).rejects.toBeInstanceOf(K.PreReleaseKeyringError);
    await expect(E.unlockWithDevice(p, "phone", phone.identity)).rejects.toBeInstanceOf(K.PreReleaseKeyringError);
    const r = await reset(p);
    await expect(r.sync.sync()).rejects.toBeInstanceOf(K.PreReleaseKeyringError);
    const out = await r.sync.rekey();
    console.log("  (a) reset wraps for:", out.devices, "epoch", out.epoch);
    expect(out.devices).toEqual([]);
    const stolen = await wrapFor(p, "evil", evil.identity);
    console.log("  (a) attacker reads:", stolen ? await readWithSecret(p, stolen) : null);
    expect(stolen).toBeNull();
    expect(await wrapFor(p, "phone", phone.identity)).toBeNull();
    const c = await H.joinVault("C", p);
    await c.sync.sync();
    expect(c.files.text("secret.md")).toBe("the source's name");
  });

  it("(b) replaying the pre-release keyring after the reset is a rollback, and a fresh open refuses it", async () => {
    const { p } = await legacyVault();
    const legacyBytes = p.objects.get(K.KEYRING_NAME)!.data.slice();
    const r = await reset(p);
    await r.sync.rekey();
    await r.sync.sync();
    const { evil, entry } = await evilEntry();
    const r0 = JSON.parse(B.fromUtf8(legacyBytes));
    r0.devices.evil = entry;
    const cur = p.objects.get(K.KEYRING_NAME)!;
    p.objects.set(K.KEYRING_NAME, { data: B.utf8(JSON.stringify(r0)), etag: cur.etag + "-replayed" });
    let err: unknown = null;
    await r.sync.sync().catch((e) => (err = e));
    console.log("  (b) device after the reset:", (err as Error)?.name);
    expect(err).toBeInstanceOf(K.KeyringRollbackError);
    await expect(H.joinVault("B", p)).rejects.toBeInstanceOf(K.PreReleaseKeyringError);
    await expect(r.sync.rekey({ revoke: ["phone"] })).rejects.toBeInstanceOf(K.KeyringRollbackError);
    // Nothing was written over the replay; the real keyring (put back) has no wrap for the attacker.
    expect(B.fromUtf8(p.objects.get(K.KEYRING_NAME)!.data)).toBe(JSON.stringify(r0));
    p.objects.set(K.KEYRING_NAME, cur);
    expect(await wrapFor(p, "evil", evil.identity)).toBeNull();
    await r.sync.sync();
  });
});
