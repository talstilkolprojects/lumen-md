/**
 * Creating and opening a vault: with the passphrase, or with a device's own
 * age key (split out of engine.ts, W4.11; no behaviour change). Import them
 * from "./engine".
 */

import { equalBytes, fromB64u, sha256Hex } from "./bytes";
import { createHeader, decodeHeader, encodeHeader, HEADER_NAME, unlockHeader, WrongPassphraseError, type VaultHeader } from "./header";
import { PBKDF2_MIN_ITERATIONS, type KdfPolicy } from "./kdf";
import { DecryptError, type VaultKeys } from "./keys";
import {
  checkDeviceEnrolled,
  decodeKeyring,
  keyringDigest,
  keysFromKeyring,
  PreReleaseKeyringError,
  readKeyring,
  TamperedWrapError,
  unwrapSecret,
  verifyAnchor,
} from "./keyring";
import { emptyManifest, manifestName, openManifest, sealManifest, type FreshnessAnchor, type Manifest } from "./manifest";
import { PreconditionFailedError, type SyncProvider } from "./provider";
import type { DeviceState } from "./state";
import { NoVaultError, VaultExistsError } from "./engineTypes";

/**
 * Create a vault at `provider`: the header (create-only) and the first,
 * empty manifest (counter 1). Returns the keys and the creator's anchor.
 *
 * Creation can be retried after an interruption: when a header is already
 * there that this passphrase unlocks and the vault is still empty (no
 * manifest, or only the empty first one), creation resumes on it.
 * Otherwise — someone else's vault, or one with data — `VaultExistsError`.
 */
export async function createVault(
  provider: SyncProvider,
  passphrase: string,
  opts: { pbkdf2Iterations?: number } = {},
): Promise<{ header: VaultHeader; keys: VaultKeys; anchor: FreshnessAnchor }> {
  let { header, keys } = await createHeader(passphrase, opts);
  try {
    await provider.put(HEADER_NAME, encodeHeader(header), { ifNoneMatch: "*" });
  } catch (e) {
    if (!(e instanceof PreconditionFailedError)) throw e;
    // The floor never drops below production unless the caller asked for fewer iterations itself.
    const floor = Math.min(PBKDF2_MIN_ITERATIONS, opts.pbkdf2Iterations ?? PBKDF2_MIN_ITERATIONS);
    try {
      ({ header, keys } = await unlockVault(provider, passphrase, { minPbkdf2Iterations: floor }));
    } catch {
      throw new VaultExistsError();
    }
  }
  const name = await manifestName(keys);
  const existing = await provider.get(name);
  if (existing) {
    const { manifest, digest } = await openManifest(keys, existing.data, name);
    if (manifest.counter === 1 && Object.keys(manifest.files).length === 0) {
      return { header, keys, anchor: { counter: 1, digest } };
    }
    throw new VaultExistsError();
  }
  const first: Manifest = { ...emptyManifest(keys.vaultId), counter: 1 };
  const sealed = await sealManifest(keys, first, name);
  try {
    await provider.put(name, sealed.bytes, { ifNoneMatch: "*" });
  } catch (e) {
    if (e instanceof PreconditionFailedError) throw new VaultExistsError();
    throw e;
  }
  return { header, keys, anchor: { counter: 1, digest: sealed.digest } };
}

/**
 * Read the header at `provider` and derive the keys; `WrongPassphraseError`
 * on a wrong passphrase. A keyring from a pre-release build is refused
 * (`PreReleaseKeyringError`) unless `resetPreReleaseKeyring`: then the keys
 * can do one thing, `E2eeSync.rekey()`, which wraps the new epoch for the
 * passphrase (and the devices it enrolls) only.
 */
export async function unlockVault(
  provider: SyncProvider,
  passphrase: string,
  policy: KdfPolicy = {},
  opts: { resetPreReleaseKeyring?: boolean; state?: Pick<DeviceState, "ring"> | null } = {},
): Promise<{ header: VaultHeader; keys: VaultKeys }> {
  const out = await openWithPassphrase(provider, passphrase, policy, opts);
  // The keyring this device verified before (N1): the keys must hold its secret.
  if (opts.state?.ring) await verifyAnchor(out.keys, opts.state.ring);
  return out;
}

async function openWithPassphrase(
  provider: SyncProvider,
  passphrase: string,
  policy: KdfPolicy,
  opts: { resetPreReleaseKeyring?: boolean },
): Promise<{ header: VaultHeader; keys: VaultKeys }> {
  const obj = await provider.get(HEADER_NAME);
  if (!obj) throw new NoVaultError();
  const header = decodeHeader(obj.data, policy);
  // Plan W1.7: a vault with a keyring keeps its current keys there.
  const ring = await readKeyring(provider);
  let base: VaultKeys;
  try {
    base = await unlockHeader(header, passphrase);
  } catch (e) {
    // A passphrase change cut off before its header was written (review
    // 12.11): the keyring carries the new header; the new passphrase opens
    // it and finishes the write.
    if (!(e instanceof WrongPassphraseError) || !ring?.file.header) throw e;
    const bytes = fromB64u(ring.file.header);
    let pending: VaultHeader;
    let keys: VaultKeys;
    try {
      pending = decodeHeader(bytes, policy);
      if (pending.vaultId !== header.vaultId || ring.file.vaultId !== header.vaultId) throw e;
      const b = await unlockHeader(pending, passphrase);
      keys = await keysFromKeyring(ring.file, await unwrapSecret(ring.file, { wrap: b.wrap! }), b, { digest: ring.digest });
      if (keys.ring?.header !== (await sha256Hex(bytes))) throw e;
    } catch {
      throw e;
    }
    // Someone else wrote it, or offline: the next round (resumeEpoch) tries again.
    await provider.put(HEADER_NAME, bytes, { ifMatch: obj.etag }).catch(() => undefined);
    return { header: pending, keys };
  }
  if (!ring) return { header, keys: base };
  if (ring.file.vaultId !== base.vaultId) throw new DecryptError("The keyring belongs to another vault");
  let secret: Uint8Array;
  try {
    secret = await unwrapSecret(ring.file, { wrap: base.wrap! });
  } catch (e) {
    // The old passphrase while a passphrase change has not written its new
    // header yet: it keeps opening the vault at the epoch before (never the
    // new one), from the keyring the new one replaced, which it carries in
    // `prev` until the change is finished (RR-6) — then both go.
    if (!(e instanceof DecryptError) || !ring.file.header || equalBytes(fromB64u(ring.file.header), obj.data)) throw e;
    if (!ring.file.prev) {
      if (ring.file.epoch === 1) return { header, keys: base };
      throw e;
    }
    const prev = decodeKeyring(fromB64u(ring.file.prev));
    if (prev.vaultId !== base.vaultId || prev.epoch !== ring.file.epoch - 1) throw e;
    return { header, keys: await keysFromKeyring(prev, await unwrapSecret(prev, { wrap: base.wrap! }), base, { digest: await keyringDigest(prev) }) };
  }
  return { header, keys: await keysFromKeyring(ring.file, secret, base, { digest: ring.digest, allowPreRelease: !!opts.resetPreReleaseKeyring }) };
}

/**
 * Open the vault with this device's own key (an age identity enrolled in
 * the keyring), without the passphrase. `RevokedError` once it was revoked;
 * `TamperedWrapError` when its wrap doesn't open the keyring (N5).
 *
 * The provider knows the device's public key, so it can make a keyring this
 * key opens (third review 12.11, N1): pass the device's saved `state`, and
 * keys that don't hold the secret of the keyring it verified are refused
 * (`KeyringForkError`), before the device list is looked at (F7).
 * `E2eeSync` checks the same at every round. A device left out by a dropped
 * re-key gets `DroppedFromVaultError` (F4; here from the keyring's marker,
 * which only `E2eeSync` can authenticate).
 */
export async function unlockWithDevice(provider: SyncProvider, device: string, identity: string, state?: Pick<DeviceState, "ring"> | null): Promise<{ keys: VaultKeys }> {
  const ring = await readKeyring(provider);
  if (!ring) throw new NoVaultError();
  const secret = await unwrapSecret(ring.file, { device, identity });
  const placeholder = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
  let keys: VaultKeys;
  try {
    keys = await keysFromKeyring(ring.file, secret, { header: placeholder, wrap: null }, { digest: ring.digest });
  } catch (e) {
    if (e instanceof PreReleaseKeyringError) throw e;
    // The wrap opened, but its secret doesn't open the keyring: another epoch's wrap put back, or one the storage made (N5).
    throw new TamperedWrapError();
  }
  // Keys the storage made for this device's public key can't hold the secret
  // of the keyring it verified (N1) — checked first (fifth review, F7): a
  // forged keyring is a fork, whatever its device list says.
  if (state?.ring) await verifyAnchor(keys, state.ring);
  // Only a keyring sealed with the secret the wrap holds says who is enrolled: not on it is revoked.
  await checkDeviceEnrolled(ring.file, keys, device);
  return { keys };
}

