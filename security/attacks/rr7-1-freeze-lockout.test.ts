/**
 * rr7-1 — the device being revoked keeps the vault from ever re-keying.
 *
 * Q2's freeze defense (engine.ts:787-793) makes a re-key wait FREEZE_TTL_MS
 * on a foreign freeze, but the clock (`frozenSeen`) restarts whenever the
 * manifest's digest changes. A stolen phone still holds the current epoch's
 * secret and the storage login, so it writes a fresh frozen manifest (a new
 * digest) every 9 minutes. A's `rekey({revoke:["phone"]})` then throws
 * KeyChangeInProgressError ("10 minutes at most") for ever, and so does a
 * passphrase change: the revocation the user needs never happens, and the
 * phone keeps reading. Before round 4, A froze over at once.
 * Secure outcome: A's revocation goes through within FREEZE_TTL_MS (+ a
 * margin) of its first attempt. A FAIL means the attack worked.
 */
import { describe, expect, it } from "vitest";
import { P, E, M, AGE, enrolled, newVaultAt, freezeAs, wrapFor, errName } from "./common";

async function setup() {
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const p = P.memoryProvider();
  const a = await newVaultAt(p, now);
  a.files.set("a.md", "hello");
  await a.sync.sync();
  const phone = await AGE.generateIdentity();
  await a.sync.rekey({ enroll: { phone: phone.recipient } });
  await a.sync.sync();
  const thief = await enrolled(p, "phone", phone.identity);
  await thief.sync.sync();
  return { p, a, phone, thief, tick: (ms: number) => (clock += ms), now };
}

describe("rr7-1: KeyChangeInProgressError as a lever for the device being revoked", () => {
  it("control: one stale freeze — A waits FREEZE_TTL_MS, then revokes", async () => {
    const { p, a, phone, thief, tick, now } = await setup();
    await freezeAs(p, thief.keys, "phone", now());
    const first = await a.sync.rekey({ revoke: ["phone"] }).then((r) => r, (e) => e);
    tick(M.FREEZE_TTL_MS + 1000);
    const later = await a.sync.rekey({ revoke: ["phone"] }).then((r) => r, (e) => e);
    console.log("  control: first", errName(first), "| after the TTL:", (later as { epoch?: number }).epoch ?? errName(later), "| phone wrap:", !!(await wrapFor(p, "phone", phone.identity)));
    expect(first).toBeInstanceOf(E.KeyChangeInProgressError);
    expect((later as { epoch?: number }).epoch).toBe(2);
  });

  it("the phone re-freezes every 9 minutes: A must still be able to revoke it within the TTL", async () => {
    const { p, a, phone, thief, tick, now } = await setup();
    const results: string[] = [];
    let done: { epoch: number } | null = null;
    for (let i = 0; i < 6 && !done; i++) {
      await freezeAs(p, thief.keys, "phone", now());
      const r = await a.sync.rekey({ revoke: ["phone"] }).then((x) => x, (e) => e);
      if ((r as { epoch?: number }).epoch) done = r as { epoch: number };
      results.push((r as { epoch?: number }).epoch ? `epoch ${(r as { epoch: number }).epoch}` : errName(r));
      tick(9 * 60_000);
    }
    const pass = await a.sync.rekey({ revoke: [], newPassphrase: "a new passphrase for the vault 2026" }).then((x) => `epoch ${(x as { epoch: number }).epoch}`, errName);
    const sync = await a.sync.sync().then((r) => `rekeyPending=${!!(r as { rekeyPending?: boolean }).rekeyPending} uploaded=${(r as { uploaded: number }).uploaded}`, errName);
    console.log("  over 54 minutes:", results.join(" | "), "| passphrase change:", pass, "| A's sync:", sync, "| phone still unwraps the live epoch:", !!(await wrapFor(p, "phone", phone.identity)));
    expect(done).not.toBeNull();
  });
});
