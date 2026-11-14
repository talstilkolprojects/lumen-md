/**
 * rr7-2 — an old, genuine dropped marker, replayed, makes a revoked device
 * read "you were left out, pair again" even through the authenticated path.
 *
 * F4's marker is in the plaintext keyring file, outside the digest, and its
 * MAC (keyring.ts droppedData) covers vaultId, epoch, at and devices. The
 * engine's check (engine.ts refresh → verifyDropped → markerValid) accepts
 * any marker listing the device whose MAC the device's *older* secrets
 * reproduce — it doesn't require the marker to be for the epoch this device
 * lost access at. So the provider keeps a marker from an earlier drop and
 * puts it back after a real revocation.
 * Secure outcome: the revoked tablet gets RevokedError from its round.
 * A FAIL means the spoof worked.
 */
import { describe, expect, it } from "vitest";
import { P, E, K, AGE, H, B, enrolled, ringJson, errName } from "./common";

describe("rr7-2: dropped marker replay", () => {
  it("a marker from an earlier drop, put back after the tablet is revoked, must not turn the revocation into 'pair again'", async () => {
    const p = P.memoryProvider();
    const a = await H.newVault(p);
    a.files.set("a.md", "hello");
    await a.sync.sync();
    const tablet = await AGE.generateIdentity();
    await a.sync.rekey({ enroll: { tablet: tablet.recipient } }); // epoch 1
    await a.sync.sync();

    // An unverified passphrase device re-keys with consent: the tablet is left out (epoch 2, marker).
    const u = await H.joinVault("U", p);
    await u.sync.sync();
    const r = await u.sync.rekey({ dropDevices: true });
    const marker = ringJson(p).dropped;
    console.log("  dropped re-key:", r.epoch, "marker:", JSON.stringify(marker?.map((m: { epoch: number; devices: string[] }) => [m.epoch, m.devices])));

    // The owner pairs the tablet again (enroll) and the tablet runs normally at epoch 2.
    await a.sync.sync();
    await a.sync.enroll("tablet", tablet.recipient);
    const t = await enrolled(p, "tablet", tablet.identity);
    await t.sync.sync();
    console.log("  tablet back at epoch", t.sync.keys().epoch);

    // Then the owner really revokes the tablet (epoch 3): no marker for it.
    await a.sync.rekey({ revoke: ["tablet"] });
    const honest = await t.sync.sync().then(() => "ok", errName);
    // The provider puts the old marker back (it is outside the digest).
    const ring = ringJson(p);
    ring.dropped = marker;
    p.objects.set(K.KEYRING_NAME, { data: B.utf8(JSON.stringify(ring)), etag: "replayed" });
    const spoofed = await t.sync.sync().then(() => "ok", errName);
    const atOpen = await enrolled(p, "tablet", tablet.identity, t.store).then(() => "ok", errName);
    console.log("  tablet's round after the revocation:", honest, "| with the old marker put back:", spoofed, "| unlockWithDevice (unauthenticated by design):", atOpen);
    expect(honest).toBe("RevokedError");
    expect(spoofed).toBe("RevokedError");
  });
});
