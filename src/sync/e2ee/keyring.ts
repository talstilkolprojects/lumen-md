/**
 * The keyring (plan W1.7): key rotation and device revocation.
 *
 * Without a keyring (every vault before plan W1.7) all keys come from the
 * passphrase: anyone who ever knew it, or kept the derived keys, can read the
 * vault for good. The keyring adds an *epoch secret*, 32 random bytes,
 * from which the manifest, blob and pairing keys of that epoch derive
 * (keys.ts `epochKeys`). It is stored at the provider under the fixed name
 * `lumen-e2ee-keyring`:
 *
 *   {
 *     format: "lumen-e2ee-keyring", protocol: 1, vaultId, epoch,
 *     passphrase: {n, c},          // AES-GCM(wrap key from the passphrase, secret)
 *     devices: { <id>: { recipient: "age1…", wrap: "<base64 age file of the secret>" } },
 *     sealed: {n, c},              // AES-GCM(epoch's keyring key, JSON KeyringContents)
 *     header?: "<b64u>"            // a passphrase change: the new vault header, until it is written
 *   }
 *
 * Every AES-GCM has the vault id, the epoch and its role as additional data,
 * so a wrap can't be moved to another epoch, vault or device. `older` holds the
 * secrets of all earlier epochs, so blobs written before a re-key stay
 * readable: a re-key re-seals the manifest and nothing else, with no blob
 * downloaded or uploaded again.
 *
 * Who is enrolled (review 12.11): the plaintext `devices` map only lets a
 * device find its own wrap. The list a re-key wraps the next secret for is
 * the one in `sealed` (`devices`: id → recipient), which only holders of the
 * epoch's secret can write, minus every device in the sealed `revoked` list.
 * A provider that adds a recipient to the plaintext map, or puts a revoked
 * device back, gets nothing. Keyrings written before that have no sealed
 * list: the first device that opens one with the current keys seals the
 * plaintext list it finds (minus the revoked, and minus entries that are not
 * an age file to an X25519 recipient) — trust on first use, once.
 *
 * Re-key (`prepareEpoch`, committed by `E2eeSync.rekey`): a new epoch, wrapped
 * for the passphrase (the same, or a new one) and for every enrolled device
 * except those revoked. A device that was revoked can't unwrap the new
 * secret, so it can't read a manifest written after its revocation. If the
 * revoked device's user also knows the passphrase, change the passphrase in
 * the same re-key.
 *
 * Rollback: a device remembers the highest epoch it has seen and refuses a
 * keyring with a lower one (the provider can't hand back an old keyring that
 * still wraps the secret for a revoked device).
 */

import { bs, fromB64u, fromUtf8, randomBytes, sha256Hex, toB64u, utf8 } from "./bytes";
import { ageDecrypt, ageEncrypt, parseRecipient } from "./age";
import { blobKey, DecryptError, epochKeys, namesKey, passphraseKeys, type RingInfo, type VaultKeys } from "./keys";
import { isManifestLabel } from "./manifest";
import { PreconditionFailedError, type StoredObject, type SyncProvider } from "./provider";

export const KEYRING_NAME = "lumen-e2ee-keyring";
/**
 * During a passphrase change, the keyring of the epoch before, kept until
 * the new header is written: the old passphrase still opens the vault (at
 * that epoch, never the new one) if the header write is cut off.
 */
export const KEYRING_PREV_NAME = "lumen-e2ee-keyring.prev";
const FORMAT = "lumen-e2ee-keyring";
const PROTOCOL = 1;

interface Sealed {
  n: string;
  c: string;
}

export interface DeviceWrap {
  /** The device's age X25519 recipient (its public key). */
  recipient: string;
  /** The epoch secret, as an age file to that recipient (base64url). */
  wrap: string;
}

export interface KeyringFile {
  format: typeof FORMAT;
  protocol: number;
  vaultId: string;
  epoch: number;
  passphrase: Sealed;
  devices: Record<string, DeviceWrap>;
  sealed: Sealed;
  /** A passphrase change in progress: the new header (base64url), bound by `KeyringContents.header`. */
  header?: string;
}

export interface KeyringContents {
  /** Secrets of the earlier epochs, base64url, by epoch. */
  older: Record<string, string>;
  /** Devices revoked so far, with the epoch that shut them out (and their recipient, since review 12.11). */
  revoked: Array<{ device: string; epoch: number; at: number; recipient?: string }>;
  /** The enrolled devices, id → age recipient: the only list a re-key wraps for. Absent before review 12.11. */
  devices?: Record<string, string>;
  /** This epoch's manifest label (`RingInfo.manifest`); absent: "manifest". */
  manifest?: string;
  /** The previous epoch's frozen manifest this epoch's was re-sealed from. */
  carry?: { label: string; epoch: number; digest: string };
  /** SHA-256 hex of the header the passphrase wrap belongs to, after a passphrase change. */
  header?: string;
}

export class RevokedDeviceEnrollError extends Error {
  constructor(public readonly device: string) {
    super(`The device "${device}" (or its key) was removed from the vault; enroll it again with a new id and a new key`);
    this.name = "RevokedDeviceEnrollError";
  }
}

export class RevokedError extends Error {
  constructor() {
    super("This device was removed from the vault: it can't open the current keys");
    this.name = "RevokedError";
  }
}

export class KeyringRollbackError extends Error {
  constructor(
    public readonly seen: number,
    public readonly got: number,
  ) {
    super(`The provider returned keyring epoch ${got}, older than ${seen} seen before — refused (rollback)`);
    this.name = "KeyringRollbackError";
  }
}

/* ─── AES-GCM with role-bound additional data ──────────────────────────── */

const aad = (vaultId: string, epoch: number, role: string) => utf8(`lumen-e2ee-keyring/${PROTOCOL}/${vaultId}/${epoch}/${role}`);

async function sealWith(key: CryptoKey, data: Uint8Array, ad: Uint8Array): Promise<Sealed> {
  const n = randomBytes(12);
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(n), additionalData: bs(ad) }, key, bs(data)));
  return { n: toB64u(n), c: toB64u(c) };
}

async function openWith(key: CryptoKey, s: Sealed, ad: Uint8Array): Promise<Uint8Array> {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(fromB64u(s.n)), additionalData: bs(ad) }, key, bs(fromB64u(s.c))));
  } catch {
    throw new DecryptError("The keyring could not be opened: wrong key, or it was changed");
  }
}

/* ─── Reading ──────────────────────────────────────────────────────────── */

export function decodeKeyring(bytes: Uint8Array): KeyringFile {
  let o: KeyringFile;
  try {
    o = JSON.parse(fromUtf8(bytes)) as KeyringFile;
  } catch {
    throw new DecryptError("The keyring is not JSON");
  }
  const sealedOk = (s: unknown) => !!s && typeof (s as Sealed).n === "string" && typeof (s as Sealed).c === "string";
  if (o?.format !== FORMAT || o.protocol !== PROTOCOL || typeof o.vaultId !== "string" || !Number.isSafeInteger(o.epoch) || o.epoch < 1 || !sealedOk(o.passphrase) || !sealedOk(o.sealed) || !o.devices || typeof o.devices !== "object" || (o.header !== undefined && typeof o.header !== "string")) {
    throw new DecryptError("Not a Lumen keyring");
  }
  return o;
}

export async function readKeyring(provider: SyncProvider, name = KEYRING_NAME): Promise<{ file: KeyringFile; etag: string; bytes: Uint8Array } | null> {
  const obj: StoredObject | null = await provider.get(name);
  return obj ? { file: decodeKeyring(obj.data), etag: obj.etag, bytes: obj.data } : null;
}

/** How this device opens the keyring: the passphrase's wrap key, or its own age identity. */
export type KeyAccess = { wrap: CryptoKey } | { device: string; identity: string };

/** The epoch secret of `file`, through `access`. RevokedError when the device has no wrap. */
export async function unwrapSecret(file: KeyringFile, access: KeyAccess): Promise<Uint8Array> {
  if ("wrap" in access) return openWith(access.wrap, file.passphrase, aad(file.vaultId, file.epoch, "passphrase"));
  const d = file.devices[access.device];
  if (!d) throw new RevokedError();
  try {
    return await ageDecrypt(fromB64u(d.wrap), [{ identity: access.identity }]);
  } catch {
    throw new RevokedError();
  }
}

function parseContents(bytes: Uint8Array): KeyringContents {
  let c: KeyringContents;
  try {
    c = JSON.parse(fromUtf8(bytes)) as KeyringContents;
  } catch {
    throw new DecryptError("The keyring's sealed part is not JSON");
  }
  if (!c || typeof c !== "object" || !c.older || typeof c.older !== "object" || !Array.isArray(c.revoked)) throw new DecryptError("Bad keyring contents");
  if (c.devices !== undefined && (!c.devices || typeof c.devices !== "object")) throw new DecryptError("Bad keyring device list");
  if (c.manifest !== undefined && !isManifestLabel(c.manifest)) throw new DecryptError("Bad keyring manifest label");
  if (c.carry !== undefined && (!c.carry || !isManifestLabel(c.carry.label) || !Number.isSafeInteger(c.carry.epoch) || typeof c.carry.digest !== "string")) throw new DecryptError("Bad keyring carry");
  if (c.header !== undefined && typeof c.header !== "string") throw new DecryptError("Bad keyring header");
  return c;
}

function ringInfo(c: KeyringContents): RingInfo {
  return { manifest: c.manifest ?? "manifest", ...(c.carry ? { carry: c.carry } : {}), ...(c.header ? { header: c.header } : {}), ...(c.devices ? {} : { legacyDevices: true }) };
}

/**
 * The vault's keys at the keyring's epoch. `base` supplies what the epoch
 * doesn't: the header and wrap keys of the passphrase (when opened with it).
 */
export async function keysFromKeyring(file: KeyringFile, secret: Uint8Array, base: Pick<VaultKeys, "header" | "wrap">): Promise<VaultKeys> {
  const e = await epochKeys(secret, file.vaultId);
  const contents = parseContents(await openWith(e.keyring, file.sealed, aad(file.vaultId, file.epoch, "sealed")));
  const olderSecrets = new Map<number, Uint8Array>();
  for (const [k, v] of Object.entries(contents.older ?? {})) olderSecrets.set(Number(k), fromB64u(v));
  const secret0 = olderSecrets.get(0);
  if (!secret0) throw new DecryptError("The keyring has no epoch 0");
  const olderBlobs = new Map<number, CryptoKey>();
  for (const [ep, s] of olderSecrets) olderBlobs.set(ep, (await epochKeys(s, file.vaultId)).blobs);
  return { vaultId: file.vaultId, header: base.header, wrap: base.wrap, names: await namesKey(secret0, file.vaultId), ...e, epoch: file.epoch, secret, olderBlobs, olderSecrets, ring: ringInfo(contents) };
}

/** The sealed part of the keyring the keys came from. */
export async function keyringContents(file: KeyringFile, keys: VaultKeys): Promise<KeyringContents> {
  return parseContents(await openWith(keys.keyring, file.sealed, aad(file.vaultId, file.epoch, "sealed")));
}

/** A device opened the keyring with its own key: it must still be on the sealed list. */
export async function checkDeviceEnrolled(file: KeyringFile, keys: VaultKeys, device: string): Promise<void> {
  const c = await keyringContents(file, keys);
  if (c.revoked.some((r) => r.device === device) || (c.devices && !(device in c.devices))) throw new RevokedError();
}

/**
 * The device list of a keyring written before review 12.11 (no sealed list):
 * the plaintext map, minus revoked ids and recipients, minus entries whose
 * recipient isn't an age X25519 key or whose wrap isn't an age file to one.
 */
function legacyDeviceList(file: KeyringFile, c: KeyringContents): Record<string, string> {
  const revokedIds = new Set(c.revoked.map((r) => r.device));
  const revokedKeys = new Set(c.revoked.map((r) => r.recipient).filter((r): r is string => !!r));
  const out: Record<string, string> = {};
  for (const [id, d] of Object.entries(file.devices)) {
    if (revokedIds.has(id) || revokedKeys.has(d?.recipient)) continue;
    try {
      parseRecipient(d.recipient);
      if (!fromUtf8(fromB64u(d.wrap).subarray(0, 64)).startsWith("age-encryption.org/v1\n-> X25519 ")) continue;
    } catch {
      continue;
    }
    out[id] = d.recipient;
  }
  return out;
}

/**
 * Bring `keys` up to the provider's keyring. Returns the same keys when the
 * epoch is unchanged (or there is no keyring and the keys are epoch 0), new
 * keys for a newer epoch. Throws KeyringRollbackError for an older one,
 * RevokedError when this device can't open the new epoch.
 */
export async function refreshKeys(provider: SyncProvider, keys: VaultKeys, access: KeyAccess, seenEpoch = keys.epoch): Promise<VaultKeys> {
  const k = await readKeyring(provider);
  if (!k) {
    if (seenEpoch > 0) throw new KeyringRollbackError(seenEpoch, 0);
    return keys;
  }
  if (k.file.vaultId !== keys.vaultId) throw new DecryptError("The keyring belongs to another vault");
  if (k.file.epoch < seenEpoch) throw new KeyringRollbackError(seenEpoch, k.file.epoch);
  if (k.file.epoch === keys.epoch) return keys;
  const secret = await unwrapSecret(k.file, access);
  if ("wrap" in access) return keysFromKeyring(k.file, secret, keys);
  let next: VaultKeys;
  try {
    next = await keysFromKeyring(k.file, secret, keys);
  } catch {
    throw new RevokedError(); // a wrap of some other epoch's secret, put back by the provider
  }
  await checkDeviceEnrolled(k.file, next, access.device);
  return next;
}

/* ─── Writing ──────────────────────────────────────────────────────────── */

export interface RekeyOptions {
  /** Devices to shut out: their wrap is not carried over to the new epoch. */
  revoke?: string[];
  /** Devices to add (or keep with a new key): id → age recipient. */
  enroll?: Record<string, string>;
  /** A new passphrase's master key material (header.ts derives it with fresh KDF parameters). */
  newPassphraseMaster?: Uint8Array;
  /** With `newPassphraseMaster`: the new header's bytes, carried in the keyring until it is written. */
  newHeader?: Uint8Array;
  /** The previous epoch's frozen manifest this epoch's manifest is re-sealed from. */
  carry?: { label: string; epoch: number; digest: string };
  now?: () => number;
}

export interface PreparedEpoch {
  /** The keyring file for the new epoch, encoded. Nothing is written yet. */
  bytes: Uint8Array<ArrayBuffer>;
  /** The keys of the new epoch. */
  keys: VaultKeys;
  /** Ids the new epoch is wrapped for (the passphrase aside). */
  devices: string[];
}

/**
 * The keyring for a new epoch after `current` (null: the first re-key), with
 * nothing written. `E2eeSync.rekey` commits it with compare-and-swap on
 * `current.etag`. Recipients come only from the sealed (authenticated)
 * device list, never from the plaintext map, and never include a revoked
 * id or key.
 */
export async function prepareEpoch(current: { file: KeyringFile } | null, keys: VaultKeys, opts: RekeyOptions = {}): Promise<PreparedEpoch> {
  if (current && current.file.epoch !== keys.epoch) throw new PreconditionFailedError(KEYRING_NAME);
  if (!current && keys.epoch !== 0) throw new KeyringRollbackError(keys.epoch, 0);
  const prior: KeyringContents = current ? await keyringContents(current.file, keys) : { older: {}, revoked: [], devices: {} };
  const enrolled = current ? (prior.devices ?? legacyDeviceList(current.file, prior)) : {};
  const epoch = keys.epoch + 1;
  const secret = randomBytes(32);
  const older: Record<string, string> = { ...prior.older, [String(keys.epoch)]: toB64u(keys.secret) };
  const now = (opts.now ?? Date.now)();
  const revokedIds = new Set(prior.revoked.map((r) => r.device));
  const revokedKeys = new Set(prior.revoked.map((r) => r.recipient).filter((r): r is string => !!r));
  const revoke = new Set(opts.revoke ?? []);
  for (const [id, r] of Object.entries(opts.enroll ?? {})) {
    if (revoke.has(id)) continue;
    if (revokedIds.has(id) || revokedKeys.has(r)) throw new RevokedDeviceEnrollError(id);
    parseRecipient(r);
  }
  const revoked = [...prior.revoked, ...[...revoke].filter((d) => !revokedIds.has(d)).map((device) => ({ device, epoch, at: now, ...(enrolled[device] ? { recipient: enrolled[device] } : {}) }))];
  // Who gets the new secret: the enrolled devices, minus every revoked one, plus the newly enrolled.
  const recipients = new Map<string, string>();
  for (const [id, r] of Object.entries(enrolled)) if (!revoke.has(id) && !revokedIds.has(id) && !revokedKeys.has(r)) recipients.set(id, r);
  for (const [id, r] of Object.entries(opts.enroll ?? {})) if (!revoke.has(id)) recipients.set(id, r);

  let wrap = keys.wrap;
  let header = keys.header;
  if (opts.newPassphraseMaster) ({ wrap, header } = await passphraseKeys(opts.newPassphraseMaster, keys.vaultId));
  if (!wrap) throw new Error("A re-key needs the passphrase (or a new one) on this device");

  const e = await epochKeys(secret, keys.vaultId);
  const devices: Record<string, DeviceWrap> = {};
  for (const [id, recipient] of recipients) devices[id] = { recipient, wrap: toB64u(await ageEncrypt(secret, [{ x25519: recipient }])) };
  const contents: KeyringContents = {
    older,
    revoked,
    devices: Object.fromEntries(recipients),
    manifest: `manifest/${epoch}`,
    ...(opts.carry ? { carry: opts.carry } : {}),
    ...(opts.newHeader ? { header: await sha256Hex(opts.newHeader) } : {}),
  };
  const file: KeyringFile = {
    format: FORMAT,
    protocol: PROTOCOL,
    vaultId: keys.vaultId,
    epoch,
    passphrase: await sealWith(wrap, secret, aad(keys.vaultId, epoch, "passphrase")),
    devices,
    sealed: await sealWith(e.keyring, utf8(JSON.stringify(contents)), aad(keys.vaultId, epoch, "sealed")),
    ...(opts.newHeader ? { header: toB64u(opts.newHeader) } : {}),
  };
  const olderSecrets = new Map(keys.olderSecrets);
  olderSecrets.set(keys.epoch, keys.secret);
  const olderBlobs = new Map(keys.olderBlobs);
  olderBlobs.set(keys.epoch, blobKey(keys, keys.epoch));
  return { bytes: utf8(JSON.stringify(file)), keys: { ...keys, ...e, header, wrap, epoch, secret, olderSecrets, olderBlobs, ring: ringInfo(contents) }, devices: [...recipients.keys()] };
}

/** Re-seal the keyring's contents at the same epoch, with compare-and-swap. */
async function resealSameEpoch(provider: SyncProvider, current: { file: KeyringFile; etag: string }, keys: VaultKeys, contents: KeyringContents, devices: Record<string, DeviceWrap>): Promise<void> {
  const f = current.file;
  const next: KeyringFile = { ...f, devices, sealed: await sealWith(keys.keyring, utf8(JSON.stringify(contents)), aad(f.vaultId, f.epoch, "sealed")) };
  await provider.put(KEYRING_NAME, utf8(JSON.stringify(next)), { ifMatch: current.etag });
}

/** Keep the same epoch, add a device's wrap (an enrollment needs no re-key). */
export async function enrollDevice(provider: SyncProvider, keys: VaultKeys, device: string, recipient: string): Promise<void> {
  const current = await readKeyring(provider);
  if (!current) throw new Error("Enroll devices after the first re-key (the vault has no keyring yet)");
  if (current.file.epoch !== keys.epoch) throw new PreconditionFailedError(KEYRING_NAME);
  parseRecipient(recipient);
  const c = await keyringContents(current.file, keys);
  if (c.revoked.some((r) => r.device === device || r.recipient === recipient)) throw new RevokedDeviceEnrollError(device);
  const list = { ...(c.devices ?? legacyDeviceList(current.file, c)), [device]: recipient };
  const wraps: Record<string, DeviceWrap> = {};
  for (const id of Object.keys(list)) if (current.file.devices[id]?.recipient === list[id]) wraps[id] = current.file.devices[id];
  wraps[device] = { recipient, wrap: toB64u(await ageEncrypt(keys.secret, [{ x25519: recipient }])) };
  await resealSameEpoch(provider, current, keys, { ...c, devices: list }, wraps);
}

/**
 * Review 12.11, migration: a keyring written before the device list was
 * sealed gets it sealed now, by a device holding the epoch's keys (the
 * first trusted unlock). Returns true when it wrote the keyring.
 */
export async function sealDeviceList(provider: SyncProvider, keys: VaultKeys): Promise<boolean> {
  const current = await readKeyring(provider);
  if (!current || current.file.epoch !== keys.epoch) return false;
  const c = await keyringContents(current.file, keys);
  if (c.devices) return false;
  const list = legacyDeviceList(current.file, c);
  const wraps: Record<string, DeviceWrap> = {};
  for (const id of Object.keys(list)) wraps[id] = current.file.devices[id];
  try {
    await resealSameEpoch(provider, current, keys, { ...c, devices: list }, wraps);
  } catch (e) {
    if (e instanceof PreconditionFailedError) return false; // someone else did; read again next round
    throw e;
  }
  return true;
}

/** The additional data of a keyring field (the spec's test vectors use it). */
export const keyringAad = aad;
