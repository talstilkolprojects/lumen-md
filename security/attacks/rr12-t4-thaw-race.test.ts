/**
 * In the repo (W10.D6): the lane-K round-2 version of the re-review test,
 * pairing through the W8.5 comparison (`pairVia`); B is paired too (N6:
 * an unverified device never uploads). No assertion changed.
 *
 * RR-4: the freeze TTL compares `frozen.at` (the re-keyer's clock) with the
 * reader's clock. A device whose clock runs >= 10 minutes ahead treats a
 * fresh freeze as abandoned and writes over it. The re-keyer's guard
 * (re-read the frozen manifest's etag) runs *before* the keyring write, so a
 * thaw that lands between that check and the keyring commit is carried by
 * nobody: the epoch-N+1 manifest is the frozen one, without B's change, and
 * B's own `thawing` re-check read the keyring before the commit landed.
 * The same window opens without any skew if the provider (or a slow
 * network) holds the keyring write back for > 10 minutes after the check.
 * Expected (secure): B's edit reaches the vault, or B is told it did not.
 * Round 2 adaptation: A2 is paired before it re-keys (RR-5); nothing else changed.
 */
import { describe, expect, it } from "vitest";
import { P, K, H, hooked, pairVia } from "./common";

describe("RR-4 freeze TTL with a skewed clock", () => {
  it("a thaw between the re-keyer's freeze check and its keyring write is lost, and B is wedged", async () => {
    const p = P.memoryProvider();
    const a = await H.newVault(p);
    a.files.set("a.md", "v1");
    await a.sync.sync();
    let skew = 0; // B pairs with a right clock, then its clock runs 11 minutes ahead
    const b = await H.joinVault("B", p, undefined, () => Date.now() + skew);
    await b.sync.sync();
    // Since N6 an unverified device pulls but never uploads (its edits wait,
    // reported in `waiting`), so B is paired first: the race is about a
    // device whose edit would be uploaded.
    await pairVia(b, a, p); // W8.5: code + comparison
    skew = 11 * 60_000;
    let bRound: unknown = null;
    let fired = false;
    // A sees the provider through a wrapper: B syncs right before A's keyring write.
    const pa = hooked(p, {
      async before(op, name) {
        if (!fired && op === "put" && name === K.KEYRING_NAME) {
          fired = true;
          b.files.set("a.md", "v2 from B");
          bRound = await b.sync.sync();
        }
      },
    });
    const a2 = H.device("A2", pa, a.sync.keys());
    await a2.sync.sync();
    await pairVia(a2, a, p); // W8.5: code + comparison // round 2: only a verified device re-keys (RR-5)
    await a2.sync.rekey();
    console.log("  B's round during the re-key:", JSON.stringify(bRound));
    let bErr: unknown = null;
    await b.sync.sync().catch((e) => (bErr = e));
    const c = await H.joinVault("C", p);
    const cr = await c.sync.sync();
    console.log("  C round:", JSON.stringify(cr), "C epoch", c.sync.keys().epoch, "C files", [...c.files.files.keys()]);
    console.log("  B next round:", bErr && `${(bErr as Error).name}: ${(bErr as Error).message}`, "| vault has a.md =", JSON.stringify(c.files.text("a.md")), "| B local:", JSON.stringify(b.files.text("a.md")));
    expect(c.files.text("a.md")).toBe("v2 from B");
    expect(bErr).toBeNull();
  });
});
