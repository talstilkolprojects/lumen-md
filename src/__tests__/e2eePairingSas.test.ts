/**
 * Plan W8.5 (seventh review 12.11, G4): pairing commits only after the user
 * compared the symbols on both devices, and each device holds the other's
 * confirmation. A code or answer alone, a confirmation from another
 * pairing, or a key the first message didn't commit to pairs nothing.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { memoryProvider } from "../sync/e2ee/provider";
import { PairingAbortedError, PairingPendingError } from "../sync/e2ee/engine";
import { createPairingConfirm, createPairingReveal, pairingRequestHash, PairingError } from "../sync/e2ee/pairing";
import { opaqueName } from "../sync/e2ee/keys";
import { utf8 } from "../sync/e2ee/bytes";
import { SAS_EMOJI, SAS_LENGTH, sasKeyPair } from "../sync/e2ee/sas";
import { createVault, unlockVault } from "../sync/e2ee/engine";
import { generateIdentity } from "../sync/e2ee/age";
import { unlockWithDevice } from "../sync/e2ee/engine";
import { memoryFiles } from "../sync/e2ee/localFiles";
import { memoryStateStore } from "../sync/e2ee/state";
import { E2eeSync } from "../sync/e2ee/engine";
import { device, joinVault, newVault, pairConfirmed, PASSPHRASE, TEST_ITERATIONS, TEST_POLICY } from "./helpers/e2ee";

type Objects = Map<string, { data: Uint8Array; etag: string }>;
const copy = (m: Objects): Objects => new Map([...m].map(([k, v]) => [k, { data: v.data.slice(), etag: v.etag }]));
const isPairing = (d: Uint8Array) => new TextDecoder().decode(d.subarray(0, 11)) === "lumen-pair-";

/**
 * Review 13, S13-1: a vault with a phone enrolled; later the storage keeps
 * the laptop on the epoch-1 view and relays every comparison object it ever
 * saw. `outcome` says whether the stale laptop became verified and what the
 * revoked phone can then read.
 */
async function g4World(now?: () => number) {
  const p = memoryProvider();
  const { keys, anchor } = await createVault(p, PASSPHRASE, { pbkdf2Iterations: TEST_ITERATIONS });
  const a = device("A", p, keys, undefined, now);
  await a.sync.markCreated(anchor);
  a.files.set("a.md", "hello");
  await a.sync.sync();
  const phone = await generateIdentity();
  await a.sync.rekey({ enroll: { phone: phone.recipient } });
  await a.sync.sync();
  return { p, a, phone };
}
async function g4Outcome(laptop: { sync: E2eeSync; files: ReturnType<typeof memoryFiles> }, stale: ReturnType<typeof memoryProvider>, phone: { identity: string }) {
  const verified = (await laptop.sync.freshness()).verified;
  laptop.files.set("new.md", "written on the laptop after the revocation");
  await laptop.sync.sync();
  const { keys } = await unlockWithDevice(stale, "phone", phone.identity);
  const files = memoryFiles();
  await new E2eeSync({ provider: stale, keys, local: files, store: memoryStateStore(), access: { device: "phone", identity: phone.identity } }).sync();
  return { verified, phoneReads: [...files.files.keys()].sort() };
}
function staleView(epoch1: Objects, kept: Objects) {
  const stale = memoryProvider();
  for (const [k, v] of epoch1) stale.objects.set(k, v);
  for (const [k, v] of kept) if (isPairing(v.data)) stale.objects.set(k, v);
  return stale;
}

async function world() {
  const p = memoryProvider();
  const a = await newVault(p);
  a.files.set("a.md", "hello");
  await a.sync.sync();
  await a.sync.rekey();
  await a.sync.sync();
  const laptop = await joinVault("laptop", p);
  await laptop.sync.sync();
  return { p, a, laptop };
}

describe("W8.5: the pairing comparison", () => {
  it("two-way: the same five symbols on both devices; the new device is paired only once both users confirmed", async () => {
    const { a, laptop } = await world();
    const answer = await a.sync.answerPairing(await laptop.sync.pairingRequest());
    await laptop.sync.pair(answer);
    expect((await laptop.sync.freshness()).verified).toBe(false); // pair() alone commits nothing
    const j = await laptop.sync.pairingSas();
    const i = await a.sync.pairingSas();
    expect(j?.symbols).toHaveLength(SAS_LENGTH);
    expect(i?.symbols).toEqual(j?.symbols);
    expect(j?.emoji).toEqual(j?.symbols.map((n) => SAS_EMOJI[n]));
    // The new device's user first: it waits for the other device.
    expect(await laptop.sync.confirmPairing()).toBe("waiting");
    expect((await laptop.sync.freshness()).verified).toBe(false);
    expect(await a.sync.confirmPairing()).toBe("done");
    expect(await laptop.sync.confirmPairing()).toBe("done");
    expect((await laptop.sync.freshness()).source).toBe("paired");
  });

  it("one-way: the new device's key arrives through the storage, then the issuer's; the symbols match and both confirm", async () => {
    const { a, laptop } = await world();
    await laptop.sync.pair(await a.sync.pairingCode());
    expect(await laptop.sync.pairingSas()).toBeNull(); // the issuer hasn't revealed its key yet
    const i = await a.sync.pairingSas();
    const j = await laptop.sync.pairingSas();
    expect(i?.symbols).toEqual(j?.symbols);
    expect(await a.sync.confirmPairing()).toBe("waiting"); // the issuer confirms last (S13-1)
    expect(await laptop.sync.confirmPairing()).toBe("waiting");
    expect((await laptop.sync.freshness()).verified).toBe(false);
    expect(await a.sync.confirmPairing()).toBe("done");
    expect(await laptop.sync.confirmPairing()).toBe("done");
    expect((await laptop.sync.freshness()).source).toBe("paired");
  });

  it("G4: an answer used after the issuer cancelled pairs nothing, even when the new device's user confirms blindly", async () => {
    const { a, laptop } = await world();
    const answer = await a.sync.answerPairing(await laptop.sync.pairingRequest());
    await a.sync.cancelPairing();
    expect((await a.sync.rekey()).epoch).toBe(2); // the urgent key change goes ahead
    await laptop.sync.pair(answer); // the laptop still sees epoch 1 here: the answer reads
    expect(await laptop.sync.pairingSas()).not.toBeNull();
    expect(await a.sync.pairingSas()).toBeNull(); // nothing to compare on A
    await expect(a.sync.confirmPairing()).rejects.toBeInstanceOf(PairingAbortedError);
    expect(await laptop.sync.confirmPairing()).toBe("waiting");
    expect((await laptop.sync.freshness()).verified).toBe(false);
  });

  it("a mismatch on either device aborts and records nothing: the request is forgotten, the issuer's hold on key changes is released", async () => {
    const { a, laptop } = await world();
    const holdBefore = a.store.state!.pairingUntil;
    const answer = await a.sync.answerPairing(await laptop.sync.pairingRequest());
    await expect(a.sync.rekey()).rejects.toBeInstanceOf(PairingPendingError);
    await laptop.sync.pair(answer);
    await a.sync.pairingSas();
    await a.sync.rejectPairing(); // "They don't match" on A
    expect(a.store.state!.pairingUntil).toBe(holdBefore);
    await expect(a.sync.confirmPairing()).rejects.toBeInstanceOf(PairingAbortedError);
    expect(await laptop.sync.confirmPairing()).toBe("waiting");
    await laptop.sync.rejectPairing(); // and on the laptop
    expect(laptop.store.state!.pairRequest).toBeUndefined();
    expect((await laptop.sync.freshness()).verified).toBe(false);
    await expect(laptop.sync.pair(answer)).rejects.toBeInstanceOf(PairingError);
    expect((await a.sync.rekey()).epoch).toBe(2);
  });

  it("a confirmation from another pairing (replayed by the storage, or forged with the pairing key) aborts the new device's side", async () => {
    const { p, a, laptop } = await world();
    const request = await laptop.sync.pairingRequest();
    await laptop.sync.pair(await a.sync.answerPairing(request));
    await a.sync.pairingSas();
    const keys = laptop.sync.keys();
    const session = await pairingRequestHash(request);
    // A holder of the epoch's pairing key (the device about to be revoked) writes the issuer's confirmation.
    await p.put(await opaqueName(keys, `pairing/${session}/confirm-issuer`), utf8(await createPairingConfirm(keys, session, "issuer", new Uint8Array(32).fill(7))));
    await expect(laptop.sync.confirmPairing()).rejects.toBeInstanceOf(PairingAbortedError);
    expect((await laptop.sync.freshness()).verified).toBe(false);
  });

  it("a key the request didn't commit to (swapped in the storage) gives the issuer no symbols to show", async () => {
    const { p, a, laptop } = await world();
    const request = await laptop.sync.pairingRequest();
    await laptop.sync.pair(await a.sync.answerPairing(request));
    const keys = laptop.sync.keys();
    const session = await pairingRequestHash(request);
    const mallory = await sasKeyPair();
    await p.put(await opaqueName(keys, `pairing/${session}/reveal-joiner`), utf8(await createPairingReveal(keys, session, "joiner", mallory.pub)));
    expect(await a.sync.pairingSas()).toBeNull();
    await expect(a.sync.confirmPairing()).rejects.toThrow(/Compare the symbols/);
  });

  it("the issuer confirms only while its keys are those its answer vouched for", async () => {
    const { p, a, laptop } = await world();
    await laptop.sync.pair(await a.sync.answerPairing(await laptop.sync.pairingRequest()));
    await a.sync.pairingSas();
    // Another device changes the keys meanwhile; A syncs and adopts them.
    const b = await joinVault("B", p);
    b.store.state = { ...JSON.parse(JSON.stringify(a.store.state)), deviceId: "B" };
    delete b.store.state!.pairingUntil;
    await b.sync.sync();
    await b.sync.rekey();
    await a.sync.sync();
    expect(await a.sync.pairingSas()).toBeNull();
    await expect(a.sync.confirmPairing()).rejects.toBeInstanceOf(PairingAbortedError);
  });

  it("a new device restarted after its request (its comparison key is gone) can't use the answer", async () => {
    const { p, a, laptop } = await world();
    const answer = await a.sync.answerPairing(await laptop.sync.pairingRequest());
    const restarted = await joinVault("laptop", p);
    restarted.store.state = JSON.parse(JSON.stringify(laptop.store.state));
    await expect(restarted.sync.pair(answer)).rejects.toBeInstanceOf(PairingAbortedError);
    expect((await restarted.sync.freshness()).verified).toBe(false);
  });

  it("messages from builds before the comparison are refused as older", async () => {
    const { laptop } = await world();
    for (const old of ["lumen-pair:3:1:AAAA", "lumen-pair-answer:2:1:AAAA"]) await expect(laptop.sync.pair(old)).rejects.toThrow(/older build/);
  });

  it("S13-1 (a): two-way, A confirms first, then cancels and revokes; the stored objects are put back: the stale laptop isn't paired", async () => {
    const { p, a, phone } = await g4World();
    const laptop = await joinVault("laptop", p);
    await laptop.sync.sync();
    const answer = await a.sync.answerPairing(await laptop.sync.pairingRequest());
    const epoch1 = copy(p.objects);
    await laptop.sync.pair(answer);
    await a.sync.pairingSas();
    await laptop.sync.pairingSas();
    expect(await a.sync.confirmPairing()).toBe("waiting"); // nothing posted yet: the issuer confirms last
    const kept = copy(p.objects);
    await a.sync.cancelPairing();
    expect((await a.sync.rekey({ revoke: ["phone"] })).epoch).toBe(2);
    const stale = staleView(epoch1, kept);
    (laptop.sync as unknown as { o: { provider: unknown } }).o.provider = stale;
    expect(await laptop.sync.confirmPairing()).toBe("waiting");
    expect(await g4Outcome(laptop, stale, phone)).toEqual({ verified: false, phoneReads: ["a.md"] });
  });

  for (const order of ["issuer-first", "joiner-first"] as const) {
    it(`S13-1 (${order === "issuer-first" ? "b" : "c"}): one-way, ${order}, code entered at 1:50: the laptop's window ends with the code, inside A's hold`, async () => {
      let clock = 1_800_000_000_000;
      const now = () => clock;
      const { p, a, phone } = await g4World(now);
      const { keys } = await unlockVault(p, PASSPHRASE, TEST_POLICY);
      const laptop = device("laptop", p, keys, undefined, now);
      await laptop.sync.sync();
      const code = await a.sync.pairingCode();
      clock += 110_000;
      const epoch1 = copy(p.objects);
      await laptop.sync.pair(code);
      await a.sync.pairingSas();
      await laptop.sync.pairingSas();
      if (order === "issuer-first") expect(await a.sync.confirmPairing()).toBe("waiting");
      else {
        expect(await laptop.sync.confirmPairing()).toBe("waiting");
        expect(await a.sync.confirmPairing()).toBe("done");
      }
      const kept = copy(p.objects);
      clock += 15_000; // 2:05: the code has expired
      const revoke = await a.sync.rekey({ revoke: ["phone"] }).then(
        (r) => `epoch ${r.epoch}`,
        (e: Error) => e.name,
      );
      // Issuer-first: A never confirmed, so its hold ended with the code. Joiner-first: A's confirmation is out, so it holds (S13-1).
      expect(revoke).toBe(order === "issuer-first" ? "epoch 2" : "PairingPendingError");
      clock += 30_000; // 2:35
      const stale = staleView(epoch1, kept);
      (laptop.sync as unknown as { o: { provider: unknown } }).o.provider = stale;
      await expect(laptop.sync.confirmPairing()).rejects.toBeInstanceOf(PairingAbortedError);
      expect(await g4Outcome(laptop, stale, phone)).toEqual({ verified: false, phoneReads: ["a.md"] });
    });
  }

  it("S13-1: once A has confirmed, cancelling doesn't release its hold until the new device's window has ended", async () => {
    let clock = Date.now(); // the laptop runs on the real clock
    const { a, laptop } = await world();
    const a2 = device("A", (a.sync as unknown as { o: { provider: ReturnType<typeof memoryProvider> } }).o.provider, a.sync.keys(), undefined, () => clock);
    a2.store.state = JSON.parse(JSON.stringify(a.store.state));
    await laptop.sync.pair(await a2.sync.pairingCode());
    await a2.sync.pairingSas();
    await laptop.sync.pairingSas();
    expect(await laptop.sync.confirmPairing()).toBe("waiting");
    expect(await a2.sync.confirmPairing()).toBe("done");
    await a2.sync.cancelPairing();
    await expect(a2.sync.rekey()).rejects.toBeInstanceOf(PairingPendingError);
    clock += 2 * 60_000 + 60_000 + 1; // the code's life plus the clock allowance
    expect((await a2.sync.rekey()).epoch).toBe(2);
  });

  it("the helper the other suites use pairs through the full comparison, and leaves no pairing objects in the storage", async () => {
    const { p, a, laptop } = await world();
    const before = new Set(p.objects.keys());
    await pairConfirmed(laptop, a, await a.sync.pairingCode());
    expect((await laptop.sync.freshness()).source).toBe("paired");
    expect([...p.objects.keys()].filter((k) => !before.has(k))).toEqual([]);
    await pairConfirmed(laptop, a, await a.sync.answerPairing(await laptop.sync.pairingRequest()));
    expect([...p.objects.keys()].filter((k) => !before.has(k))).toEqual([]);
  });
});
