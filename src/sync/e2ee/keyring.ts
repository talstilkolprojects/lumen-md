/**
 * The keyring (plan W1.7): key rotation and device revocation.
 *
 * Without a keyring (epoch 0) all keys come from the passphrase: anyone who
 * ever knew it, or kept the derived keys, can read the vault for good. The
 * keyring adds an *epoch secret*, 32 random bytes, from which the manifest,
 * blob and pairing keys of that epoch derive (keys.ts `epochKeys`). It is
 * stored at the provider under the fixed name `lumen-e2ee-keyring`:
 *
 *   {
 *     format: "lumen-e2ee-keyring", protocol: 2, vaultId, epoch,
 *     passphrase: {n, c},          // AES-GCM(wrap key from the passphrase, secret)
 *     devices: { <id>: { recipient: "age1…", wrap: "<base64 age file of the secret>" } },
 *     sealed: {n, c},              // AES-GCM(epoch's keyring key, JSON KeyringContents)
 *     header?: "<b64u>",           // a passphrase change: the new vault header, until it is written
 *     prev?: "<b64u>"              // with `header`: the keyring this one replaced (the old passphrase's way back)
 *   }
 *
 * Every AES-GCM has the protocol, the vault id, the epoch and its role as
 * additional data, so a wrap can't be moved to another epoch, vault or
 * device. `older` holds the secrets of all earlier epochs, so blobs written
 * before a re-key stay readable: a re-key writes a new manifest and the
 * keyring, and nothing else, with no blob downloaded or uploaded again.
 *
 * Who is enrolled (review 12.11): the plaintext `devices` map only lets a
 * device find its own wrap. The list a re-key wraps the next secret for is
 * the sealed `devices` (id → recipient), which only holders of the epoch's
 * secret can write, minus every device in the sealed `revoked` list. A
 * keyring without that sealed list (protocol 1: pre-release builds only) is
 * refused (`PreReleaseKeyringError`); the passphrase can reset it to a new
 * epoch wrapped for nobody but the passphrase, and devices enroll again.
 *
 * Which keyring (re-review 12.11, RR-2): every keyring names the one it
 * replaced. The sealed part has a per-epoch revision `rev` (0 for a new
 * epoch, + 1 for each rewrite at the same epoch: an enrollment, an aborted
 * re-key, a finished passphrase change), `parent` (the replaced keyring's
 * digest, `keyringDigest`) and `chain`, the last `CHAIN_LENGTH` (epoch, rev, digest)
 * before it. A device remembers the (epoch, rev, digest) it verified last
 * and accepts only a keyring that descends from it: an older epoch or rev
 * is a rollback, another keyring at the same epoch and rev or a chain that
 * doesn't list it is a fork (`KeyringForkError`). A keyring at the same epoch
 * that this device's epoch key can't open is a fork too.
 *
 * Each epoch's manifest has a random label (`manifest/<epoch>/<random>`,
 * RR-3) in the sealed part: nobody without the epoch's secret can name it in
 * advance.
 */

import { bs, equalBytes, fromB64u, fromUtf8, randomBytes, sha256Hex, toB64u, utf8 } from "./bytes";
import { ageDecrypt, ageEncrypt, parseRecipient } from "./age";
import { blobKey, DecryptError, epochKeys, namesKey, passphraseKeys, type RingInfo, type VaultKeys } from "./keys";
import { isManifestLabel } from "./manifest";
import { PreconditionFailedError, type StoredObject, type SyncProvider } from "./provider";

export const KEYRING_NAME = "lumen-e2ee-keyring";
const FORMAT = "lumen-e2ee-keyring";
/** Protocol 2 (re-review 12.11): the sealed device list, the hash chain, random manifest labels. */
export const KEYRING_PROTOCOL = 2;
/** Pre-release keyrings (no sealed device list, no chain). Opened only to reset them. */
const PRE_RELEASE_PROTOCOL = 1;
/** How many earlier keyrings a keyring lists (`chain`). */
export const CHAIN_LENGTH = 64;
/** How many aborted re-keys (frozen manifest digests) a keyring remembers. */
export const ABORTED_LENGTH = 16;

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
  /** With `header`: the keyring this one replaced (base64url bytes), bound by `KeyringContents.parent`. */
  prev?: string;
}

export interface KeyringContents {
  /** Secrets of the earlier epochs, base64url, by epoch. */
  older: Record<string, string>;
  /** Devices revoked so far, with the epoch that shut them out and their recipient. */
  revoked: Array<{ device: string; epoch: number; at: number; recipient?: string }>;
  /** The enrolled devices, id → age recipient: the only list a re-key wraps for. */
  devices: Record<string, string>;
  /** This epoch's manifest label (`RingInfo.manifest`): "manifest/<epoch>/<random>". */
  manifest: string;
  /** The revision at this epoch: 0 for a new epoch, + 1 per rewrite. */
  rev: number;
  /** The digest (`keyringDigest`) of the keyring this one replaced; null for the first one. */
  parent: string | null;
  /** (epoch, rev, digest) of the keyrings before this one, oldest first; the last is `parent`. */
  chain: Array<[number, number, string]>;
  /** The previous epoch's frozen manifest this epoch's was made from. */
  carry?: { label: string; epoch: number; digest: string };
  /** SHA-256 hex of the header the passphrase wrap belongs to, while a passphrase change is being written. */
  header?: string;
  /** Digests of this epoch's frozen manifests whose re-key was called off (RR-4): devices may write over them. */
  aborted?: string[];
}

/** What a device remembers of the keyring it verified last. */
export interface RingAnchor {
  epoch: number;
  rev: number;
  digest: string;
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
    message?: string,
  ) {
    super(message ?? `The provider returned keyring epoch ${got}, older than ${seen} seen before — refused (rollback)`);
    this.name = "KeyringRollbackError";
  }
}

/** A keyring that doesn't descend from the one this device verified last (RR-2). */
export class KeyringForkError extends Error {
  constructor(detail: string) {
    super(`The provider returned a keyring that doesn't descend from the one this device verified (${detail}) — refused (fork). Don't re-key or enroll until every device agrees; pair this device again from one you trust.`);
    this.name = "KeyringForkError";
  }
}

/** A keyring from a pre-release build (no sealed device list): its device list can't be trusted (RR-1). */
export class PreReleaseKeyringError extends DecryptError {
  constructor() {
    super(
      "This vault's keyring was written by a pre-release build of Lumen, and its device list can't be trusted. Reset it from a device that has the passphrase (unlock with resetPreReleaseKeyring, then re-key): the new keys are wrapped for the passphrase only, and every device enrolls again.",
    );
    this.name = "PreReleaseKeyringError";
  }
}

/* ─── AES-GCM with role-bound additional data ──────────────────────────── */

const aadFor = (protocol: number, vaultId: string, epoch: number, role: string) => utf8(`lumen-e2ee-keyring/${protocol}/${vaultId}/${epoch}/${role}`);
const aad = (vaultId: string, epoch: number, role: string) => aadFor(KEYRING_PROTOCOL, vaultId, epoch, role);

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
  if (
    o?.format !== FORMAT ||
    (o.protocol !== KEYRING_PROTOCOL && o.protocol !== PRE_RELEASE_PROTOCOL) ||
    typeof o.vaultId !== "string" ||
    !Number.isSafeInteger(o.epoch) ||
    o.epoch < 1 ||
    !sealedOk(o.passphrase) ||
    !sealedOk(o.sealed) ||
    !o.devices ||
    typeof o.devices !== "object" ||
    (o.header !== undefined && typeof o.header !== "string") ||
    (o.prev !== undefined && (typeof o.prev !== "string" || o.header === undefined))
  ) {
    throw new DecryptError("Not a Lumen keyring");
  }
  return o;
}

export interface ReadKeyring {
  file: KeyringFile;
  etag: string;
  bytes: Uint8Array;
  /** `keyringDigest(file)`: what the chain and the anchors name. */
  digest: string;
}

/**
 * The keyring's digest: SHA-256 hex over everything in it a device can
 * check — the protocol, vault, epoch, passphrase wrap, sealed part and a
 * pending header — but not the plaintext device wraps, which nothing trusts
 * (an edit there is not another keyring, and must not look like a fork).
 */
export function keyringDigest(f: KeyringFile): Promise<string> {
  return sha256Hex(utf8(JSON.stringify([f.format, f.protocol, f.vaultId, f.epoch, f.passphrase.n, f.passphrase.c, f.sealed.n, f.sealed.c, f.header ?? null, f.prev ?? null])));
}

export async function readKeyring(provider: SyncProvider, name = KEYRING_NAME): Promise<ReadKeyring | null> {
  const obj: StoredObject | null = await provider.get(name);
  if (!obj) return null;
  const file = decodeKeyring(obj.data);
  return { file, etag: obj.etag, bytes: obj.data, digest: await keyringDigest(file) };
}

/** How this device opens the keyring: the passphrase's wrap key, or its own age identity. */
export type KeyAccess = { wrap: CryptoKey } | { device: string; identity: string };

/** The epoch secret of `file`, through `access`. RevokedError when the device has no wrap. */
export async function unwrapSecret(file: KeyringFile, access: KeyAccess): Promise<Uint8Array> {
  if ("wrap" in access) return openWith(access.wrap, file.passphrase, aadFor(file.protocol, file.vaultId, file.epoch, "passphrase"));
  if (file.protocol !== KEYRING_PROTOCOL) throw new PreReleaseKeyringError();
  const d = file.devices[access.device];
  if (!d) throw new RevokedError();
  try {
    return await ageDecrypt(fromB64u(d.wrap), [{ identity: access.identity }]);
  } catch {
    throw new RevokedError();
  }
}

const isHex64 = (s: unknown) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);

function parseContents(bytes: Uint8Array, epoch: number): KeyringContents {
  let c: KeyringContents;
  try {
    c = JSON.parse(fromUtf8(bytes)) as KeyringContents;
  } catch {
    throw new DecryptError("The keyring's sealed part is not JSON");
  }
  if (!c || typeof c !== "object" || !c.older || typeof c.older !== "object" || !Array.isArray(c.revoked)) throw new DecryptError("Bad keyring contents");
  if (!c.devices || typeof c.devices !== "object" || Array.isArray(c.devices)) throw new PreReleaseKeyringError();
  if (!isManifestLabel(c.manifest) || c.manifest === "manifest" || !c.manifest.startsWith(`manifest/${epoch}/`)) throw new DecryptError("Bad keyring manifest label");
  if (!Number.isSafeInteger(c.rev) || c.rev < 0) throw new DecryptError("Bad keyring revision");
  if (c.parent !== null && !isHex64(c.parent)) throw new DecryptError("Bad keyring parent");
  const chain = c.chain;
  if (
    !Array.isArray(chain) ||
    chain.length > CHAIN_LENGTH ||
    !chain.every((h, i) => Array.isArray(h) && h.length === 3 && Number.isSafeInteger(h[0]) && Number.isSafeInteger(h[1]) && isHex64(h[2]) && (i === 0 || h[0] > chain[i - 1][0] || (h[0] === chain[i - 1][0] && h[1] > chain[i - 1][1])))
  ) {
    throw new DecryptError("Bad keyring chain");
  }
  const last = chain[chain.length - 1];
  if ((c.parent === null) !== (chain.length === 0) || (last && (last[2] !== c.parent || last[0] > epoch || (last[0] === epoch && last[1] >= c.rev)))) throw new DecryptError("Bad keyring chain");
  if (c.rev > 0 && (!last || last[0] !== epoch || last[1] !== c.rev - 1)) throw new DecryptError("Bad keyring chain");
  if (c.carry !== undefined && (!c.carry || !isManifestLabel(c.carry.label) || !Number.isSafeInteger(c.carry.epoch) || typeof c.carry.digest !== "string")) throw new DecryptError("Bad keyring carry");
  if (c.header !== undefined && !isHex64(c.header)) throw new DecryptError("Bad keyring header");
  if (c.aborted !== undefined && (!Array.isArray(c.aborted) || !c.aborted.every((d) => typeof d === "string"))) throw new DecryptError("Bad keyring aborted list");
  return c;
}

/** A pre-release keyring's sealed part, read only to reset it: its device list is never used. */
function parsePreRelease(bytes: Uint8Array): KeyringContents {
  let c: { older?: unknown; revoked?: unknown };
  try {
    c = JSON.parse(fromUtf8(bytes)) as typeof c;
  } catch {
    throw new DecryptError("The keyring's sealed part is not JSON");
  }
  if (!c || !c.older || typeof c.older !== "object" || !Array.isArray(c.revoked)) throw new DecryptError("Bad keyring contents");
  const raw = c as unknown as { manifest?: unknown };
  const manifest = isManifestLabel(raw.manifest) ? raw.manifest : "manifest";
  return { older: c.older as Record<string, string>, revoked: c.revoked as KeyringContents["revoked"], devices: {}, manifest, rev: 0, parent: null, chain: [] };
}

function ringInfo(c: KeyringContents, digest: string, preRelease = false): RingInfo {
  return {
    manifest: c.manifest,
    rev: c.rev,
    digest,
    ...(c.carry ? { carry: c.carry } : {}),
    ...(c.header ? { header: c.header } : {}),
    aborted: c.aborted ?? [],
    ...(preRelease ? { preRelease: true as const } : {}),
  };
}

/** Open the sealed part of `file` with its epoch's keyring key. */
async function openContents(file: KeyringFile, keyring: CryptoKey, allowPreRelease = false): Promise<KeyringContents> {
  if (file.protocol === KEYRING_PROTOCOL) return parseContents(await openWith(keyring, file.sealed, aad(file.vaultId, file.epoch, "sealed")), file.epoch);
  if (!allowPreRelease) throw new PreReleaseKeyringError();
  return parsePreRelease(await openWith(keyring, file.sealed, aadFor(PRE_RELEASE_PROTOCOL, file.vaultId, file.epoch, "sealed")));
}

/**
 * The vault's keys at the keyring's epoch. `base` supplies what the epoch
 * doesn't: the header and wrap keys of the passphrase (when opened with it).
 * `digest` is the SHA-256 of the keyring's bytes (`readKeyring`).
 * A pre-release keyring is refused unless `allowPreRelease` (the reset).
 */
export async function keysFromKeyring(
  file: KeyringFile,
  secret: Uint8Array,
  base: Pick<VaultKeys, "header" | "wrap">,
  opts: { digest?: string; allowPreRelease?: boolean } = {},
): Promise<VaultKeys> {
  const e = await epochKeys(secret, file.vaultId);
  const contents = await openContents(file, e.keyring, opts.allowPreRelease);
  const olderSecrets = new Map<number, Uint8Array>();
  for (const [k, v] of Object.entries(contents.older ?? {})) olderSecrets.set(Number(k), fromB64u(v));
  const secret0 = olderSecrets.get(0);
  if (!secret0) throw new DecryptError("The keyring has no epoch 0");
  const olderBlobs = new Map<number, CryptoKey>();
  for (const [ep, s] of olderSecrets) olderBlobs.set(ep, (await epochKeys(s, file.vaultId)).blobs);
  return {
    vaultId: file.vaultId,
    header: base.header,
    wrap: base.wrap,
    names: await namesKey(secret0, file.vaultId),
    ...e,
    epoch: file.epoch,
    secret,
    olderBlobs,
    olderSecrets,
    ring: ringInfo(contents, opts.digest ?? "", file.protocol !== KEYRING_PROTOCOL),
  };
}

/** The sealed part of the keyring the keys came from. */
export async function keyringContents(file: KeyringFile, keys: VaultKeys): Promise<KeyringContents> {
  return openContents(file, keys.keyring);
}

/** A device opened the keyring with its own key: it must still be on the sealed list. */
export async function checkDeviceEnrolled(file: KeyringFile, keys: VaultKeys, device: string): Promise<void> {
  const c = await keyringContents(file, keys);
  if (c.revoked.some((r) => r.device === device) || !(device in c.devices)) throw new RevokedError();
}

/** The anchor of the keyring `keys` came from (epoch 0: none yet). */
export function anchorOf(keys: VaultKeys): RingAnchor {
  return keys.ring ? { epoch: keys.epoch, rev: keys.ring.rev, digest: keys.ring.digest } : { epoch: 0, rev: 0, digest: "" };
}

/**
 * Does the keyring (`epoch`, `contents`) descend from `last`, the keyring a
 * device verified? Throws for a rollback or a fork; "unproven" when `last`
 * is older than the chain reaches.
 */
function checkDescent(epoch: number, digest: string, c: KeyringContents, last: RingAnchor): "ok" | "unproven" {
  if (last.epoch === 0) return "ok"; // no keyring seen yet: the lineage check (older[0]) stands in
  if (epoch < last.epoch) throw new KeyringRollbackError(last.epoch, epoch);
  if (epoch === last.epoch && c.rev < last.rev) throw new KeyringRollbackError(last.epoch, epoch, `The provider returned keyring revision ${epoch}.${c.rev}, older than ${last.epoch}.${last.rev} seen before — refused (rollback)`);
  if (epoch === last.epoch && c.rev === last.rev) {
    if (digest !== last.digest) throw new KeyringForkError(`another keyring at ${epoch}.${c.rev}`);
    return "ok";
  }
  const at = c.chain.find(([e, r]) => e === last.epoch && r === last.rev);
  if (at) {
    if (at[2] !== last.digest) throw new KeyringForkError(`its chain has another ${last.epoch}.${last.rev}`);
    return "ok";
  }
  const first = c.chain[0];
  // The chain is complete (shorter than its cap), or it reaches back past `last`: `last` should be in it.
  if (c.chain.length < CHAIN_LENGTH || (first && (first[0] < last.epoch || (first[0] === last.epoch && first[1] < last.rev)))) {
    throw new KeyringForkError(`its chain doesn't list ${last.epoch}.${last.rev}`);
  }
  return "unproven";
}

/**
 * Bring `keys` up to the provider's keyring. Returns the same keys when the
 * keyring is the one they came from, new keys otherwise — after checking it
 * descends from `seen` (the newest keyring this device verified; default:
 * the one `keys` came from). Throws KeyringRollbackError for an older one,
 * KeyringForkError for one that doesn't descend from it, RevokedError when
 * this device can't open it any more. The new keys' `ring.unproven` says the
 * descent could not be proven (the device was too far behind).
 */
export async function refreshKeys(provider: SyncProvider, keys: VaultKeys, access: KeyAccess, seen: RingAnchor | number = anchorOf(keys)): Promise<VaultKeys> {
  const last: RingAnchor = typeof seen === "number" ? { ...anchorOf(keys), epoch: Math.max(seen, keys.epoch) } : seen;
  const k = await readKeyring(provider);
  if (!k) {
    if (last.epoch > 0 || keys.epoch > 0) throw new KeyringRollbackError(Math.max(last.epoch, keys.epoch), 0);
    return keys;
  }
  if (k.file.vaultId !== keys.vaultId) throw new DecryptError("The keyring belongs to another vault");
  // Unchanged: the keyring these keys came from, and the one this device verified last.
  if (keys.ring && k.digest === keys.ring.digest && k.file.epoch === keys.epoch && (last.epoch === 0 || (last.epoch === keys.epoch && last.rev === keys.ring.rev && last.digest === k.digest))) return keys;
  if (k.file.epoch < Math.max(last.epoch, keys.epoch)) throw new KeyringRollbackError(Math.max(last.epoch, keys.epoch), k.file.epoch);
  let next: VaultKeys;
  if (k.file.epoch === keys.epoch) {
    // The same epoch: this device's epoch key must open it (RR-2), or it is another lineage.
    try {
      next = await keysFromKeyring(k.file, keys.secret, keys, { digest: k.digest });
    } catch (e) {
      if (e instanceof PreReleaseKeyringError) throw e;
      throw new KeyringForkError(`epoch ${k.file.epoch} sealed with a secret this device doesn't hold`);
    }
  } else {
    const secret = await unwrapSecret(k.file, access);
    try {
      next = await keysFromKeyring(k.file, secret, keys, { digest: k.digest });
    } catch (e) {
      if (e instanceof PreReleaseKeyringError) throw e;
      if ("wrap" in access) throw e;
      throw new RevokedError(); // a wrap of some other epoch's secret, put back by the provider
    }
    // Lineage: the new epoch must list this device's current secret as its own epoch's.
    const mine = next.olderSecrets.get(keys.epoch);
    if (!mine || !equalBytes(mine, keys.secret)) throw new KeyringForkError(`epoch ${k.file.epoch} doesn't descend from this device's epoch ${keys.epoch}`);
  }
  const contents = await keyringContents(k.file, next);
  const verdict = checkDescent(k.file.epoch, k.digest, contents, last);
  if ("device" in access) await checkDeviceEnrolled(k.file, next, access.device);
  if (verdict === "unproven") next = { ...next, ring: { ...next.ring!, unproven: true } };
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
  /** The previous epoch's frozen manifest this epoch's manifest is made from. */
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

/** A fresh, unguessable manifest label for `epoch` (RR-3). */
export function newManifestLabel(epoch: number): string {
  return `manifest/${epoch}/${toB64u(randomBytes(16))}`;
}

const chainAfter = (c: KeyringContents | null, epoch: number, digest: string): Array<[number, number, string]> =>
  c ? [...c.chain, [epoch, c.rev, digest] as [number, number, string]].slice(-CHAIN_LENGTH) : [];

/**
 * The keyring for a new epoch after `current` (null: the first re-key), with
 * nothing written. `E2eeSync.rekey` commits it with compare-and-swap on
 * `current.etag`. Recipients come only from the sealed (authenticated)
 * device list, never from the plaintext map, and never include a revoked
 * id or key. From a pre-release keyring (`keys.ring.preRelease`, the reset)
 * the new epoch is wrapped for the passphrase and `enroll` only.
 */
export async function prepareEpoch(current: ReadKeyring | null, keys: VaultKeys, opts: RekeyOptions = {}): Promise<PreparedEpoch> {
  if (current && (current.file.epoch !== keys.epoch || (keys.ring && current.digest !== keys.ring.digest))) throw new PreconditionFailedError(KEYRING_NAME);
  if (!current && keys.epoch !== 0) throw new KeyringRollbackError(keys.epoch, 0);
  const preRelease = !!current && current.file.protocol !== KEYRING_PROTOCOL;
  const prior: KeyringContents | null = current ? await openContents(current.file, keys.keyring, preRelease) : null;
  const enrolled: Record<string, string> = prior && !preRelease ? prior.devices : {};
  const priorRevoked = prior?.revoked ?? [];
  const epoch = keys.epoch + 1;
  const secret = randomBytes(32);
  const older: Record<string, string> = { ...(prior?.older ?? {}), [String(keys.epoch)]: toB64u(keys.secret) };
  const now = (opts.now ?? Date.now)();
  const revokedIds = new Set(priorRevoked.map((r) => r.device));
  const revokedKeys = new Set(priorRevoked.map((r) => r.recipient).filter((r): r is string => !!r));
  const revoke = new Set(opts.revoke ?? []);
  for (const [id, r] of Object.entries(opts.enroll ?? {})) {
    if (revoke.has(id)) continue;
    if (revokedIds.has(id) || revokedKeys.has(r)) throw new RevokedDeviceEnrollError(id);
    parseRecipient(r);
  }
  const revoked = [...priorRevoked, ...[...revoke].filter((d) => !revokedIds.has(d)).map((device) => ({ device, epoch, at: now, ...(enrolled[device] ? { recipient: enrolled[device] } : {}) }))];
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
    manifest: newManifestLabel(epoch),
    rev: 0,
    parent: current ? current.digest : null,
    // A pre-release keyring starts a new chain: nothing before it is trusted.
    chain: current ? (preRelease ? [[keys.epoch, 0, current.digest]] : chainAfter(prior, keys.epoch, current.digest)) : [],
    ...(opts.carry ? { carry: opts.carry } : {}),
    ...(opts.newHeader ? { header: await sha256Hex(opts.newHeader) } : {}),
  };
  const file: KeyringFile = {
    format: FORMAT,
    protocol: KEYRING_PROTOCOL,
    vaultId: keys.vaultId,
    epoch,
    passphrase: await sealWith(wrap, secret, aad(keys.vaultId, epoch, "passphrase")),
    devices,
    sealed: await sealWith(e.keyring, utf8(JSON.stringify(contents)), aad(keys.vaultId, epoch, "sealed")),
    ...(opts.newHeader ? { header: toB64u(opts.newHeader), ...(current ? { prev: toB64u(current.bytes) } : {}) } : {}),
  };
  const bytes = utf8(JSON.stringify(file));
  const digest = await keyringDigest(file);
  const olderSecrets = new Map(keys.olderSecrets);
  olderSecrets.set(keys.epoch, keys.secret);
  const olderBlobs = new Map(keys.olderBlobs);
  olderBlobs.set(keys.epoch, blobKey(keys, keys.epoch));
  return { bytes, keys: { ...keys, ...e, header, wrap, epoch, secret, olderSecrets, olderBlobs, ring: ringInfo(contents, digest) }, devices: [...recipients.keys()] };
}

/**
 * Rewrite the keyring at the same epoch (rev + 1, chained to the one `keys`
 * came from), with compare-and-swap: an enrollment, an aborted re-key, a
 * finished passphrase change. `edit` changes the sealed contents and the
 * plaintext file. Returns the keys for the new keyring.
 * `PreconditionFailedError` when the stored keyring isn't the one `keys`
 * came from (another device wrote it first): refresh and try again.
 */
export async function rewriteKeyring(
  provider: SyncProvider,
  keys: VaultKeys,
  edit: (c: KeyringContents, f: KeyringFile) => { contents: KeyringContents; file: KeyringFile },
): Promise<VaultKeys> {
  const current = await readKeyring(provider);
  if (!current || !keys.ring || current.file.epoch !== keys.epoch || current.digest !== keys.ring.digest) throw new PreconditionFailedError(KEYRING_NAME);
  const c = await keyringContents(current.file, keys);
  const edited = edit(c, current.file);
  const contents: KeyringContents = { ...edited.contents, rev: c.rev + 1, parent: current.digest, chain: chainAfter(c, keys.epoch, current.digest) };
  const f = edited.file;
  const next: KeyringFile = { ...f, protocol: KEYRING_PROTOCOL, sealed: await sealWith(keys.keyring, utf8(JSON.stringify(contents)), aad(f.vaultId, f.epoch, "sealed")) };
  await provider.put(KEYRING_NAME, utf8(JSON.stringify(next)), { ifMatch: current.etag });
  return { ...keys, ring: ringInfo(contents, await keyringDigest(next)) };
}

/** Keep the same epoch, add a device's wrap (an enrollment needs no re-key). Use `E2eeSync.enroll`. */
export async function enrollDevice(provider: SyncProvider, keys: VaultKeys, device: string, recipient: string): Promise<VaultKeys> {
  if (!keys.ring) throw new Error("Enroll devices after the first re-key (the vault has no keyring yet)");
  parseRecipient(recipient);
  const wrap: DeviceWrap = { recipient, wrap: toB64u(await ageEncrypt(keys.secret, [{ x25519: recipient }])) };
  return rewriteKeyring(provider, keys, (c, f) => {
    if (c.revoked.some((r) => r.device === device || r.recipient === recipient)) throw new RevokedDeviceEnrollError(device);
    const list = { ...c.devices, [device]: recipient };
    return { contents: { ...c, devices: list }, file: { ...f, devices: { ...pickWraps(f, list), [device]: wrap } } };
  });
}

/** The plaintext wraps that match the sealed list (anything else the provider added is dropped). */
function pickWraps(f: KeyringFile, list: Record<string, string>): Record<string, DeviceWrap> {
  const out: Record<string, DeviceWrap> = {};
  for (const [id, r] of Object.entries(list)) if (f.devices[id]?.recipient === r) out[id] = f.devices[id];
  return out;
}

/** The additional data of a keyring field (the spec's test vectors use it). */
export const keyringAad = aad;
