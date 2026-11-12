/**
 * The vault's keys and the sealed-object format (plan 3.4, steps 2 and 7).
 *
 * One passphrase-derived master key; every purpose gets its own sub-key by
 * HKDF-SHA256 (salt = the vault id, info = "lumen-e2ee/1/<purpose>"), so a
 * key is never used for two jobs:
 *
 *   header  — HMAC-SHA256 over the vault header (proves the passphrase is right
 *             and that nobody changed the KDF parameters)
 *   names   — HMAC-SHA256 that turns a path into an opaque object name
 *   manifest— AES-256-GCM for the manifest
 *   blobs   — AES-256-GCM for file contents
 *   pairing — HMAC-SHA256 over a pairing code (pairing.ts)
 *
 * All sub-keys are non-extractable CryptoKeys.
 *
 * Epochs (plan W1.7, ./keyring.ts): the manifest, blob and pairing keys come
 * from the vault's current *epoch secret*. Epoch 0 is the passphrase-derived
 * master itself (every vault before plan W1.7). A re-key starts epoch n + 1
 * with a fresh random secret, wrapped for the passphrase and for each
 * enrolled device in the keyring; the older secrets are sealed under the new
 * epoch, so blobs written earlier stay readable without being uploaded again.
 * The names key always comes from epoch 0 (blob names never change; each
 * epoch's manifest has its own random label in the keyring), and the header
 * and wrap keys from the current passphrase. Because a re-key
 * needs the current secret, it is kept as bytes in `secret`, in memory only.
 *
 * Sealed object = 1 byte format version ‖ 12 byte random nonce ‖ AES-GCM
 * ciphertext+tag. The additional data binds the object to its vault and its
 * name, so the provider cannot swap two objects or move one between vaults
 * without decryption failing. The plaintext is length-prefixed and padded
 * (`padLength`), so the provider learns a size bucket, not the exact size.
 */

import { bs, concat, fromUtf8, randomBytes, toB64u, utf8 } from "./bytes";

export const SEALED_FORMAT = 1;
const NONCE = 12;

export interface VaultKeys {
  vaultId: string;
  header: CryptoKey;
  names: CryptoKey;
  manifest: CryptoKey;
  blobs: CryptoKey;
  pairing: CryptoKey;
  /** The current epoch (0: no keyring yet). */
  epoch: number;
  /** The current epoch's secret (epoch 0: the master), for a re-key. */
  secret: Uint8Array;
  /** The keyring's own key for the current epoch (seals the older secrets). */
  keyring: CryptoKey;
  /** Wraps the epoch secret for the passphrase; null when the vault was opened with a device key. */
  wrap: CryptoKey | null;
  /** Blob keys of older epochs, for blobs written before a re-key. */
  olderBlobs: Map<number, CryptoKey>;
  /** Secrets of older epochs (re-sealed into the next keyring at a re-key). */
  olderSecrets: Map<number, Uint8Array>;
  /** What the keyring's sealed part says about this epoch (absent at epoch 0). */
  ring?: RingInfo;
}

/**
 * The authenticated facts of a keyring epoch that the engine acts on
 * (review 12.11). All of them come from the keyring's sealed part.
 */
export interface RingInfo {
  /** The label of this epoch's manifest object: "manifest/<epoch>/<random>" (RR-3). */
  manifest: string;
  /** The keyring's revision at this epoch (0 for a new epoch, + 1 per same-epoch rewrite). */
  rev: number;
  /** SHA-256 hex of the keyring's bytes: what the next keyring's chain names. */
  digest: string;
  /** The frozen manifest of the previous epoch this epoch's manifest was made from. */
  carry?: { label: string; epoch: number; digest: string };
  /** SHA-256 hex of the vault header this epoch's passphrase wrap belongs to, while a passphrase change is written. */
  header?: string;
  /** Digests of this epoch's frozen manifests whose re-key was called off: any device may write over them. */
  aborted: string[];
  /** A pre-release keyring (no sealed device list): opened only to reset it. */
  preRelease?: true;
  /** This keyring's descent from the one the device verified last could not be proven (too far behind). */
  unproven?: true;
}

/** The blob key for a manifest entry's epoch (absent: 0). Throws when this device doesn't hold it. */
export function blobKey(keys: VaultKeys, epoch: number | undefined): CryptoKey {
  const e = epoch ?? 0;
  if (e === keys.epoch) return keys.blobs;
  const k = keys.olderBlobs.get(e);
  if (!k) throw new DecryptError(`No key for epoch ${e}`);
  return k;
}

async function hkdfKey(
  base: CryptoKey,
  vaultId: string,
  purpose: string,
  alg: HmacKeyGenParams | AesKeyGenParams,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bs(utf8(vaultId)), info: bs(utf8(`lumen-e2ee/1/${purpose}`)) },
    base,
    alg,
    false,
    usages,
  );
}

const HMAC_KEY: HmacKeyGenParams = { name: "HMAC", hash: "SHA-256", length: 256 };
const AES_KEY: AesKeyGenParams = { name: "AES-GCM", length: 256 };

const ikm = (secret: Uint8Array) => crypto.subtle.importKey("raw", bs(secret), "HKDF", false, ["deriveKey"]);

/** The keys an epoch secret gives: manifest, blobs, pairing, keyring. */
export async function epochKeys(secret: Uint8Array, vaultId: string): Promise<{ manifest: CryptoKey; blobs: CryptoKey; pairing: CryptoKey; keyring: CryptoKey }> {
  const base = await ikm(secret);
  const [manifest, blobs, pairing, keyring] = await Promise.all([
    hkdfKey(base, vaultId, "manifest", AES_KEY, ["encrypt", "decrypt"]),
    hkdfKey(base, vaultId, "blobs", AES_KEY, ["encrypt", "decrypt"]),
    hkdfKey(base, vaultId, "pairing", HMAC_KEY, ["sign", "verify"]),
    hkdfKey(base, vaultId, "keyring", AES_KEY, ["encrypt", "decrypt"]),
  ]);
  return { manifest, blobs, pairing, keyring };
}

/** The names key: always from epoch 0's secret. */
export async function namesKey(secret0: Uint8Array, vaultId: string): Promise<CryptoKey> {
  return hkdfKey(await ikm(secret0), vaultId, "names", HMAC_KEY, ["sign"]);
}

/** The passphrase's own keys: the header MAC and the keyring wrap. */
export async function passphraseKeys(master: Uint8Array, vaultId: string): Promise<{ header: CryptoKey; wrap: CryptoKey }> {
  const base = await ikm(master);
  const [header, wrap] = await Promise.all([hkdfKey(base, vaultId, "header", HMAC_KEY, ["sign", "verify"]), hkdfKey(base, vaultId, "keyring-wrap", AES_KEY, ["encrypt", "decrypt"])]);
  return { header, wrap };
}

/** The keys of vault `vaultId` at epoch 0 (no keyring): everything from the passphrase-derived master. */
export async function deriveVaultKeys(master: Uint8Array, vaultId: string): Promise<VaultKeys> {
  const secret = master.slice();
  const [p, e, names] = await Promise.all([passphraseKeys(secret, vaultId), epochKeys(secret, vaultId), namesKey(secret, vaultId)]);
  master.fill(0);
  return { vaultId, header: p.header, wrap: p.wrap, names, ...e, epoch: 0, secret, olderBlobs: new Map(), olderSecrets: new Map() };
}

export async function hmac(key: CryptoKey, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, bs(data)));
}

/** Constant-time check (WebCrypto's verify) of an HMAC tag. */
export async function verifyHmac(key: CryptoKey, tag: Uint8Array, data: Uint8Array): Promise<boolean> {
  return crypto.subtle.verify("HMAC", key, bs(tag), bs(data));
}

/**
 * Opaque object name for `label` (a path plus a revision id, or a fixed role
 * such as "manifest"): base64url of HMAC-SHA256 under the names key — 43
 * characters, the same length for every object.
 */
export async function opaqueName(keys: VaultKeys, label: string): Promise<string> {
  return toB64u(await hmac(keys.names, utf8(label)));
}

/**
 * The padded plaintext length for `n` bytes of data plus the 4-byte length
 * prefix: a multiple of 256 bytes, and above 4 KiB a multiple of 1/16 of the
 * next power of two (≤ 6.25 % overhead), so sizes fall into coarse buckets.
 */
export function padLength(n: number): number {
  const raw = n + 4;
  let step = 256;
  if (raw > 4096) step = Math.max(256, 2 ** Math.ceil(Math.log2(raw)) / 16);
  return Math.ceil(raw / step) * step;
}

export class DecryptError extends Error {
  constructor(message = "The data could not be decrypted: wrong passphrase, or it was changed") {
    super(message);
    this.name = "DecryptError";
  }
}

function aad(vaultId: string, kind: string, name: string): Uint8Array {
  return utf8(`lumen-e2ee/${SEALED_FORMAT}/${kind}/${vaultId}/${name}`);
}

/** Encrypt `data` as object `name` of kind `kind` ("manifest" | "blob"). */
export async function seal(
  key: CryptoKey,
  vaultId: string,
  kind: string,
  name: string,
  data: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const padded = new Uint8Array(padLength(data.length));
  new DataView(padded.buffer).setUint32(0, data.length);
  padded.set(data, 4);
  const nonce = randomBytes(NONCE);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bs(nonce), additionalData: bs(aad(vaultId, kind, name)) },
    key,
    bs(padded),
  );
  return concat(new Uint8Array([SEALED_FORMAT]), nonce, new Uint8Array(ct));
}

/** Inverse of `seal`; `DecryptError` when the key, the name or a single byte is wrong. */
export async function unseal(
  key: CryptoKey,
  vaultId: string,
  kind: string,
  name: string,
  sealed: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (sealed.length < 1 + NONCE + 16 || sealed[0] !== SEALED_FORMAT) throw new DecryptError("Unknown sealed-object format");
  let pt: Uint8Array<ArrayBuffer>;
  try {
    pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bs(sealed.subarray(1, 1 + NONCE)), additionalData: bs(aad(vaultId, kind, name)) },
        key,
        bs(sealed.subarray(1 + NONCE)),
      ),
    );
  } catch {
    throw new DecryptError();
  }
  const len = new DataView(pt.buffer, pt.byteOffset, pt.byteLength).getUint32(0);
  if (len > pt.length - 4) throw new DecryptError("Corrupt padding");
  return pt.slice(4, 4 + len);
}

/** Decrypt and decode a JSON object sealed with `sealJson`. */
export async function unsealJson(key: CryptoKey, vaultId: string, kind: string, name: string, sealed: Uint8Array): Promise<{ value: unknown; bytes: Uint8Array<ArrayBuffer> }> {
  const bytes = await unseal(key, vaultId, kind, name, sealed);
  let value: unknown;
  try {
    value = JSON.parse(fromUtf8(bytes));
  } catch {
    throw new DecryptError("Corrupt JSON");
  }
  return { value, bytes };
}
