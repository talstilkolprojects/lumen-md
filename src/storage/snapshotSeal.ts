/**
 * W6.36 — the vault index snapshot (./indexSnapshot.ts) sealed for an
 * encrypted vault (plan 11.4), inside the index worker.
 *
 * Until now an encrypted vault had no snapshot at all (#420): the worker
 * writes the snapshot, and it had no key to seal it with, so every open of
 * an encrypted vault read and decrypted every note again.
 *
 * Keys. The worker never sees the vault's data key. When the vault is
 * unlocked, ./vault/encrypted/format.ts `deriveRestKeys` derives two more
 * HKDF-SHA256 subkeys from the data key, beside "files", "store" and
 * "header" (same salt = the vault id, own `info`):
 *   • "snapshot-enc": AES-256-GCM, encrypts the snapshot;
 *   • "snapshot-mac": HMAC-SHA256, signs it.
 * Both are WebCrypto keys made with `extractable: false`, so their bytes
 * can't be read back, not on the main thread and not in the worker. They
 * reach the worker by structured clone with each snapshot request; the
 * worker keeps no copy between requests. Locking the vault drops them
 * (`setRestSealer(null)`), so a locked vault writes and reads no snapshot.
 * A leaked snapshot subkey opens snapshots only: HKDF subkeys are
 * independent, so it says nothing about the files, store or header keys.
 *
 * Record. What IndexedDB holds for an encrypted vault (SEAL_VERSION 2):
 *   { sealed: 1, sv, vaultId, vault, sid, manifest: part, body: part },
 *   part = { nonce, ct, mac }
 * Two sealed parts, so the open can answer from the small one (W6.36,
 * round 2): the manifest holds every note's path, name, mtime and summary;
 * the body holds the notes' text. `sv` is SEAL_VERSION, `vaultId` the
 * encryption vault id, `vault` the workspace id, `sid` 16 random bytes (hex)
 * fresh for every seal. They are in the clear so a wrong record is turned
 * away before any cryptography, and they are bound into each part:
 *   • AAD (AES-GCM additional data) = UTF-8 of
 *     JSON ["lumen-rest/1/snapshot", sv, vaultId, vault, part, sid], with
 *     part "manifest" or "body" — a JSON array, so no two different tuples
 *     give the same bytes. The part name keeps the two from being swapped;
 *     the sid keeps a manifest of one seal from being paired with the body
 *     of another;
 *   • ct = AES-GCM(enc, nonce, AAD, plaintext), nonce 12 random bytes,
 *     fresh for every part of every seal;
 *   • mac = HMAC-SHA256(mac key, u32be(len AAD) ‖ AAD ‖ nonce ‖ ct).
 * Opening a part checks, in order: the record's shape; `sv`, `vaultId` and
 * `vault` equal to what the caller expects; the part's HMAC
 * (`crypto.subtle.verify`, constant time) over the AAD rebuilt from what the
 * caller expects plus the record's sid; then AES-GCM decryption with the
 * same AAD. Any failure refuses the whole snapshot (`SnapshotRefusedError`);
 * the caller drops it and builds in full. A body refused after its manifest
 * was taken means every note the manifest named is read from the vault.
 *
 * Why both GCM and an HMAC: the GCM tag already authenticates. The HMAC is
 * the snapshot's signature under a key that does nothing else, checked
 * before anything is decrypted; it costs one pass over the ciphertext.
 *
 * Nonces: random 96-bit nonces under one key are safe for far more than
 * 2^32 encryptions (NIST SP 800-38D §8.3); a vault writes one snapshot (two
 * encryptions) a few seconds after a change, many orders of magnitude below.
 *
 * Not protected: rolling back to an older snapshot of the same vault. That
 * is harmless here: a snapshot is a cache. The open shows the snapshot's
 * notes at once and checks every path and mtime against the vault's listing
 * behind it; queries wait for that check, and a note whose mtime differs is
 * read again, so an older snapshot just means more notes are read. The
 * record size reveals roughly how much text the vault holds; file names and
 * sizes are not secret in an encrypted vault either (see the 11.4 docs).
 *
 * Imports nothing of the vault: this module runs in the index worker.
 */

/** The snapshot's own subkeys (never the data key). */
export interface SnapshotKeys {
  /** The encryption vault id (the header's `vaultId`). */
  vaultId: string;
  /** AES-256-GCM, `extractable: false`. */
  enc: CryptoKey;
  /** HMAC-SHA256, `extractable: false`. */
  mac: CryptoKey;
}

/** Bump on any change to the record or the AAD/MAC layout. 2: two parts, a manifest and a body (W6.36). */
export const SEAL_VERSION = 2;
const AAD_LABEL = "lumen-rest/1/snapshot";
const NONCE = 12;
const SID = 16;

export type SnapshotPart = "manifest" | "body";

export interface SealedPart {
  nonce: Uint8Array;
  ct: Uint8Array;
  mac: Uint8Array;
}

export interface SealedSnapshot {
  sealed: 1;
  sv: number;
  vaultId: string;
  vault: string;
  /** 16 random bytes, hex: binds the two parts of one seal. */
  sid: string;
  manifest: SealedPart;
  body: SealedPart;
}

export type RefusedReason = "shape" | "version" | "vault" | "signature" | "decrypt";

export class SnapshotRefusedError extends Error {
  constructor(readonly reason: RefusedReason) {
    super(`The vault index snapshot was refused (${reason})`);
    this.name = "SnapshotRefusedError";
  }
}

const enc = new TextEncoder();
const bs = (u: Uint8Array): BufferSource => u as BufferSource;
const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");

/** The additional data one part of a snapshot is sealed with. */
export function snapshotAad(sv: number, vaultId: string, vault: string, part: SnapshotPart, sid: string): Uint8Array {
  return enc.encode(JSON.stringify([AAD_LABEL, sv, vaultId, vault, part, sid]));
}

/** What the HMAC covers: the AAD (length-prefixed), the nonce and the ciphertext. */
function macInput(aad: Uint8Array, nonce: Uint8Array, ct: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + aad.length + nonce.length + ct.length);
  new DataView(out.buffer).setUint32(0, aad.length);
  out.set(aad, 4);
  out.set(nonce, 4 + aad.length);
  out.set(ct, 4 + aad.length + nonce.length);
  return out;
}

const isPart = (v: unknown): v is SealedPart => {
  const p = v as Partial<SealedPart> | null;
  return !!p && typeof p === "object" && p.nonce instanceof Uint8Array && p.nonce.length === NONCE && p.ct instanceof Uint8Array && p.mac instanceof Uint8Array;
};

export function isSealedSnapshot(v: unknown): v is SealedSnapshot {
  if (!v || typeof v !== "object") return false;
  const o = v as Partial<SealedSnapshot>;
  return (
    o.sealed === 1 &&
    typeof o.sv === "number" &&
    typeof o.vaultId === "string" &&
    typeof o.vault === "string" &&
    typeof o.sid === "string" &&
    /^[0-9a-f]{32}$/.test(o.sid) &&
    isPart(o.manifest) &&
    isPart(o.body)
  );
}

async function sealPart(keys: SnapshotKeys, aad: Uint8Array, plain: Uint8Array): Promise<SealedPart> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(nonce), additionalData: bs(aad) }, keys.enc, bs(plain)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", keys.mac, bs(macInput(aad, nonce, ct))));
  return { nonce, ct, mac };
}

/** Seal the encoded manifest and body of a snapshot for workspace `vault`. */
export async function sealSnapshot(keys: SnapshotKeys, vault: string, manifest: Uint8Array, body: Uint8Array): Promise<SealedSnapshot> {
  const sid = hex(crypto.getRandomValues(new Uint8Array(SID)));
  const aad = (part: SnapshotPart) => snapshotAad(SEAL_VERSION, keys.vaultId, vault, part, sid);
  return {
    sealed: 1,
    sv: SEAL_VERSION,
    vaultId: keys.vaultId,
    vault,
    sid,
    manifest: await sealPart(keys, aad("manifest"), manifest),
    body: await sealPart(keys, aad("body"), body),
  };
}

/** The plaintext of one part of a sealed snapshot; throws `SnapshotRefusedError` for anything not sealed by these keys for `vault`. */
export async function openSnapshot(keys: SnapshotKeys, vault: string, rec: unknown, part: SnapshotPart): Promise<Uint8Array> {
  if (!isSealedSnapshot(rec)) throw new SnapshotRefusedError("shape");
  if (rec.sv !== SEAL_VERSION) throw new SnapshotRefusedError("version");
  if (rec.vaultId !== keys.vaultId || rec.vault !== vault) throw new SnapshotRefusedError("vault");
  // The AAD is rebuilt from what the caller expects (and the part asked for), not read from the record;
  // the sid comes from the record, and the MAC covers it.
  const aad = snapshotAad(SEAL_VERSION, keys.vaultId, vault, part, rec.sid);
  const p = rec[part];
  if (!(await crypto.subtle.verify("HMAC", keys.mac, bs(p.mac), bs(macInput(aad, p.nonce, p.ct))))) throw new SnapshotRefusedError("signature");
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(p.nonce), additionalData: bs(aad) }, keys.enc, bs(p.ct)));
  } catch {
    throw new SnapshotRefusedError("decrypt");
  }
}
