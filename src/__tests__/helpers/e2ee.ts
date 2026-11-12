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
