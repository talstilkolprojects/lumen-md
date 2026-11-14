/**
 * In the repo (W10.D6): the lane-K round-2 version of the re-review test,
 * pairing through the W8.5 comparison (`pairVia`); no assertion changed.
 *
 * RR-5, adapted for lane K round 2. What is feasible is refused; what is
 * inherent is asserted as such (spec §9).
 *  (i)  unpaired laptop served the epoch-1 world: it syncs (inherent: its new
 *       note is under epoch-1 keys, which the revoked phone holds), but it is
 *       "unverified", and its re-key is refused, so the phone is never wrapped again.
 *  (ii) a pairing code from A (epoch 2) on that laptop: refused, naming the
 *       older key epoch — the code anchors the keyring, so the rollback shows.
 *  (iii) a laptop paired at epoch 2: the provider rolls it back to epoch 1 → refused.
 */
import { describe, expect, it } from "vitest";
import { P, K, M, E, AGE, H, enrolled, snap, restore, wrapFor, pairVia } from "./common";

async function world() {
  const p = P.memoryProvider();
  const a = await H.newVault(p);
  a.files.set("a.md", "old");
  await a.sync.sync();
  const phone = await AGE.generateIdentity();
  await a.sync.rekey({ enroll: { phone: phone.recipient } }); // epoch 1
  const lost = await enrolled(p, "phone", phone.identity);
  await lost.sync.sync();
  const before = snap(p);
  await a.sync.rekey({ revoke: ["phone"] }); // epoch 2
  await a.sync.sync();
  const m1 = await M.manifestName(lost.keys);
  return { p, a, phone, lost, before, m1 };
}

describe("RR-5 fresh-device rollback (round 2)", () => {
  it("(i) unpaired: syncs at the served epoch (inherent) but can't re-key; the phone stays out", async () => {
    const { p, phone, lost, before, m1 } = await world();
    const now = snap(p);
    restore(p, before, [K.KEYRING_NAME, m1]);
    const c = await H.joinVault("laptop", p);
    await c.sync.sync();
    c.files.set("new.md", "written after the phone was revoked");
    await c.sync.sync();
    await lost.sync.sync();
    console.log("  (i) laptop epoch:", c.sync.keys().epoch, "freshness:", (await c.sync.freshness()).source, "| revoked phone sees new.md (inherent):", JSON.stringify(lost.files.text("new.md")));
    expect((await c.sync.freshness()).verified).toBe(false);
    p.objects.delete(await M.manifestNameFor(lost.keys, "manifest/2"));
    await expect(c.sync.rekey()).rejects.toBeInstanceOf(E.UnverifiedDeviceError);
    await expect(c.sync.enroll("tablet", (await AGE.generateIdentity()).recipient)).rejects.toBeInstanceOf(E.UnverifiedDeviceError);
    expect(await wrapFor(p, "phone", phone.identity)).not.toBeNull(); // the epoch-1 keyring the provider replays, unchanged
    restore(p, now);
    expect(await wrapFor(p, "phone", phone.identity)).toBeNull();
  });

  it("(ii) a pairing code from the real epoch refuses the rolled-back laptop, naming the key epoch", async () => {
    const { p, a, before, m1 } = await world();
    restore(p, before, [K.KEYRING_NAME, m1]);
    const c = await H.joinVault("laptop", p);
    await c.sync.sync();
    const err = await c.sync.pair(await a.sync.pairingCode()).then(() => null, (e) => e);
    console.log("  (ii)", (err as Error)?.message);
    expect((err as Error)?.name).toBe("PairingError");
    expect((err as Error).message).toMatch(/epoch 2/);
  });

  it("(iii) paired at epoch 2, then served epoch 1: refused as a rollback", async () => {
    const { p, a, before, m1 } = await world();
    const c = await H.joinVault("laptop", p);
    await c.sync.sync();
    await pairVia(c, a, p); // W8.5: code + comparison
    restore(p, before, [K.KEYRING_NAME, m1]);
    const err = await c.sync.sync().then(() => null, (e) => e);
    console.log("  (iii)", (err as Error)?.name);
    expect((err as Error)?.name).toBe("KeyringRollbackError");
    // A fresh process on that laptop, its state kept, opening the rolled-back vault:
    const { keys } = await E.unlockVault(p, H.PASSPHRASE, H.TEST_POLICY);
    const again = new E.E2eeSync({ provider: p, keys, local: c.files, store: c.store });
    await expect(again.sync()).rejects.toBeInstanceOf(K.KeyringRollbackError);
  });
});
