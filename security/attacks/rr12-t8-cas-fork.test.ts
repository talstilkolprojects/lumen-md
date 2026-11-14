/**
 * In the repo (W10.D6): the lane-K round-2 version of the re-review test,
 * pairing through the W8.5 comparison (`pairVia`). Two harness changes: the
 * hooks are armed after the pairing, and A's stalled write waits for B to
 * reach its write *or* be refused. The "lie" case's assertion is widened to
 * the security property (no silent un-revocation; a fork, if any, is loud),
 * because B is now refused before it can fork; the fork-detection path with a
 * provider that also hides A's freeze from B is W10.D8.
 *
 * RR-8, adapted for lane K round 2. Re-keying devices are paired (RR-5).
 *  control: real CAS — B's commit is refused, the phone gets no wrap.
 *  If-Match ignored: the CAS probe refuses both re-keys (CasUnsupportedError);
 *    the keyring stays at epoch 1 and A still syncs.
 *  a provider that passes the probe and then ignores If-Match on the keyring
 *    (malicious): both commit; A's next round is a loud KeyringForkError.
 */
import { describe, expect, it } from "vitest";
import { P, K, E, AGE, H, enrolled, hooked, gate, wrapFor, pairVia } from "./common";

async function race(mode: "cas" | "ignore" | "lie") {
  const p = P.memoryProvider();
  const a = await H.newVault(p);
  a.files.set("a.md", "hello");
  await a.sync.sync();
  const phone = await AGE.generateIdentity();
  const laptop = await AGE.generateIdentity();
  await a.sync.rekey({ enroll: { phone: phone.recipient } });
  const lost = await enrolled(p, "phone", phone.identity);
  await lost.sync.sync();
  await a.sync.sync();

  const ignoreFor = (name: string) => mode === "ignore" || (mode === "lie" && name === K.KEYRING_NAME);
  const wrap = (opts: { before?: (op: string, n: string) => Promise<void> | void; after?: (op: string, n: string) => Promise<void> | void }) => {
    const h = hooked(p, opts);
    const put = h.put;
    h.put = async (n: string, d: Uint8Array, c?: unknown) => {
      if (!ignoreFor(n)) return put(n, d, c);
      await opts.before?.("put", n);
      const r = await p.put(n, d); // the condition is dropped
      await opts.after?.("put", n);
      return r;
    };
    return h;
  };
  const bReached = gate();
  const aDone = gate();
  let bPromise: Promise<unknown> | null = null;
  // The hooks are armed only after the pairing: since W8.5 the comparison's
  // own writes go through the same provider, and the race is about the re-keys.
  let armed = false;
  const pb = wrap({
    async before(op, name) {
      if (armed && op === "put" && name === K.KEYRING_NAME) {
        bReached.open();
        await aDone.wait();
      }
    },
  });
  const { keys: bKeys } = await E.unlockVault(p, H.PASSPHRASE, H.TEST_POLICY);
  const bDev = H.device("B", pb, bKeys);
  await bDev.sync.sync();
  await pairVia(bDev, a, p); // W8.5: code + comparison
  let fired = false;
  const pa = wrap({
    async before(op, name) {
      if (armed && !fired && op === "put" && name === K.KEYRING_NAME) {
        fired = true;
        bPromise = bDev.sync.rekey({ enroll: { laptop: laptop.recipient } }).then((r) => r, (e) => e);
        // B either reaches its own keyring write (the race) or is refused before
        // it (since review 16 a re-key re-reads the state and sees A's freeze).
        await Promise.race([bReached.wait(), bPromise]);
      }
    },
    async after(op, name) {
      if (armed && op === "put" && name === K.KEYRING_NAME) aDone.open();
    },
  });
  const aDev = H.device("A2", pa, a.sync.keys());
  await aDev.sync.sync();
  await pairVia(aDev, a, p); // W8.5: code + comparison
  armed = true;
  const ra = await aDev.sync.rekey({ revoke: ["phone"] }).then((r) => r, (e) => e);
  if (!fired) aDone.open();
  const rb = bPromise ? await bPromise : await bDev.sync.rekey({ enroll: { laptop: laptop.recipient } }).then((r) => r, (e) => e);
  const phoneSecret = await wrapFor(p, "phone", phone.identity);
  let aErr: unknown = null;
  aDev.files.set("after.md", "after revoking the phone");
  await aDev.sync.sync().catch((e) => (aErr = e));
  return { ra, rb, phoneSecret, aErr, keyringEpoch: JSON.parse(new TextDecoder().decode(p.objects.get(K.KEYRING_NAME)!.data)).epoch };
}

describe("RR-8 CAS not honoured (round 2)", () => {
  it("control: with real CAS the second commit is refused", async () => {
    const r = await race("cas");
    console.log("  control: A", (r.ra as any).devices, "| B:", (r.rb as Error).name, "| phone has wrap:", !!r.phoneSecret);
    expect((r.ra as any).devices).toEqual([]);
    expect(r.rb).toBeInstanceOf(Error);
    expect(r.phoneSecret).toBeNull();
    expect(r.aErr).toBeNull();
  });
  it("If-Match ignored: the CAS probe refuses both re-keys; nothing forks, A keeps syncing", async () => {
    const r = await race("ignore");
    console.log("  ignore: A", (r.ra as Error).name, "| B", (r.rb as Error).name, "| keyring epoch", r.keyringEpoch, "| A next sync:", r.aErr && (r.aErr as Error).name);
    expect((r.ra as Error).name).toBe("CasUnsupportedError");
    expect((r.rb as Error).name).toBe("CasUnsupportedError");
    expect(r.keyringEpoch).toBe(1);
    expect(r.aErr).toBeNull();
  });
  it("a provider that passes the probe, then ignores If-Match on the keyring: A's next round is a loud fork", async () => {
    const r = await race("lie");
    console.log("  lie: A", (r.ra as any).devices ?? (r.ra as Error).name, "| B", (r.rb as any).devices ?? (r.rb as Error).name, "| A next sync:", r.aErr && `${(r.aErr as Error).name}`);
    // Since review 16 B re-reads the state at its round and sees A's freeze, so
    // it is refused before its keyring write and nothing forks (the phone stays
    // out, A syncs on). If both did commit, A's next round must be a loud fork.
    // Either way the revocation is not undone silently.
    expect(r.phoneSecret).toBeNull();
    if (r.rb instanceof Error) expect(r.aErr).toBeNull();
    else expect((r.aErr as Error)?.name).toBe("KeyringForkError");
  });
});
