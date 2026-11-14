/**
 * rr7-4, adapted for the pairing comparison (plan W8.5, lane S 14.11).
 *
 * The adaptation: since W8.5, `pair(code)` no longer commits anything. It
 * checks the code or answer and starts the comparison; the device is paired
 * only when the user has confirmed the symbols on both devices and each
 * device holds the other's confirmation (`confirmPairing` → "done"). So
 * "paired" below means what it meant before: the laptop's freshness became
 * verified. The user is modelled at their worst: on the laptop they press
 * "They match" without looking (the laptop shows symbols; A, which
 * cancelled, shows none and can confirm nothing). Nothing else changed: the
 * world, the storage swap and the assertion are the original's.
 *
 * Original header:
 * rr7-4 — cancelPairing and pairing-code races (N3's window).
 *
 * (a) cancelPairing, then revoke, then the answer is used anyway: A answers
 *     the laptop's request at epoch 1, the user cancels pairing on A and
 *     revokes the phone (epoch 2), then enters the answer on the laptop,
 *     which the storage keeps on the epoch-1 view. The engine's own doc says
 *     a given-out answer still verifies; this measures what follows.
 * (b) pairingCode() is not run under `exclusive` (engine.ts:985): a code made
 *     while A's revocation is in flight (the storage stalls the keyring PUT)
 *     vouches for epoch 1 and carries no lock that the in-flight re-key
 *     checks (it checked before). The laptop, shown epoch 1, pairs with it.
 * Secure outcome in both: the stale laptop doesn't become "paired".
 * A FAIL means the window is open; see the review for which is inherent.
 */
import { describe, expect, it } from "vitest";
import { P, E, K, AGE, H, enrolled, wrapFor, errName } from "./common";

function snap(p: { objects: Map<string, { data: Uint8Array; etag: string }> }) {
  return new Map([...p.objects].map(([k, v]) => [k, { data: v.data.slice(), etag: v.etag }]));
}

async function world() {
  const p = P.memoryProvider();
  const a = await H.newVault(p);
  a.files.set("a.md", "hello");
  await a.sync.sync();
  const phone = await AGE.generateIdentity();
  await a.sync.rekey({ enroll: { phone: phone.recipient } });
  await a.sync.sync();
  return { p, a, phone };
}

describe("rr7-4: pairing races", () => {
  it("(a) cancelPairing, revoke, then the old answer: the stale laptop must not pair", async () => {
    const { p, a, phone } = await world();
    // The laptop sees the real storage now (epoch 1)...
    const laptop = await H.joinVault("laptop", p);
    await laptop.sync.sync();
    const req = await laptop.sync.pairingRequest();
    const answer = await a.sync.answerPairing(req);
    const epoch1 = snap(p);
    const blocked = await a.sync.rekey({ revoke: ["phone"] }).then(() => "ok", errName);
    await a.sync.cancelPairing();
    const r = await a.sync.rekey({ revoke: ["phone"] });
    // ...and from now on the storage shows the laptop the epoch-1 snapshot.
    const stale = P.memoryProvider();
    for (const [k, v] of epoch1) stale.objects.set(k, v);
    (laptop.sync as any).o.provider = stale;
    const started = await laptop.sync.pair(answer).then(() => "started", errName);
    const laptopSymbols = await laptop.sync.pairingSas().then((x: { emoji: string[] } | null) => x?.emoji.join("") ?? "none", errName);
    const aSymbols = await a.sync.pairingSas().then((x: { emoji: string[] } | null) => x?.emoji.join("") ?? "none", errName);
    const aConfirm = await a.sync.confirmPairing().then((x: string) => x, errName);
    const laptopConfirm = await laptop.sync.confirmPairing().then((x: string) => x, errName); // the user presses "They match" anyway
    const paired = (await laptop.sync.freshness()).verified ? "paired" : `not paired (pair: ${started}, laptop shows ${laptopSymbols}, A shows ${aSymbols}, A confirm: ${aConfirm}, laptop confirm: ${laptopConfirm})`;
    laptop.files.set("new.md", "written on the laptop after the revocation");
    const up = await laptop.sync.sync().then((x) => x.uploaded, errName);
    const phoneSees = await enrolled(stale, "phone", phone.identity).then((d) => d.sync.sync().then(() => [...d.files.files.keys()]), errName);
    console.log("  before cancel:", blocked, "| after cancel A revokes: epoch", r.epoch, "| laptop with the old answer:", paired, "| uploaded:", up, "| revoked phone reads:", JSON.stringify(phoneSees));
    expect(paired).not.toBe("paired");
  });

  it("(b) a one-way code made while A's revocation is in flight: the stale laptop must not pair", async () => {
    const { p, a, phone } = await world();
    let release!: () => void;
    const stalled = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atPut = new Promise<void>((r) => (reached = r));
    const slow = {
      ...p,
      id: "slow",
      objects: p.objects,
      get: (n: string) => p.get(n),
      list: () => p.list(),
      delete: (n: string) => p.delete(n),
      async put(n: string, d: Uint8Array, c?: unknown) {
        if (n === K.KEYRING_NAME && armed) {
          armed = false;
          reached();
          await stalled;
        }
        return p.put(n, d, c as never);
      },
    };
    let armed = false;
    const a2 = H.device("A2", slow, a.sync.keys());
    a2.store.state = JSON.parse(JSON.stringify(a.store.state));
    a2.store.state.deviceId = "A2";
    await a2.sync.sync();
    const epoch1 = snap(p);
    armed = true;
    const rk = a2.sync.rekey({ revoke: ["phone"] }).then((x) => x, (e) => e);
    await atPut;
    const code = await a2.sync.pairingCode().then((c) => c, errName);
    release();
    const r = await rk;
    const stale = P.memoryProvider();
    for (const [k, v] of epoch1) stale.objects.set(k, v);
    const laptop = await H.joinVault("laptop", stale);
    await laptop.sync.sync();
    let paired = `no code: ${code}`;
    if (code.startsWith("lumen-pair")) {
      // As in (a): the full comparison, the user confirming on both devices.
      await laptop.sync.pair(code);
      await a2.sync.pairingSas();
      await laptop.sync.pairingSas();
      await a2.sync.confirmPairing().catch(errName);
      await laptop.sync.confirmPairing().catch(errName);
      paired = (await laptop.sync.freshness()).verified ? "paired" : "not paired";
    }
    const lrk = paired === "paired" ? await laptop.sync.rekey({}).then((x) => JSON.stringify(x.devices), errName) : "-";
    console.log("  A2's revocation:", (r as { epoch?: number }).epoch ?? errName(r), "| code made mid-revocation:", code.slice(0, 22), "| laptop (epoch-1 view):", paired, "| laptop re-key wraps:", lrk, "| phone unwraps:", !!(await wrapFor(stale, "phone", phone.identity)));
    expect(paired).not.toBe("paired");
  });
});
