/**
 * Keyring edges the mutation run (W4.17) found untested after the W4.11
 * split: the AES-GCM nonce size, the dropped-marker cap, `verifyDropped`'s
 * three conditions, `rewriteKeyring`'s precondition, and `confirmCommit`
 * without key access. Real WebCrypto, the simulated provider folder.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { memoryProvider, PreconditionFailedError } from "../sync/e2ee/provider";
import { generateIdentity } from "../sync/e2ee/age";
import { fromB64u, fromUtf8, utf8 } from "../sync/e2ee/bytes";
import { unlockWithDevice } from "../sync/e2ee/engine";
import { confirmCommit, decodeKeyring, DROPPED_LENGTH, KEYRING_NAME, readKeyring, rewriteKeyring, verifyDropped } from "../sync/e2ee/keyring";
import { joinVault, newVault } from "./helpers/e2ee";

type Provider = ReturnType<typeof memoryProvider>;
const ringJson = (p: Provider) => JSON.parse(fromUtf8(p.objects.get(KEYRING_NAME)!.data));

/** A vault at epoch 1 with a tablet enrolled, then a dropped re-key (epoch 2) that leaves the tablet out with a marker. */
async function dropped() {
  const p = memoryProvider();
  const a = await newVault(p);
  a.files.set("a.md", "hello");
  await a.sync.sync();
  const tablet = await generateIdentity();
  await a.sync.rekey({ enroll: { tablet: tablet.recipient } });
  await a.sync.sync();
  const { keys: tabletKeys } = await unlockWithDevice(p, "tablet", tablet.identity, null); // holds S1
  const u = await joinVault("U", p);
  await u.sync.sync();
  await u.sync.rekey({ dropDevices: true });
  return { p, a, tabletKeys };
}

describe("keyring edges", () => {
  it("every sealed part has a 96-bit AES-GCM nonce", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    await a.sync.sync();
    await a.sync.rekey({});
    const ring = ringJson(p);
    expect(fromB64u(ring.sealed.n)).toHaveLength(12);
    expect(fromB64u(ring.passphrase.n)).toHaveLength(12);
  });

  it(`a keyring may carry up to ${DROPPED_LENGTH} dropped markers, not more`, async () => {
    const { p } = await dropped();
    const ring = ringJson(p);
    const one = ring.dropped[0];
    ring.dropped = Array.from({ length: DROPPED_LENGTH }, () => one);
    expect(decodeKeyring(utf8(JSON.stringify(ring))).dropped).toHaveLength(DROPPED_LENGTH);
    ring.dropped = Array.from({ length: DROPPED_LENGTH + 1 }, () => one);
    expect(() => decodeKeyring(utf8(JSON.stringify(ring)))).toThrow(/Not a Lumen keyring/);
  });

  it("verifyDropped: only a genuine marker for this device, at the first epoch it lacks", async () => {
    const { p, a, tabletKeys } = await dropped();
    const file = (await readKeyring(p))!.file;
    expect(await verifyDropped(file, "tablet", tabletKeys)).toBe(true);
    expect(await verifyDropped(file, "laptop", tabletKeys)).toBe(false); // not named
    await a.sync.sync().catch(() => undefined);
    const k1 = a.sync.keys();
    expect(k1.epoch).toBe(2);
    expect(await verifyDropped(file, "tablet", k1)).toBe(false); // epoch 3 isn't what the marker is for
    const forged = { ...file, dropped: file.dropped!.map((m) => ({ ...m, mac: m.mac.slice(0, -2) + (m.mac.endsWith("AA") ? "BB" : "AA") })) };
    expect(await verifyDropped(forged, "tablet", tabletKeys)).toBe(false); // MAC
  });

  it("rewriteKeyring refuses keys of a keyring that isn't the live one, and writes nothing", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    await a.sync.sync();
    await a.sync.rekey({});
    const stale = a.sync.keys();
    const laptop = await generateIdentity();
    await a.sync.enroll("laptop", laptop.recipient); // rev + 1: `stale` names the keyring before it
    const before = p.objects.get(KEYRING_NAME)!.data;
    await expect(rewriteKeyring(p, stale, { wrap: stale.wrap! }, (c, f) => ({ contents: c, file: f }))).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(p.objects.get(KEYRING_NAME)!.data).toEqual(before);
  });

  it("confirmCommit accepts its own bytes read back, also without key access", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    await a.sync.sync();
    await a.sync.rekey({});
    const bytes = p.objects.get(KEYRING_NAME)!.data;
    await expect(confirmCommit(p, a.sync.keys(), bytes, null)).resolves.toBeUndefined();
    await expect(confirmCommit(p, a.sync.keys(), utf8("{}"), null)).rejects.toMatchObject({ name: "KeyringCommitLostError" });
  });
});
