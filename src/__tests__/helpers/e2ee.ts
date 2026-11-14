/**
 * Shared setup for the encrypted-sync tests (plan 3.4): a simulated provider
 * folder and devices with cheap KDF parameters. The cheap parameters exist
 * only here; production defaults are asserted in e2eeCrypto.test.ts.
 */

import { createVault, unlockVault, E2eeSync } from "../../sync/e2ee/engine";
import { memoryFiles, type MemoryFiles } from "../../sync/e2ee/localFiles";
import { memoryStateStore } from "../../sync/e2ee/state";
import type { ConflictResolver } from "../../sync/e2ee/conflict";
import type { SyncProvider } from "../../sync/e2ee/provider";
import type { VaultKeys } from "../../sync/e2ee/keys";

export const TEST_ITERATIONS = 1000;
export const TEST_POLICY = { minPbkdf2Iterations: TEST_ITERATIONS };
export const PASSPHRASE = "סיסמה ארוכה מאוד 2026";

export interface Device {
  name: string;
  files: MemoryFiles;
  store: ReturnType<typeof memoryStateStore>;
  keys: VaultKeys;
  sync: E2eeSync;
}

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function device(name: string, provider: SyncProvider, keys: VaultKeys, resolver?: ConflictResolver, now?: () => number): Device {
  const files = memoryFiles();
  const store = memoryStateStore();
  return { name, files, store, keys, sync: new E2eeSync({ provider, keys, local: files, store, resolver, now }) };
}

/** A new vault with its creator device. */
export async function newVault(provider: SyncProvider, resolver?: ConflictResolver): Promise<Device> {
  const { keys, anchor } = await createVault(provider, PASSPHRASE, { pbkdf2Iterations: TEST_ITERATIONS });
  const d = device("A", provider, keys, resolver);
  await d.sync.markCreated(anchor);
  return d;
}

/** Another device that unlocks the existing vault with the passphrase. */
export async function joinVault(name: string, provider: SyncProvider, resolver?: ConflictResolver, now?: () => number): Promise<Device> {
  const { keys } = await unlockVault(provider, PASSPHRASE, TEST_POLICY);
  return device(name, provider, keys, resolver, now);
}

/**
 * Another device that unlocks with the passphrase and that the user has
 * confirmed by hand (as `confirmFreshness` does, before its first round):
 * for tests whose subject isn't freshness. An unverified device pulls but
 * doesn't upload (third review 12.11, N6).
 */
export async function joinTrusted(name: string, provider: SyncProvider, resolver?: ConflictResolver, now?: () => number): Promise<Device> {
  return trusted(await joinVault(name, provider, resolver, now));
}

/** `d`, confirmed by hand before its first round (see `joinTrusted`). */
export function trusted(d: Device): Device {
  d.store.state = { deviceId: `${d.name}-${Math.random().toString(36).slice(2, 10)}`, anchor: null, freshness: "confirmed", base: {}, pending: [] };
  return d;
}

/** Every file of `d`, sorted, as [path, text] pairs. */
export function snapshot(d: Device): Array<[string, string]> {
  return [...d.files.files.keys()].sort().map((p) => [p, d.files.text(p) ?? ""]);
}

/**
 * Pair `joiner` with `code` (a one-way code or the answer to its request)
 * from `issuer`, the user saying the symbols match on both devices (plan
 * W8.5): `pair`, the symbols on both, `confirmPairing` on both. Fails when
 * the symbols differ or either side doesn't finish. A joiner that needs
 * nothing from the code (verified, already newer) shows no symbols: then
 * the issuer's side is called off.
 */
export async function pairConfirmed(joiner: { sync: E2eeSync }, issuer: { sync: E2eeSync }, code: string, relay: () => void = () => undefined): Promise<void> {
  await joiner.sync.pair(code);
  relay();
  const i = await issuer.sync.pairingSas();
  relay();
  const j = await joiner.sync.pairingSas();
  if (!j) {
    await issuer.sync.rejectPairing();
    return;
  }
  if (!i || i.symbols.join() !== j.symbols.join()) throw new Error(`the symbols differ: ${i?.emoji.join("")} | ${j.emoji.join("")}`);
  if ((await issuer.sync.confirmPairing()) !== "waiting") throw new Error("the issuer finished before the new device confirmed");
  relay();
  if ((await joiner.sync.confirmPairing()) !== "done") throw new Error("the new device is still waiting");
  relay();
  if ((await issuer.sync.confirmPairing()) !== "done") throw new Error("the issuer is still waiting");
  relay();
}

/**
 * Two storages that differ (one withholds the other's state from a device)
 * but both pass on the comparison's objects (plan W8.5): copies every object
 * one has and the other lacks, both ways. For tests that pair a device the
 * storage shows a withheld copy.
 */
export function relayBetween(a: { objects: Map<string, { data: Uint8Array; etag: string }> }, b: { objects: Map<string, { data: Uint8Array; etag: string }> }): () => void {
  return () => {
    for (const [k, v] of a.objects) if (!b.objects.has(k)) b.objects.set(k, v);
    for (const [k, v] of b.objects) if (!a.objects.has(k)) a.objects.set(k, v);
  };
}
