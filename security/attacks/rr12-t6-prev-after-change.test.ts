/**
 * In the repo (W10.D6): the lane-K round-2 version of the re-review test,
 * pairing through the W8.5 comparison (`pairVia`); no assertion changed.
 *
 * RR-6: `lumen-e2ee-keyring.prev` after a passphrase change has *finished*.
 * The keyring of epoch N+1 keeps its `header` field for the whole epoch, so
 * the "change in progress" branch of unlockVault stays reachable: a provider
 * that puts the old header and its saved copy of `.prev` back lets the old
 * passphrase open the vault (at epoch N) again, long after the change.
 * Spec §5: the copy lives "only while a passphrase change writes its header".
 * Also checks the other direction: the old passphrase never reaches N+1.
 */
import { describe, expect, it } from "vitest";
import { P, E, K, HDR, B, H, snap, restore, pairVia } from "./common";

describe("RR-6 .prev keyring (round 2: A2 paired before it re-keys)", () => {
  it("after a completed passphrase change, the provider can make the old passphrase open epoch N again", async () => {
    const p = P.memoryProvider();
    const a = await H.newVault(p);
    a.files.set("a.md", "before the change");
    await a.sync.sync();
    await a.sync.rekey(); // epoch 1
    // Capture what the provider sees during the change (it sees every write).
    let prevCopy: { data: Uint8Array; etag: string } | null = null;
    const oldHeader = snap(p).get(HDR.HEADER_NAME)!;
    const ph = { ...p, put: async (n: string, d: Uint8Array, c?: any) => { if (n === K.KEYRING_PREV_NAME) prevCopy = { data: d.slice(), etag: "x" }; return p.put(n, d, c); } };
    const a2 = H.device("A2", ph as never, a.sync.keys());
    await a2.sync.sync();
    await pairVia(a2, a, p); // W8.5: code + comparison // round 2: only a verified device re-keys (RR-5)
    await a2.sync.rekey({ newPassphrase: "new passphrase 2026", pbkdf2Iterations: H.TEST_ITERATIONS }); // epoch 2, complete
    expect(p.objects.has(K.KEYRING_PREV_NAME)).toBe(false);
    a2.files.set("b.md", "after the change");
    await a2.sync.sync();
    const ring = JSON.parse(B.fromUtf8(p.objects.get(K.KEYRING_NAME)!.data));
    console.log("  keyring epoch", ring.epoch, "still carries `header`:", typeof ring.header === "string");

    // Days later: the provider restores the old header and the .prev copy.
    p.objects.set(HDR.HEADER_NAME, oldHeader);
    p.objects.set(K.KEYRING_PREV_NAME, prevCopy!);
    const got = await E.unlockVault(p, H.PASSPHRASE, H.TEST_POLICY).then((r) => r.keys.epoch, (e) => `${e.name}`);
    console.log("  old passphrase opens epoch:", got);
    expect(got).not.toBe(1);
    expect(ring.header).toBeUndefined();
    expect(ring.prev).toBeUndefined();
  });

  it("round 2: the keyring that carried the change (with prev) can't be restored for a device that saw the finished one", async () => {
    const p = P.memoryProvider();
    const a = await H.newVault(p);
    a.files.set("a.md", "before the change");
    await a.sync.sync();
    await a.sync.rekey(); // epoch 1
    const oldHeader = snap(p).get(HDR.HEADER_NAME)!;
    let pendingRing: { data: Uint8Array; etag: string } | null = null;
    const ph = { ...p, put: async (n: string, d: Uint8Array, c?: any) => { const r = await p.put(n, d, c); if (n === K.KEYRING_NAME && JSON.parse(B.fromUtf8(d)).prev) pendingRing = { data: d.slice(), etag: r.etag }; return r; } };
    const a2 = H.device("A2", ph as never, a.sync.keys());
    await a2.sync.sync();
    await pairVia(a2, a, p); // W8.5: code + comparison
    await a2.sync.rekey({ newPassphrase: "new passphrase 2026", pbkdf2Iterations: H.TEST_ITERATIONS });
    expect(pendingRing).not.toBeNull();
    // The provider puts back the old header and the keyring that still carried `prev`.
    p.objects.set(HDR.HEADER_NAME, oldHeader);
    p.objects.set(K.KEYRING_NAME, pendingRing!);
    const fresh = await E.unlockVault(p, H.PASSPHRASE, H.TEST_POLICY).then((r) => r.keys.epoch, (e) => `${e.name}`);
    console.log("  an anchorless open with the old passphrase (inherent, spec §9):", fresh);
    let err: unknown = null;
    await a2.sync.sync().catch((e) => (err = e));
    console.log("  the device that finished the change:", (err as Error)?.name);
    expect((err as Error)?.name).toBe("KeyringRollbackError");
  });
});
