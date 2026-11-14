/**
 * RR-3: every epoch's manifest object name is HMAC(names, "manifest/<N>"),
 * and the names key comes from epoch 0 — which every device that was ever
 * enrolled (and the old passphrase) holds. A device about to be revoked (or
 * already revoked, as long as it can still write to the provider) plants
 * junk under the next epochs' manifest names. The re-key's step 4 is
 * create-only, so it "loses", reads the junk, and every device is wedged
 * with DecryptError at the new epoch.
 * Expected (secure/available): the re-key completes and devices keep syncing.
 */
import { describe, expect, it } from "vitest";
import { P, M, B, AGE, H, enrolled } from "./common";

describe("RR-3 pre-planted manifest names", () => {
  it("a soon-to-be-revoked device wedges the vault by planting manifest/<N+1>", async () => {
    const p = P.memoryProvider();
    const a = await H.newVault(p);
    a.files.set("a.md", "hello");
    await a.sync.sync();
    const phone = await AGE.generateIdentity();
    await a.sync.rekey({ enroll: { phone: phone.recipient } }); // epoch 1
    const lost = await enrolled(p, "phone", phone.identity);
    await lost.sync.sync();

    // The phone (thief) computes the next manifest names from the epoch-0 names key it holds.
    for (let n = 2; n <= 5; n++) {
      const name = await M.manifestNameFor(lost.keys, `manifest/${n}`);
      await p.put(name, B.randomBytes(300));
    }

    const b = await H.joinVault("B", p);
    await b.sync.sync();
    let rekeyErr: unknown = null;
    await a.sync.rekey({ revoke: ["phone"] }).catch((e) => (rekeyErr = e));
    const errs: string[] = [];
    for (const d of [a, b]) {
      try {
        d.files.set("after.md", "written after the revocation");
        await d.sync.sync();
      } catch (e) {
        errs.push(`${d.name}: ${(e as Error).name}: ${(e as Error).message}`);
      }
    }
    console.log("  rekey:", rekeyErr && (rekeyErr as Error).name, "| sync errors:", errs);
    expect(rekeyErr).toBeNull();
    expect(errs).toEqual([]);
  });
});
