/**
 * The encrypted sync engine's errors, request and result types, and the
 * small pure helpers its parts share (split out of engine.ts, W4.11; no
 * behaviour change). Import them from "./engine".
 */

import { type ConflictResolver } from "./conflict";
import { decodeHeader, headerMacValid, PROTOCOL_VERSION } from "./header";
import { type VaultKeys } from "./keys";
import { KEYRING_NAME, type KeyAccess, type RingAnchor } from "./keyring";
import { type LocalFiles } from "./localFiles";
import { HISTORY_LENGTH, pathRecord, type Manifest, type ManifestEntry } from "./manifest";
import { PreconditionFailedError, type StoredObject, type SyncProvider } from "./provider";
import type { SyncStateStore } from "./state";
import { PairingError } from "./pairing";
import type { PairingRole } from "./sas";

export class VaultExistsError extends Error {
  constructor() {
    super("An encrypted vault already exists at this provider");
    this.name = "VaultExistsError";
  }
}

export class NoVaultError extends Error {
  constructor() {
    super("No encrypted vault at this provider");
    this.name = "NoVaultError";
  }
}

/**
 * This device can't prove it has the latest keys (re-review 12.11, RR-5): it
 * was opened with the passphrase alone and never paired or confirmed, so the
 * provider may be showing it an old epoch. It pulls, but doesn't upload
 * (third review N6) or enroll devices, and its re-keys carry no device over:
 * from an old epoch it would wrap the next one for a device revoked meanwhile.
 */
export class UnverifiedDeviceError extends Error {
  constructor(what: string) {
    super(`This device can't verify it has the latest keys, so it can't ${what}: pair it from a device you trust (or confirm its state), then try again`);
    this.name = "UnverifiedDeviceError";
  }
}

/**
 * A pairing code or answer this device made is still valid (third review
 * 12.11, N3): a device paired with it would vouch for keys this change
 * replaces, so this device makes no key change until it expires.
 */
export class PairingPendingError extends Error {
  constructor(public readonly until: number) {
    super("A pairing code from this device is still valid: a device paired with it wouldn't learn of this key change. Wait until it expires (2 minutes at most), then try again.");
    this.name = "PairingPendingError";
  }
}

/**
 * A pairing code asked for while this device is changing the vault's keys
 * (seventh review 12.11, G3): it would vouch for the epoch the change is
 * replacing, so a device paired with it wouldn't learn of the change. Make
 * the code once the change has finished.
 */
export class PairingDuringKeyChangeError extends Error {
  constructor() {
    super("This device is changing the vault's keys right now: make the pairing code once the change has finished.");
    this.name = "PairingDuringKeyChangeError";
  }
}

/**
 * The comparison failed or can't go on (plan W8.5): the user said the
 * symbols differ, the other device's confirmation doesn't verify, or this
 * side's pairing ended (cancelled, expired, keys changed, app restarted).
 * Nothing was committed on this device; start pairing again.
 */
export class PairingAbortedError extends PairingError {
  constructor(message: string) {
    super(message);
    this.name = "PairingAbortedError";
  }
}

/** What a device shows while two devices pair (plan W8.5): the symbols to compare. */
export interface PairingComparison {
  role: PairingRole;
  /** SAS_LENGTH indices into SAS_EMOJI; the UI shows each emoji with its name (`e2ee.sas.w<index>`). */
  symbols: number[];
  emoji: string[];
}

/**
 * A revocation from this device lost its keyring commit, two or more times
 * in a row, to a rewrite of the keyring at the same epoch (ninth review
 * 12.11, H2). Anyone who still holds the epoch's secret and the storage
 * login can do that every time, most likely the device being removed: no
 * retry from here can win against it. Change the storage password or token
 * first, so the lost device can't write any more, then remove it again.
 * A `PreconditionFailedError`, as before, for callers that handle that.
 */
export class RevocationContestedError extends PreconditionFailedError {
  constructor(
    public readonly devices: string[],
    public readonly losses: number,
  ) {
    super(KEYRING_NAME);
    this.message = `Removing ${devices.join(", ")} lost to a rewrite of the device list ${losses} times in a row: something that still has the vault's keys and the storage login (most likely the device being removed) is blocking it. Change the storage password or token first, then remove it again.`;
    this.name = "RevocationContestedError";
  }
}

/**
 * This device is busy in another tab (review 34, K34-1 and K34-2): a round
 * there holds the device lock, and a key change waited for it longer than
 * `KEY_CHANGE_LOCK_WAIT_MS`, or a pairing code or answer was asked for
 * meanwhile. Nothing was written. Try again in a moment; a round stuck on a
 * storage request that never answers keeps the lock until its tab closes.
 */
export class DeviceBusyError extends Error {
  constructor() {
    super("This device is syncing in another tab right now (or that tab is stuck on the storage): try again in a moment, and if it keeps happening, reload or close the other tabs.");
    this.name = "DeviceBusyError";
  }
}

/** How long a key change waits for a round in another tab to let go of the device lock (K34-1). */
export const KEY_CHANGE_LOCK_WAIT_MS = 8_000;

/**
 * A re-key from a device that can't verify it has the latest keys would
 * leave `devices` out (fifth review 12.11, F3): it can't vouch for the device
 * list, so the new epoch would be wrapped for the passphrase and the devices
 * it enrolls only. That needs the user's consent: show who would be left
 * out, and re-key with `dropDevices: true` once they confirm — or pair this
 * device first, and nobody is left out.
 */
export class DropDevicesRequiredError extends UnverifiedDeviceError {
  constructor(public readonly devices: string[]) {
    super("re-key without leaving devices out");
    this.message = `This device can't verify it has the latest keys, so a key change from it would leave out ${devices.map((d) => `"${d}"`).join(", ")}: they would have to be paired again. Pair this device from one you trust first, or confirm that they should be left out (dropDevices).`;
    this.name = "DropDevicesRequiredError";
  }
}

/**
 * Another device froze the manifest for a key change that hasn't committed
 * yet (fifth review 12.11, Q2): this device waits it out on its own clock, as
 * a sync round does, instead of freezing over it. `until`: when (this
 * device's clock) the wait is over and a re-key may call it off.
 */
export class KeyChangeInProgressError extends PreconditionFailedError {
  constructor(public readonly until: number) {
    super(KEYRING_NAME);
    this.message = "Another device is changing the vault's keys right now. Sync, and try again when it has finished (10 minutes at most).";
    this.name = "KeyChangeInProgressError";
  }
}

/** A blob the manifest names is missing (replaced by a newer commit meanwhile): the round restarts. */
export class BlobMissingError extends Error {}

export interface RekeyRequest {
  revoke?: string[];
  enroll?: Record<string, string>;
  newPassphrase?: string;
  pbkdf2Iterations?: number;
  kdf?: "argon2id" | "pbkdf2-sha256";
  /**
   * The user confirmed, after the UI showed who (`DropDevicesRequiredError.devices`),
   * that a re-key from this unverified device leaves the other devices out
   * (fifth review 12.11, F3). Without it such a re-key is refused.
   */
  dropDevices?: boolean;
}

export interface RekeyResult {
  epoch: number;
  counter: number;
  /**
   * Objects written: the frozen old manifest, the new epoch's manifest, the
   * keyring, and with a passphrase change the header and the keyring again
   * (without the pending header). No blob.
   */
  written: string[];
  /** Devices the new epoch is wrapped for. */
  devices: string[];
  /**
   * False when the keyring read back right after the commit was not this
   * one (third review 12.11, N2): the storage let another device's key
   * change replace it. `warning` says the revocation may not have taken
   * effect; the next round repairs it or stops with `KeyringForkError`.
   */
  confirmed: boolean;
  warning?: string;
  /** The re-key came from an unverified device (`dropDevices`): only the passphrase (and `enroll`) can open the new epoch; other devices pair again (`DroppedFromVaultError` on them). */
  dropped?: true;
}

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deleted: number;
  /** Paths whose conflict was settled (by the resolver or automatically). */
  conflicts: string[];
  /** Paths held for a later round (a cancelled dialog, or a file edited mid-round). */
  held: string[];
  /** Manifest counter after the round. */
  counter: number;
  /** Manifest writes that lost a compare-and-swap and were retried. */
  retries: number;
  /** True when the round gave up after `maxAttempts` lost races; nothing is lost, run it again. */
  incomplete: boolean;
  /**
   * Local changes not uploaded because this device's freshness isn't
   * verified (third review 12.11, N6): they wait on this device until it is
   * paired or confirmed. Absent when nothing waits.
   */
  waiting?: string[];
  /** A re-key froze the manifest and has not committed yet: pulled, but local changes wait. */
  rekeyPending?: boolean;
  /**
   * This device's own list of the devices it revoked didn't verify (seventh
   * review 12.11, G5), so it was set aside: the device now checks keyrings
   * against the sealed revoked lists of the keyrings it adopted. Say so, and
   * ask the user to check the device list on a device they trust.
   */
  revokedListReset?: true;
}

export interface E2eeSyncOptions {
  provider: SyncProvider;
  keys: VaultKeys;
  local: LocalFiles;
  store: SyncStateStore;
  resolver?: ConflictResolver;
  /** Manifest compare-and-swap attempts per round (default 8). */
  maxAttempts?: number;
  /** Clock, for conflict-copy names, pairing codes and the freeze wait (tests). */
  now?: () => number;
  /**
   * How this device opens newer keyrings (plan W1.7). Default: the
   * passphrase's wrap key when the keys have one. A device opened with its
   * own key passes `{device, identity}`.
   */
  access?: KeyAccess;
}

/** The next manifest after `m` (whose digest is `digest`): counter + 1, `m` in the history, not frozen. */
export function successor(m: Manifest, digest: string): Manifest {
  const rest: Manifest = { ...m };
  delete rest.frozen;
  return {
    ...rest,
    protocol: PROTOCOL_VERSION,
    counter: m.counter + 1,
    files: pathRecord(m.files),
    history: m.counter > 0 ? [...m.history, [m.counter, digest] as [number, string]].slice(-HISTORY_LENGTH) : [],
  };
}

export function sameEntry(a: ManifestEntry | undefined, b: ManifestEntry | undefined): boolean {
  if (!a || !b) return a === b;
  return a.ver === b.ver && a.rev === b.rev && !!a.deleted === !!b.deleted;
}

export function liveHash(e: ManifestEntry | undefined): string | null {
  return e && !e.deleted ? e.hash : null;
}

export const sameAnchor = (a: RingAnchor | undefined, b: RingAnchor) => !!a && a.epoch === b.epoch && a.rev === b.rev && a.digest === b.digest;

/**
 * The KDF family of the stored header (RR-10: a passphrase change keeps it),
 * only when its MAC verifies under this device's header key (fifth review
 * 12.11, F5): the provider can't pick the next passphrase's KDF. Null when
 * it doesn't verify (or isn't there): the caller then uses Argon2id.
 */
export async function verifiedKdf(obj: StoredObject | null, keys: VaultKeys): Promise<{ alg: string; iterations?: number } | null> {
  if (!obj) return null;
  try {
    const h = decodeHeader(obj.data, { minPbkdf2Iterations: 1 });
    if (h.vaultId !== keys.vaultId || !(await headerMacValid(h, keys.header))) return null;
    return { alg: h.kdf.alg, ...(h.kdf.alg === "pbkdf2-sha256" ? { iterations: h.kdf.iterations } : {}) };
  } catch {
    return null;
  }
}

/** Devices of `ring` that are on `list` by id or by key (F2). */
export function readmitted(list: Array<{ device: string; recipient?: string }>, enrolled: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const r of list) {
    for (const [id, rec] of Object.entries(enrolled)) if (id === r.device || (r.recipient && rec === r.recipient)) out.add(id);
  }
  return [...out];
}

/** How long after a revocation a refused keyring is reported as "the revocation may have been undone" (F2). */
export const REVOCATION_AT_RISK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a key change from this device held back by another's freeze
 * counts as the same key change (seventh review 12.11, G1): retried within
 * this, it waits FREEZE_TTL_MS from its first refusal in all; after it, a
 * new attempt waits in full again.
 */
export const REKEY_BLOCK_WINDOW_MS = 24 * 60 * 60 * 1000;

