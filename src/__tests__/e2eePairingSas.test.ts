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
import { joinVault, newVault, pairConfirmed } from "./helpers/e2ee";

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
    expect(await a.sync.confirmPairing()).toBe("waiting");
    expect(await laptop.sync.confirmPairing()).toBe("done");
    expect(await a.sync.confirmPairing()).toBe("done");
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
