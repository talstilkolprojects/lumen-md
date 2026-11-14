/**
 * Vault encryption at rest (plan 11.4) — keys, the header and the file format.
 *
 * Keys. Turning encryption on makes a recovery key (30 characters, 150
 * random bits) and shows it once. The vault's data key and its id are
 * derived from it (HKDF-SHA256), so the recovery key alone opens the vault —
 * even if both header files were lost. Day to day the vault opens with a
 * passphrase: the header holds the data key wrapped (AES-256-GCM) under a
 * key derived from the passphrase with the E2EE sync's KDF (plan 3.4,
 * ../../../sync/e2ee/kdf.ts). Since plan W4.20 that is Argon2id (RFC 9106,
 * our own TypeScript from W1.7, checked against the RFC vectors), with the
 * most memory this device opens within a second (../../../sync/e2ee/
 * kdfCalibrate.ts). Vaults made before it, with PBKDF2-SHA256 (≥ 600,000
 * iterations), still open and stay on PBKDF2 until the user moves them
 * (`rewrapPassphrase` with `kdf: "argon2id"`, review 12.11): an older Lumen
 * that opens the same folder can't read an Argon2id header, so the move is
 * never made behind the user's back. Only the header is rewritten.
 * A new passphrase re-wraps the data key; no file is re-encrypted.
 *
 * From the data key, HKDF-SHA256 (salt = vault id) makes one key per job:
 * "files" (AES-GCM, file contents), "store" (AES-GCM, what Lumen keeps in
 * IndexedDB: agent traces, the semantic index, history), "header" (HMAC
 * over the header, so nobody can lower the KDF cost or flip the conversion
 * direction unnoticed), and since W6.36 "snapshot-enc" (AES-GCM) and
 * "snapshot-mac" (HMAC), which seal and sign the vault index snapshot in
 * the index worker (../../snapshotSeal.ts).
 *
 * Header. `.lumen-encryption.json` at the vault root, plain JSON (a device
 * needs it before it has a key), written twice (the second copy is
 * `.lumen-encryption.backup.json`): a header write that is cut off leaves
 * the other copy, and every copy opens the same data key.
 *
 * Files. `00 4C 4D 45 01` ("\0LME" + format 1) ‖ 12-byte random nonce ‖
 * AES-GCM ciphertext and tag; the additional data is the vault id. The first
 * byte is NUL, which no Markdown or text file starts with, so a file without
 * the prefix is plaintext — that is how a conversion that was cut off is
 * resumed: every file is either complete ciphertext or complete plaintext.
 * File and folder names, sizes and times are not encrypted (see the docs).
 */

import { bs, concat, fromB64u, fromUtf8, randomBytes, toB64u, utf8 } from "../../../sync/e2ee/bytes";
import { ENCRYPTED_PREFIX } from "./paths";
import type { SnapshotKeys } from "../../snapshotSeal";
import { deriveMasterKey, newKdfParams, validateKdfParams, type Argon2idParams, type KdfParams, type KdfPolicy } from "../../../sync/e2ee/kdf";

/** The shortest passphrase the vault accepts (characters), for the setup and unlock dialogs. */
export const MIN_PASSPHRASE_LENGTH = 12;

export const MAGIC = new Uint8Array(ENCRYPTED_PREFIX);
const NONCE = 12;
const TAG = 16;
/** Bytes an encrypted file has on top of its content. */
export const FILE_OVERHEAD = MAGIC.length + NONCE + TAG;
const FORMAT = "lumen-rest";
const VERSION = 1;

/** Where the conversion is going: "encrypted" while encrypting or encrypted, "plain" while turning it off. */
export type RestTarget = "encrypted" | "plain";

export interface RestHeader {
  format: typeof FORMAT;
  version: number;
  vaultId: string;
  target: RestTarget;
  /** The passphrase's KDF and the data key wrapped under it. (The recovery key needs nothing stored.) */
  passphrase: { kdf: KdfParams; wrapped: string };
  /** base64url HMAC-SHA256 under the header key over every other field. */
  mac: string;
}

export interface RestKeys {
  vaultId: string;
  files: CryptoKey;
  store: CryptoKey;
  header: CryptoKey;
  /** W6.36: the index snapshot's own subkeys, handed to the index worker (../../snapshotSeal.ts). */
  snapshot: SnapshotKeys;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super("Wrong passphrase or recovery key");
    this.name = "WrongPassphraseError";
  }
}

export class HeaderTamperedError extends Error {
  constructor() {
    super("The encryption header was changed outside Lumen");
    this.name = "HeaderTamperedError";
  }
}

export class NotDecryptableError extends Error {
  constructor(readonly path: string) {
    super(`"${path}" could not be decrypted: it was changed, or it belongs to another vault`);
    this.name = "NotDecryptableError";
  }
}

// ── Recovery key ─────────────────────────────────────────────────────────

/** Crockford base32: no I, L, O, U, so it can be read aloud and typed back. */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_LENGTH = 30;

/** A fresh recovery key: 30 random base32 characters (150 bits), in six groups of five. */
export function newRecoveryKey(): string {
  // 256 is a multiple of 32, so `& 31` keeps every character equally likely.
  const out = [...randomBytes(RECOVERY_LENGTH)].map((b) => B32[b & 31]).join("");
  return out.match(/.{1,5}/g)!.join("-");
}

/** What the user typed, made comparable: case, spaces, dashes and look-alikes (O→0, I/L→1) do not matter. */
export function normalizeRecoveryKey(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

/** The data key and the vault id that a recovery key stands for. */
async function fromRecoveryKey(recoveryKey: string): Promise<{ dataKey: Uint8Array<ArrayBuffer>; vaultId: string }> {
  const k = normalizeRecoveryKey(recoveryKey);
  if (k.length !== RECOVERY_LENGTH || [...k].some((c) => !B32.includes(c))) throw new WrongPassphraseError();
  const ikm = await crypto.subtle.importKey("raw", bs(utf8(k)), "HKDF", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: bs(utf8(`${FORMAT}/${VERSION}`)), info: bs(utf8("data-key")) }, ikm, 384),
  );
  return { dataKey: bits.slice(0, 32), vaultId: toB64u(bits.subarray(32)) };
}

// ── Keys ─────────────────────────────────────────────────────────────────

async function kek(secret: string, kdf: KdfParams): Promise<CryptoKey> {
  const raw = await deriveMasterKey(secret, kdf);
  const key = await crypto.subtle.importKey("raw", bs(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
  raw.fill(0);
  return key;
}

const wrapAad = (vaultId: string, slot: string) => utf8(`${FORMAT}/${VERSION}/wrap/${slot}/${vaultId}`);

async function wrap(key: CryptoKey, dataKey: Uint8Array, vaultId: string, slot: string): Promise<string> {
  const nonce = randomBytes(NONCE);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(nonce), additionalData: bs(wrapAad(vaultId, slot)) }, key, bs(dataKey));
  return toB64u(concat(nonce, new Uint8Array(ct)));
}

async function unwrap(key: CryptoKey, wrapped: string, vaultId: string, slot: string): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const b = fromB64u(wrapped);
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(b.subarray(0, NONCE)), additionalData: bs(wrapAad(vaultId, slot)) }, key, bs(b.subarray(NONCE))),
    );
  } catch {
    throw new WrongPassphraseError();
  }
}

/** The per-job keys from the data key. Wipes `dataKey`. */
export async function deriveRestKeys(dataKey: Uint8Array, vaultId: string): Promise<RestKeys> {
  const base = await crypto.subtle.importKey("raw", bs(dataKey), "HKDF", false, ["deriveKey"]);
  dataKey.fill(0);
  const sub = (purpose: string, alg: HmacKeyGenParams | AesKeyGenParams, usages: KeyUsage[]) =>
    crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: bs(utf8(vaultId)), info: bs(utf8(`${FORMAT}/${VERSION}/${purpose}`)) }, base, alg, false, usages);
  const aes: AesKeyGenParams = { name: "AES-GCM", length: 256 };
  const hmac: HmacKeyGenParams = { name: "HMAC", hash: "SHA-256", length: 256 };
  const [files, store, header, snapEnc, snapMac] = await Promise.all([
    sub("files", aes, ["encrypt", "decrypt"]),
    sub("store", aes, ["encrypt", "decrypt"]),
    sub("header", hmac, ["sign", "verify"]),
    // W6.36: the index snapshot, sealed in the worker. Not extractable, like the others.
    sub("snapshot-enc", aes, ["encrypt", "decrypt"]),
    sub("snapshot-mac", hmac, ["sign", "verify"]),
  ]);
  return { vaultId, files, store, header, snapshot: { vaultId, enc: snapEnc, mac: snapMac } };
}

// ── Header ───────────────────────────────────────────────────────────────

type HeaderBody = Omit<RestHeader, "mac">;

const bodyOf = (h: RestHeader): HeaderBody => ({ format: h.format, version: h.version, vaultId: h.vaultId, target: h.target, passphrase: h.passphrase });

function macInput(h: HeaderBody): Uint8Array {
  return utf8(JSON.stringify([h.format, h.version, h.vaultId, h.target, h.passphrase.kdf, h.passphrase.wrapped]));
}

async function sign(keys: RestKeys, body: HeaderBody): Promise<RestHeader> {
  const mac = toB64u(new Uint8Array(await crypto.subtle.sign("HMAC", keys.header, bs(macInput(body)))));
  return { ...body, mac };
}

export interface CreateOptions {
  /** Tests only: PBKDF2 instead of Argon2id, with cheap iterations. */
  pbkdf2Iterations?: number;
  /** The Argon2id cost (the device's calibration; tests pass a cheap one). Default: ARGON2_DEFAULT. */
  argon2?: Omit<Argon2idParams, "alg" | "salt">;
}

async function headerFor(dataKey: Uint8Array, vaultId: string, passphrase: string, target: RestTarget, opts: CreateOptions): Promise<{ header: RestHeader; keys: RestKeys }> {
  const kdf = newKdfParams(opts.pbkdf2Iterations, opts.argon2);
  const body: HeaderBody = { format: FORMAT, version: VERSION, vaultId, target, passphrase: { kdf, wrapped: await wrap(await kek(passphrase, kdf), dataKey, vaultId, "passphrase") } };
  const keys = await deriveRestKeys(dataKey, vaultId);
  return { header: await sign(keys, body), keys };
}

/** A new encrypted vault: its recovery key and the signed header. */
export async function createRestHeader(passphrase: string, opts: CreateOptions = {}): Promise<{ header: RestHeader; keys: RestKeys; recoveryKey: string }> {
  const recoveryKey = newRecoveryKey();
  const { dataKey, vaultId } = await fromRecoveryKey(recoveryKey);
  return { ...(await headerFor(dataKey, vaultId, passphrase, "encrypted", opts)), recoveryKey };
}

/**
 * A header made from the recovery key alone, with a new passphrase: after a
 * forgotten passphrase, or when both header files were lost or damaged.
 * `target` is what the old header said, when it is known.
 */
export async function headerFromRecoveryKey(recoveryKey: string, newPassphrase: string, target: RestTarget = "encrypted", opts: CreateOptions = {}): Promise<{ header: RestHeader; keys: RestKeys }> {
  const { dataKey, vaultId } = await fromRecoveryKey(recoveryKey);
  return headerFor(dataKey, vaultId, newPassphrase, target, opts);
}

export function encodeRestHeader(h: RestHeader): Uint8Array<ArrayBuffer> {
  return utf8(JSON.stringify(h, null, 2) + "\n");
}

/** Parse a stored header. Throws on anything malformed, or a KDF that is unknown, unavailable or too weak. */
export function decodeRestHeader(bytes: Uint8Array, policy: KdfPolicy = {}): RestHeader {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(fromUtf8(bytes)) as Record<string, unknown>;
  } catch {
    throw new Error("The encryption header is not valid JSON");
  }
  if (o.format !== FORMAT) throw new Error("Not a Lumen encryption header");
  if (o.version !== VERSION) throw new Error(`Unsupported encryption header version ${String(o.version)}`);
  if (typeof o.vaultId !== "string" || typeof o.mac !== "string") throw new Error("Incomplete encryption header");
  if (o.target !== "encrypted" && o.target !== "plain") throw new Error("Incomplete encryption header");
  const slot = o.passphrase as { kdf?: unknown; wrapped?: unknown } | null;
  if (!slot || typeof slot.wrapped !== "string") throw new Error("Incomplete encryption header");
  return { format: FORMAT, version: VERSION, vaultId: o.vaultId, target: o.target, passphrase: { kdf: validateKdfParams(slot.kdf, policy), wrapped: slot.wrapped }, mac: o.mac };
}

/** The data key, from the passphrase or (with `recovery`) the recovery key. */
async function dataKeyOf(header: RestHeader, secret: string, recovery: boolean): Promise<Uint8Array<ArrayBuffer>> {
  if (!recovery) return unwrap(await kek(secret, header.passphrase.kdf), header.passphrase.wrapped, header.vaultId, "passphrase");
  const r = await fromRecoveryKey(secret);
  if (r.vaultId !== header.vaultId) throw new WrongPassphraseError();
  return r.dataKey;
}

/** Open the header with the passphrase, or with the recovery key when `recovery` is set. Checks the MAC. */
export async function unlockRestHeader(header: RestHeader, secret: string, opts: { recovery?: boolean } = {}): Promise<RestKeys> {
  const keys = await deriveRestKeys(await dataKeyOf(header, secret, !!opts.recovery), header.vaultId);
  let tag: Uint8Array;
  try {
    tag = fromB64u(header.mac);
  } catch {
    throw new HeaderTamperedError();
  }
  if (!(await crypto.subtle.verify("HMAC", keys.header, bs(tag), bs(macInput(bodyOf(header)))))) throw new HeaderTamperedError();
  return keys;
}

/** The header with a new passphrase (a change, or after a recovery); `secret` is the current passphrase or the recovery key. */
export async function rewrapPassphrase(
  header: RestHeader,
  secret: string,
  opts: { recovery?: boolean; newPassphrase: string; kdf?: "argon2id" } & CreateOptions,
): Promise<{ header: RestHeader; keys: RestKeys }> {
  // Check the header is genuine before writing a new one from it.
  await unlockRestHeader(header, secret, { recovery: opts.recovery });
  const dataKey = await dataKeyOf(header, secret, !!opts.recovery);
  // The vault keeps its KDF family (review 12.11): a PBKDF2 vault moves to
  // Argon2id only when asked (`kdf: "argon2id"`), since older builds can't
  // open an Argon2id header. Argon2id vaults get this device's cost.
  const cur = header.passphrase.kdf;
  const iterations = opts.pbkdf2Iterations ?? (opts.kdf !== "argon2id" && cur.alg === "pbkdf2-sha256" ? cur.iterations : undefined);
  return headerFor(dataKey, header.vaultId, opts.newPassphrase, header.target, { pbkdf2Iterations: iterations, argon2: opts.argon2 });
}

/** The header pointing the other way (turning encryption off, or back on). */
export async function retarget(header: RestHeader, keys: RestKeys, target: RestTarget): Promise<RestHeader> {
  return sign(keys, { ...bodyOf(header), target });
}

// ── Files and stored values ──────────────────────────────────────────────

const fileAad = (vaultId: string) => utf8(`${FORMAT}/${VERSION}/file/${vaultId}`);
const storeAad = (vaultId: string, label: string) => utf8(`${FORMAT}/${VERSION}/store/${vaultId}/${label}`);

/** True when `bytes` starts with the encrypted-file prefix. */
export function isEncryptedFile(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}

export async function encryptFile(keys: RestKeys, plain: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = randomBytes(NONCE);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(nonce), additionalData: bs(fileAad(keys.vaultId)) }, keys.files, bs(plain));
  return concat(MAGIC, nonce, new Uint8Array(ct));
}

/** The content of an encrypted file; `NotDecryptableError` when it was changed or is from another vault. */
export async function decryptFile(keys: RestKeys, sealed: Uint8Array, path = ""): Promise<Uint8Array<ArrayBuffer>> {
  if (!isEncryptedFile(sealed) || sealed.length < FILE_OVERHEAD) throw new NotDecryptableError(path);
  const iv = sealed.subarray(MAGIC.length, MAGIC.length + NONCE);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(iv), additionalData: bs(fileAad(keys.vaultId)) }, keys.files, bs(sealed.subarray(MAGIC.length + NONCE))));
  } catch {
    throw new NotDecryptableError(path);
  }
}

/** What an IndexedDB store keeps instead of a value while the vault is encrypted. */
export interface SealedValue {
  lumenSealed: 1;
  vault: string;
  data: string;
}

export function isSealedValue(v: unknown): v is SealedValue {
  return !!v && typeof v === "object" && (v as { lumenSealed?: unknown }).lumenSealed === 1 && typeof (v as { data?: unknown }).data === "string";
}

/** `value` (JSON) encrypted for an IndexedDB store; `label` names the store, so values can't be swapped between stores. */
export async function sealValue(keys: RestKeys, label: string, value: unknown): Promise<SealedValue> {
  const nonce = randomBytes(NONCE);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(nonce), additionalData: bs(storeAad(keys.vaultId, label)) }, keys.store, bs(utf8(JSON.stringify(value))));
  return { lumenSealed: 1, vault: keys.vaultId, data: toB64u(concat(nonce, new Uint8Array(ct))) };
}

export async function openValue(keys: RestKeys, label: string, sealed: SealedValue): Promise<unknown> {
  const b = fromB64u(sealed.data);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(b.subarray(0, NONCE)), additionalData: bs(storeAad(keys.vaultId, label)) }, keys.store, bs(b.subarray(NONCE)));
  return JSON.parse(fromUtf8(new Uint8Array(pt)));
}
