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
 * All sub-keys are non-extractable CryptoKeys; the master key bytes are wiped
 * once they are imported.
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

/** The five sub-keys of vault `vaultId`. Wipes `master`. */
export async function deriveVaultKeys(master: Uint8Array, vaultId: string): Promise<VaultKeys> {
  const base = await crypto.subtle.importKey("raw", bs(master), "HKDF", false, ["deriveKey"]);
  master.fill(0);
  const hmac: HmacKeyGenParams = { name: "HMAC", hash: "SHA-256", length: 256 };
  const aes: AesKeyGenParams = { name: "AES-GCM", length: 256 };
  const [header, names, manifest, blobs, pairing] = await Promise.all([
    hkdfKey(base, vaultId, "header", hmac, ["sign", "verify"]),
    hkdfKey(base, vaultId, "names", hmac, ["sign"]),
    hkdfKey(base, vaultId, "manifest", aes, ["encrypt", "decrypt"]),
    hkdfKey(base, vaultId, "blobs", aes, ["encrypt", "decrypt"]),
    hkdfKey(base, vaultId, "pairing", hmac, ["sign", "verify"]),
  ]);
  return { vaultId, header, names, manifest, blobs, pairing };
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
