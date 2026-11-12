/**
 * The encrypted sync engine (plan 3.4).
 *
 * One round, `E2eeSync.sync()`:
 *
 *   1. Read the manifest and its etag; decrypt and authenticate it; refuse it
 *      if it is older than the newest one this device has verified
 *      (`checkFreshness` — rollback / replay protection).
 *   2. Pull: for every path the manifest changed since this device's base,
 *      apply the change locally, or settle a conflict (conflict.ts).
 *   3. Push: upload every local change as a new immutable blob (a fresh
 *      opaque name per version, so concurrent devices never overwrite each
 *      other's blobs), then write the new manifest — counter + 1 — with
 *      compare-and-swap on the etag read in step 1.
 *   4. If the manifest changed in between (`PreconditionFailedError`), go back
 *      to 1 with the newer manifest: pull, merge, retry. Two devices pushing
 *      from the same version N both end up in the manifest.
 *
 * Plan W1.8: every step is reported through `onEvent` (activity panel, time
 * estimate), the paths held and why are kept for `fileStates()`, and paths
 * this device's rules exclude (`exclude`) are skipped in both directions:
 * an excluded local file is never read for upload.
 *
 * Keys (plan W1.7): at the start of a round the device brings its keys up to
 * the keyring (./keyring.ts): a keyring that doesn't descend from the one it
 * verified last is a rollback or a fork and refused, a missing wrap means
 * this device was revoked. `rekey()` starts a new epoch; blobs keep the
 * epoch they were written in (`e` in their manifest entry).
 *
 * A re-key has one commit point, the keyring write (re-review 12.11, RR-3):
 *
 *   1. freeze: the manifest of epoch n is written once more, marked frozen
 *      (compare-and-swap), so nobody adds to it any more;
 *   2. the manifest of epoch n + 1 — the frozen one's successor, sealed with
 *      the new keys — is created under its random label (unreadable and
 *      unnamed until the keyring names it; deleted if the commit loses);
 *   3. commit: the keyring for n + 1, compare-and-swap on the keyring this
 *      device verified. From here on the vault is at n + 1;
 *   4. a passphrase change writes the new header, then rewrites the keyring
 *      without the pending header (any device at n + 1 finishes this).
 *
 * A freeze is called off through the keyring too (RR-4): a device that has
 * waited `FREEZE_TTL_MS` on its own clock for a frozen manifest rewrites the
 * keyring at the same epoch, listing the freeze as aborted — so the
 * re-keyer's commit, a compare-and-swap on the keyring, fails if anybody
 * wrote over its freeze. At epoch 0 (no keyring yet) it finishes the re-key
 * instead, for the passphrase alone. Blobs replaced by a commit over a freeze
 * are deleted only a round later.
 *
 * Interruption at any point loses nothing: blobs are written before the
 * manifest that references them, the base is saved per file after the local
 * write, and the next round recognises work that was already done (same hash
 * on both sides). Blobs uploaded by an interrupted round are recorded as
 * pending and deleted once they are known to be unreferenced; blobs replaced
 * by a commit are deleted after it.
 */

import { equalBytes, fromB64u, fromUtf8, randomBytes, sha256Hex, toB64u } from "./bytes";
import { conflictCopyPath, keepBothResolver, type ConflictResolver } from "./conflict";
import { createHeader, decodeHeader, encodeHeader, HEADER_NAME, PROTOCOL_VERSION, rekeyHeader, unlockHeader, WrongPassphraseError, type VaultHeader } from "./header";
import { PBKDF2_DEFAULT_ITERATIONS, PBKDF2_MIN_ITERATIONS, type KdfPolicy } from "./kdf";
import { blobKey, DecryptError, epochKeys, seal, unseal, type VaultKeys } from "./keys";
import {
  ABORTED_LENGTH,
  anchorOf,
  checkDeviceEnrolled,
  checkedAnchorOf,
  confirmCommit,
  decodeKeyring,
  enrollDevice,
  KEYRING_NAME,
  KeyringCommitLostError,
  KeyringForkError,
  keyringContents,
  keyringDigest,
  keysFromKeyring,
  prepareEpoch,
  PreReleaseKeyringError,
  readKeyring,
  refreshKeys,
  rewriteKeyring,
  sealAnchor,
  TamperedWrapError,
  unwrapSecret,
  verifyAnchor,
  type KeyAccess,
  type RingAnchor,
} from "./keyring";
import { isSyncedPath, type LocalFile, type LocalFiles } from "./localFiles";
import {
  blobName,
  checkFreshness,
  emptyManifest,
  FREEZE_TTL_MS,
  FROZEN_PROTOCOL,
  HISTORY_LENGTH,
  manifestName,
  manifestNameFor,
  pathRecord,
  openManifest,
  RollbackError,
  sealManifest,
  type FreshnessAnchor,
  type Manifest,
  type ManifestEntry,
} from "./manifest";
import {
  createPairingAnswer,
  createPairingCode,
  createPairingRequest,
  isPairingAnswer,
  PAIRING_REQUEST_TTL_MS,
  PAIRING_TTL_MS,
  PairingEpochError,
  PairingError,
  readPairingAnswer,
  readPairingCode,
  readPairingRequest,
  type PairingAnchor,
} from "./pairing";
import { PreconditionFailedError, proveCas, type StoredObject, type SyncProvider } from "./provider";
import type { DeviceState, FreshnessSource, SyncStateStore } from "./state";
import type { SyncEvent, SyncEventListener } from "./activity";
import { computeFileStates, liveHash, sameEntry, type ExcludeRule, type FileStatus, type HoldReason } from "./status";

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

/** A blob the manifest names is missing (replaced by a newer commit meanwhile): the round restarts. */
class BlobMissingError extends Error {}

/** Files above this size keep no ancestor bytes for merges (attachments; plan W1.8). */
export const BASE_BYTES_LIMIT = 4 * 1024 * 1024;

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
 * (`KeyringForkError`). `E2eeSync` checks the same at every round.
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
  // Only a keyring sealed with the secret the wrap holds says who is enrolled: not on it is revoked.
  await checkDeviceEnrolled(ring.file, keys, device);
  // Keys the storage made for this device's public key can't hold the secret of the keyring it verified (N1).
  if (state?.ring) await verifyAnchor(keys, state.ring);
  return { keys };
}

export interface RekeyRequest {
  revoke?: string[];
  enroll?: Record<string, string>;
  newPassphrase?: string;
  pbkdf2Iterations?: number;
  kdf?: "argon2id" | "pbkdf2-sha256";
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
  /** The re-key came from an unverified device: only the passphrase (and `enroll`) can open the new epoch; other devices enroll again. */
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
  /** This device's selective-sync rule (plan W1.8): the reason a path is kept out, or null. Read every round. */
  exclude?: ExcludeRule;
  /** Each step of a round, as it happens (plan W1.8). A listener that throws is ignored. */
  onEvent?: SyncEventListener;
  /**
   * How this device opens newer keyrings (plan W1.7). Default: the
   * passphrase's wrap key when the keys have one. A device opened with its
   * own key passes `{device, identity}`.
   */
  access?: KeyAccess;
}

/** The next manifest after `m` (whose digest is `digest`): counter + 1, `m` in the history, not frozen. */
function successor(m: Manifest, digest: string): Manifest {
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

const sameAnchor = (a: RingAnchor | undefined, b: RingAnchor) => !!a && a.epoch === b.epoch && a.rev === b.rev && a.digest === b.digest;

/** The KDF family of a stored header, read without the policy (RR-10: a passphrase change keeps it). */
function kdfOf(obj: StoredObject | null): { alg: string; iterations?: number } | null {
  if (!obj) return null;
  try {
    const kdf = (JSON.parse(fromUtf8(obj.data)) as { kdf?: { alg?: unknown; iterations?: unknown } }).kdf;
    return typeof kdf?.alg === "string" ? { alg: kdf.alg, ...(typeof kdf.iterations === "number" ? { iterations: kdf.iterations } : {}) } : null;
  } catch {
    return null;
  }
}

export class E2eeSync {
  private readonly o: Required<Omit<E2eeSyncOptions, "resolver" | "access">> & { resolver: ConflictResolver; access: KeyAccess | null };
  private running: Promise<unknown> = Promise.resolve();
  private state: DeviceState | null = null;
  /** Digest of the manifest `readManifest` returned last (the parent of the next commit). */
  private remoteDigest = "";
  /** The keyring (digest) whose pending passphrase change this device already looked at (resumeEpoch). */
  private resumed = "";
  /** Opaque names already computed (HMAC is cheap, but not free over thousands of rounds). */
  private readonly names = new Map<string, string>();
  /** What the last round saw, for `fileStates()` (plan W1.8). */
  private lastLocal: LocalFile[] | null = null;
  private lastRemote: Manifest | null = null;
  /** Paths the last round held, and why. */
  private holds = new Map<string, HoldReason>();

  constructor(opts: E2eeSyncOptions) {
    // `??`, not a spread: an option passed as undefined must still get its default.
    this.o = {
      ...opts,
      resolver: opts.resolver ?? keepBothResolver,
      maxAttempts: opts.maxAttempts ?? 8,
      now: opts.now ?? (() => Date.now()),
      exclude: opts.exclude ?? (() => null),
      onEvent: opts.onEvent ?? (() => undefined),
      access: opts.access ?? (opts.keys.wrap ? { wrap: opts.keys.wrap } : null),
    };
  }

  private emit(e: SyncEvent): void {
    try {
      this.o.onEvent(e);
    } catch {
      /* the activity panel must never break a round */
    }
  }

  private hold(held: Set<string>, path: string, reason: HoldReason): void {
    held.add(path);
    this.holds.set(path, reason);
    this.emit({ kind: "held", at: this.o.now(), path, reason });
  }

  /** The local files, for this round and for `fileStates()`. */
  private async listLocal(): Promise<LocalFile[]> {
    const list = (await this.o.local.list()).filter((f) => isSyncedPath(f.path));
    this.lastLocal = list;
    return list;
  }

  /**
   * The sync state of every file and folder as of the last round (plan
   * W1.8). `rescan` lists the local files again first, so edits made since
   * the round show as pending.
   */
  async fileStates(opts: { rescan?: boolean } = {}): Promise<Map<string, FileStatus>> {
    const s = await this.loadState();
    if (opts.rescan || !this.lastLocal) await this.listLocal();
    return computeFileStates({
      local: new Map((this.lastLocal ?? []).map((f) => [f.path, f])),
      base: s.base,
      remote: this.lastRemote?.files ?? null,
      holds: this.holds,
      exclude: this.o.exclude,
    });
  }

  /** The keys this device uses now (they change at a re-key). */
  keys(): VaultKeys {
    return this.o.keys;
  }

  /** Adopt keys this device wrote or verified itself, and remember their keyring as verified. */
  private async adopt(keys: VaultKeys): Promise<void> {
    const s = await this.loadState();
    this.o.keys = keys;
    if (keys.wrap && (!this.o.access || "wrap" in this.o.access)) this.o.access = { wrap: keys.wrap };
    if (keys.ring) s.ring = await checkedAnchorOf(keys);
    s.epoch = Math.max(s.epoch ?? 0, keys.epoch);
    await this.save();
  }

  /** Step 0: bring the keys up to the keyring, and finish what a cut-off passphrase change left. */
  private async refresh(): Promise<void> {
    if (!this.o.access) return;
    const s = await this.loadState();
    // N1: the keys in memory must hold the secret of the keyring this device
    // verified. A device opened with its own key may hold keys the provider
    // made for its public recipient; the anchor's check is what they lack.
    if (s.ring && !(await verifyAnchor(this.o.keys, s.ring)) && s.ring.epoch === this.o.keys.epoch) {
      s.ring = await sealAnchor(s.ring, this.o.keys.secret, this.o.keys.vaultId); // a state from before N1
      await this.save();
    }
    let next: VaultKeys;
    try {
      next = await refreshKeys(this.o.provider, this.o.keys, this.o.access, s.ring ?? Math.max(s.epoch ?? 0, this.o.keys.epoch));
    } catch (e) {
      if (e instanceof KeyringForkError) await this.reapplyRevocation(e);
      throw e;
    }
    if (s.ring) await verifyAnchor(next, s.ring);
    this.o.keys = next;
    let dirty = false;
    if (next.ring?.unproven && s.freshness !== "unverified") {
      // Too far behind to prove the keyring descends from the one we verified.
      s.freshness = "unverified";
      dirty = true;
    }
    if (next.ring && !sameAnchor(s.ring, anchorOf(next))) {
      s.ring = await checkedAnchorOf(next);
      dirty = true;
    }
    if (s.rekeyed && next.epoch > s.rekeyed.epoch) {
      delete s.rekeyed; // a later epoch descends from it: that re-key stood
      dirty = true;
    }
    if ((s.epoch ?? 0) < next.epoch) {
      s.epoch = next.epoch;
      dirty = true;
    }
    if (dirty) await this.save();
    await this.resumeEpoch();
  }

  /**
   * Finish a passphrase change that was cut off (idempotent): write the new
   * header the keyring carries, then rewrite the keyring without it (RR-6),
   * so the old passphrase's way back to the epoch before is gone.
   */
  private async resumeEpoch(): Promise<void> {
    const k = this.o.keys;
    const ring = k.ring;
    if (!ring?.header || ring.preRelease || this.resumed === ring.digest) return;
    const cur = await this.o.provider.get(HEADER_NAME);
    let landed = !!cur && (await sha256Hex(cur.data)) === ring.header;
    if (!landed) {
      const kr = await readKeyring(this.o.provider);
      const bytes = kr?.digest === ring.digest && kr.file.header ? fromB64u(kr.file.header) : null;
      if (bytes && (await sha256Hex(bytes)) === ring.header) {
        landed = await this.o.provider.put(HEADER_NAME, bytes, cur ? { ifMatch: cur.etag } : { ifNoneMatch: "*" }).then(
          () => true,
          (e) => {
            if (!(e instanceof PreconditionFailedError)) throw e;
            return false;
          },
        );
      }
    }
    if (landed) await this.finishPassphraseChange();
    this.resumed = ring.digest;
  }

  /** The header of a passphrase change is written: the keyring drops it, and the previous keyring with it. */
  private async finishPassphraseChange(): Promise<boolean> {
    try {
      const next = await rewriteKeyring(this.o.provider, this.o.keys, this.o.access, (c, f) => {
        const contents = { ...c };
        delete contents.header;
        const file = { ...f };
        delete file.header;
        delete file.prev;
        return { contents, file };
      });
      await this.adopt(next);
      return true;
    } catch (e) {
      if (e instanceof PreconditionFailedError || e instanceof KeyringCommitLostError) return false; // another device did; the next refresh sees it
      throw e;
    }
  }

  /**
   * Start a new key epoch (plan W1.7): re-key, revoke devices, enroll
   * devices, change the passphrase. Writes the frozen manifest, the new
   * epoch's manifest and the keyring (the commit) and, for a new passphrase,
   * the header. No blob is downloaded or uploaded: older blobs keep their
   * epoch's key.
   *
   * On a device that can't verify it has the latest keys (RR-5) the new
   * epoch is wrapped for the passphrase and `enroll` only (`dropped`): it
   * can't vouch for the device list. Refused on a provider whose conditional
   * writes don't hold (`CasUnsupportedError`, RR-7) and while a pairing code
   * or answer from this device is valid (`PairingPendingError`, N3). The
   * keyring is read back after the commit (`confirmed`, N2). A passphrase change
   * keeps the header's KDF family unless `kdf` asks for another (RR-10).
   * On keys from a pre-release keyring (`unlockVault(…, {resetPreReleaseKeyring})`)
   * this is the reset: the new epoch is wrapped for the passphrase and `enroll` only.
   */
  rekey(opts: RekeyRequest = {}): Promise<RekeyResult> {
    return this.exclusive(() => this.rekeyNow(opts));
  }

  /** No key change while a pairing code or answer from this device is valid (N3). */
  private async checkNoPairingPending(): Promise<void> {
    const s = await this.loadState();
    if (s.pairingUntil !== undefined && this.o.now() < s.pairingUntil) throw new PairingPendingError(s.pairingUntil);
  }

  private async rekeyNow(opts: RekeyRequest): Promise<RekeyResult> {
    const s = await this.loadState();
    await this.refresh();
    const previous = this.o.keys;
    const reset = !!previous.ring?.preRelease;
    // A device that can't verify it has the latest keys can't vouch for the
    // device list either (RR-5, third review N3): its re-key wraps the new
    // epoch for the passphrase and the devices it enrolls now, no other.
    // Served an old epoch, it so never wraps for a device revoked meanwhile.
    const dropDevices = !reset && s.freshness === "unverified";
    await this.checkNoPairingPending();
    await proveCas(this.o.provider);
    const current = await readKeyring(this.o.provider);
    if (current ? current.file.epoch !== previous.epoch || current.digest !== previous.ring?.digest : previous.epoch !== 0) throw new PreconditionFailedError(KEYRING_NAME);
    const written: string[] = [];
    let header: { header: VaultHeader; master: Uint8Array } | null = null;
    if (opts.newPassphrase !== undefined) {
      const was = kdfOf(await this.o.provider.get(HEADER_NAME));
      // The KDF family stays what it was (PBKDF2 stays PBKDF2) unless `kdf` asks for another.
      let pbkdf2: number | undefined = opts.pbkdf2Iterations;
      if (pbkdf2 === undefined && (opts.kdf === "pbkdf2-sha256" || (opts.kdf === undefined && was?.alg === "pbkdf2-sha256"))) pbkdf2 = Math.max(PBKDF2_DEFAULT_ITERATIONS, was?.iterations ?? 0);
      header = await rekeyHeader(previous.vaultId, opts.newPassphrase, pbkdf2 !== undefined ? { pbkdf2Iterations: pbkdf2 } : {});
    }
    const oldName = await this.manifestObject();
    const now = this.o.now();

    // 1. Freeze this epoch's manifest: nobody adds to it once it is copied.
    //    A stale freeze (an earlier re-key that never committed) is frozen again.
    let frozen: Manifest;
    let frozenDigest: string;
    for (let attempt = 0; ; attempt++) {
      const { manifest: m, etag } = await this.readManifest();
      frozen = { ...successor(m, this.remoteDigest), protocol: FROZEN_PROTOCOL, frozen: { epoch: previous.epoch + 1, at: now, by: s.deviceId } };
      const sealed = await sealManifest(previous, frozen, oldName);
      try {
        await this.o.provider.put(oldName, sealed.bytes, etag ? { ifMatch: etag } : { ifNoneMatch: "*" });
      } catch (e) {
        if (!(e instanceof PreconditionFailedError) || attempt >= this.o.maxAttempts) throw e;
        continue;
      }
      frozenDigest = sealed.digest;
      break;
    }
    written.push(oldName);

    // 2. The new epoch's manifest, under its random label, before anything names it.
    const prepared = await prepareEpoch(current, previous, {
      revoke: opts.revoke,
      enroll: opts.enroll,
      newPassphraseMaster: header?.master,
      newHeader: header ? encodeHeader(header.header) : undefined,
      carry: { label: previous.ring?.manifest ?? "manifest", epoch: previous.epoch, digest: frozenDigest },
      dropDevices,
      now: this.o.now,
    });
    const keys = prepared.keys;
    const name = await manifestName(keys);
    const next = successor(frozen, frozenDigest);
    const sealedNext = await sealManifest(keys, next, name);
    await this.o.provider.put(name, sealedNext.bytes, { ifNoneMatch: "*" });
    written.push(name);

    // 3. Commit: the keyring, compare-and-swap on the one this device verified.
    //    Lost: someone re-keyed, enrolled or called this freeze off first.
    try {
      await this.o.provider.put(KEYRING_NAME, prepared.bytes, current ? { ifMatch: current.etag } : { ifNoneMatch: "*" });
    } catch (e) {
      if (e instanceof PreconditionFailedError) await this.o.provider.delete(name).catch(() => undefined);
      throw e; // anything else: the outcome is unknown, and the manifest stays for the keyring that may have landed
    }
    // Read it back (third review 12.11, N2): a storage that passed the
    // probe can still drop the condition on this write, and let another
    // device's key change replace this one. Then the result says so
    // (`confirmed: false`): the revocation may not have taken effect.
    let lost: KeyringCommitLostError | null = null;
    try {
      await confirmCommit(this.o.provider, keys, prepared.bytes, { wrap: keys.wrap! }, opts.revoke ?? []);
    } catch (e) {
      if (!(e instanceof KeyringCommitLostError)) throw e;
      // The write went through and was replaced: this device keeps its
      // commit as the keyring it verified, so the next round sees the
      // replacement as a fork — and, when it is another device's re-key
      // from the same keyring, revokes again on top of it (reapplyRevocation).
      lost = e;
    }
    written.push(KEYRING_NAME);
    const anchorBefore = s.anchor;
    s.anchor = { counter: next.counter, digest: sealedNext.digest };
    delete s.frozenSeen;
    s.rekeyed = { epoch: keys.epoch, digest: keys.ring!.digest, parent: current?.digest ?? null, parentEpoch: previous.epoch, revoked: [...new Set(opts.revoke ?? [])], manifest: anchorBefore };
    await this.adopt(keys);

    // 4. A passphrase change: the new header, then the keyring without it.
    if (header) {
      const cur = await this.o.provider.get(HEADER_NAME);
      await this.o.provider.put(HEADER_NAME, encodeHeader(header.header), cur ? { ifMatch: cur.etag } : { ifNoneMatch: "*" });
      written.push(HEADER_NAME);
      if (await this.finishPassphraseChange()) written.push(KEYRING_NAME);
    }
    this.resumed = this.o.keys.ring?.digest ?? "";
    return { epoch: keys.epoch, counter: next.counter, written, devices: prepared.devices, confirmed: !lost, ...(lost ? { warning: lost.message } : {}), ...(dropDevices ? { dropped: true as const } : {}) };
  }

  /**
   * N2: this device's re-key, confirmed when it was written, was replaced
   * by a keyring at the same epoch made from the same parent — another
   * device's re-key that the storage let through without its
   * compare-and-swap. That device didn't know of this one's revocations, so
   * it wrapped the new epoch for the revoked devices again. Revoke them
   * again on top of it (it descends from the keyring this device verified,
   * and a holder of that epoch's secret made it), then throw a
   * `KeyringForkError` naming them: what was written in between may be
   * readable by them. Returns quietly when that isn't the case.
   */
  private async reapplyRevocation(fork: KeyringForkError): Promise<void> {
    const s = await this.loadState();
    const r = s.rekeyed;
    const access = this.o.access;
    if (!r || !r.revoked.length || fork.revocationReapplied.length || !access || !("wrap" in access) || s.freshness === "unverified") return;
    const k = await readKeyring(this.o.provider);
    if (!k || k.file.epoch !== r.epoch || k.digest === r.digest || k.file.vaultId !== this.o.keys.vaultId) return;
    let sibling: VaultKeys;
    let c: Awaited<ReturnType<typeof keyringContents>>;
    try {
      sibling = await keysFromKeyring(k.file, await unwrapSecret(k.file, access), this.o.keys, { digest: k.digest });
      c = await keyringContents(k.file, sibling);
    } catch {
      return;
    }
    const mine = this.o.keys.olderSecrets.get(r.parentEpoch);
    const theirs = sibling.olderSecrets.get(r.parentEpoch);
    const fromParent = r.parent !== null && c.chain.some(([e, , d]) => e === r.parentEpoch && d === r.parent);
    if (!fromParent || c.chain.some(([, , d]) => d === r.digest) || !mine || !theirs || !equalBytes(mine, theirs)) return;
    const missing = r.revoked.filter((d) => !c.revoked.some((x) => x.device === d));
    if (!missing.length) return;
    this.o.keys = sibling;
    s.ring = await checkedAnchorOf(sibling);
    // The manifest this device trusted before its re-key: the sibling's manifest descends from it, not from this device's own.
    s.anchor = r.manifest;
    delete s.rekeyed;
    await this.save();
    let done: RekeyResult;
    try {
      done = await this.rekeyNow({ revoke: missing });
    } catch {
      return;
    }
    throw new KeyringForkError(`another keyring at epoch ${r.epoch} replaced this device's`, missing, done.epoch);
  }

  /**
   * Enroll a device at the current epoch (no re-key): its age recipient
   * goes into the sealed list and gets a wrap of the epoch secret. Refused on
   * an unverified device and on a provider without working conditional
   * writes, like `rekey`.
   */
  enroll(device: string, recipient: string): Promise<void> {
    return this.exclusive(async () => {
      const s = await this.loadState();
      await this.refresh();
      if (this.o.keys.ring?.preRelease) throw new PreReleaseKeyringError();
      if (s.freshness === "unverified") throw new UnverifiedDeviceError("enroll devices");
      await this.checkNoPairingPending();
      await proveCas(this.o.provider);
      await this.adopt(await enrollDevice(this.o.provider, this.o.keys, device, recipient, this.o.access));
    });
  }

  private async loadState(): Promise<DeviceState> {
    if (this.state) return this.state;
    const loaded = await this.o.store.load();
    this.state = loaded
      ? { ...loaded, base: pathRecord(loaded.base) }
      : { deviceId: toB64u(randomBytes(9)), anchor: null, freshness: "unverified", base: pathRecord(), pending: [] };
    return this.state;
  }

  private async save(): Promise<void> {
    if (this.state) await this.o.store.save(this.state);
  }

  /** Serialise calls: one round (or pairing) at a time per device. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.running.then(fn, fn);
    this.running = next.catch(() => undefined);
    return next;
  }

  /** How this device knows its view of the vault is current. */
  async freshness(): Promise<{ source: FreshnessSource; verified: boolean; counter: number | null }> {
    const s = await this.loadState();
    return { source: s.freshness, verified: s.freshness !== "unverified", counter: s.anchor?.counter ?? null };
  }

  /** The creator of the vault anchors on the manifest it just wrote. */
  markCreated(anchor: FreshnessAnchor): Promise<void> {
    return this.exclusive(async () => {
      const s = await this.loadState();
      s.anchor = anchor;
      s.freshness = "created";
      await this.save();
    });
  }

  /**
   * A pairing code for a new device, carrying this device's newest verified
   * anchors: the manifest and the keyring. An unverified (TOFU) device cannot
   * issue one: it would pass on a state nobody verified as if it had been.
   */
  async pairingCode(): Promise<string> {
    const s = await this.loadState();
    if (!s.anchor) throw new PairingError("Sync once before pairing another device");
    if (s.freshness === "unverified") {
      throw new PairingError("This device's freshness is not verified: pair it or confirm it before pairing others");
    }
    const now = this.o.now();
    const code = await createPairingCode(this.o.keys, s.anchor, now, anchorOf(this.o.keys));
    s.pairingUntil = Math.max(s.pairingUntil ?? 0, now + PAIRING_TTL_MS); // N3: no key change while it is valid
    await this.save();
    return code;
  }

  /**
   * Two-way pairing, step 1, on the new device (third review 12.11, N3): a
   * request naming the keyring and manifest this device sees now. The user
   * enters it on an existing device (`answerPairing`), and that device's
   * answer here (`pair`).
   */
  pairingRequest(): Promise<string> {
    return this.exclusive(async () => {
      await this.refresh();
      const s = await this.loadState();
      const { code, request } = await createPairingRequest(this.o.keys, s.anchor, this.o.now(), anchorOf(this.o.keys));
      s.pairRequest = request;
      await this.save();
      return code;
    });
  }

  /**
   * Two-way pairing, step 2, on an existing, verified device: check the new
   * device's request against this device's *current* keyring and manifest —
   * read now, not when anything was issued — and answer with them, bound to
   * the request. A new device shown an older epoch or revision is refused
   * here (`PairingEpochError("older")`), whichever device made the newer one.
   */
  answerPairing(request: string): Promise<string> {
    return this.exclusive(async () => {
      const s = await this.loadState();
      if (s.freshness === "unverified") throw new PairingError("This device's freshness is not verified: pair it or confirm it before pairing others");
      await this.refresh();
      await this.readManifest();
      if (!s.anchor) throw new PairingError("Sync once before pairing another device");
      const req = await readPairingRequest(this.o.keys, request);
      const mine = anchorOf(this.o.keys);
      if (req.ring.epoch === mine.epoch && req.ring.digest !== mine.digest) {
        if (req.ring.rev < mine.rev) {
          throw new PairingEpochError("older", `The new device is shown an older version of the keys (${mine.epoch}.${req.ring.rev}; this device is at ${mine.epoch}.${mine.rev}): the storage is showing it old keys. Don't pair it; sync it and try again.`);
        }
        if (req.ring.rev === mine.rev) throw new KeyringForkError(`the new device sees another keyring at ${mine.epoch}.${mine.rev}`);
        throw new PairingEpochError("newer", "The new device sees newer keys than this one: sync this device, then enter the request again");
      }
      if (req.manifest && req.manifest.counter > s.anchor.counter) throw new PairingEpochError("newer", "The new device sees newer notes than this one: sync this device, then enter the request again");
      const now = this.o.now();
      const answer = await createPairingAnswer(this.o.keys, req, s.anchor, now, mine);
      s.pairingUntil = Math.max(s.pairingUntil ?? 0, now + PAIRING_REQUEST_TTL_MS);
      await this.save();
      return answer;
    });
  }

  /** Accept a pairing code from an existing device: anchors the rollback guards (manifest and keyring). */
  pair(code: string): Promise<void> {
    return this.exclusive(async () => {
      const s = await this.loadState();
      const answer = isPairingAnswer(code);
      // A one-way code, or the answer to this device's own request (N3).
      const got: PairingAnchor = answer ? await readPairingAnswer(this.o.keys, code, s.pairRequest ?? null, this.o.now()) : await readPairingCode(this.o.keys, code, this.o.now());
      // The keyring: same epoch (readPairingCode checks it); the same revision must be the same keyring.
      const mine = s.ring ?? anchorOf(this.o.keys);
      if (got.ring.epoch === mine.epoch && got.ring.rev === mine.rev && mine.digest && got.ring.digest !== mine.digest) {
        throw new KeyringForkError(`the pairing code names another keyring at ${mine.epoch}.${mine.rev}`);
      }
      const ringNewer = got.ring.epoch > mine.epoch || (got.ring.epoch === mine.epoch && got.ring.rev > mine.rev);
      // Never move the anchor backwards; equal counters must be the same manifest.
      if (s.anchor && got.counter === s.anchor.counter && got.digest !== s.anchor.digest) {
        throw new RollbackError(s.anchor.counter, got.counter, "fork");
      }
      if (s.anchor && got.counter < s.anchor.counter) {
        // An older code cannot vouch for the newer state this device already
        // holds (it may come from another fork). A verified device needs
        // nothing from it; an unverified one needs a current code.
        if (s.freshness !== "unverified") return;
        throw new PairingError("The pairing code is older than this device's state; create a new code on the other device");
      }
      s.anchor = { counter: got.counter, digest: got.digest };
      if (got.ring.epoch > 0 && (ringNewer || !s.ring)) s.ring = await sealAnchor(got.ring, this.o.keys.secret, this.o.keys.vaultId);
      s.freshness = "paired";
      if (answer) delete s.pairRequest;
      await this.save();
    });
  }

  /** The user confirmed by hand (e.g. compared with another device) that the vault is current. */
  confirmFreshness(): Promise<void> {
    return this.exclusive(async () => {
      const s = await this.loadState();
      if (!s.anchor) throw new Error("Nothing to confirm yet: sync once first");
      if (s.freshness === "unverified") s.freshness = "confirmed";
      await this.save();
    });
  }

  sync(): Promise<SyncResult> {
    return this.exclusive(async () => {
      this.emit({ kind: "start", at: this.o.now() });
      try {
        const r = await this.round();
        this.emit({ kind: "done", at: this.o.now(), uploaded: r.uploaded, downloaded: r.downloaded, deleted: r.deleted, conflicts: r.conflicts.length, held: r.held.length, incomplete: r.incomplete });
        return r;
      } catch (e) {
        this.emit({ kind: "error", at: this.o.now(), message: (e as Error)?.message ?? String(e) });
        throw e;
      }
    });
  }

  private async setBase(path: string, entry: ManifestEntry, data: Uint8Array | null): Promise<void> {
    const s = await this.loadState();
    // Ancestor bytes are kept for the three-way merge of a note; a large
    // file (an attachment) keeps only its manifest entry, so a first sync of
    // a big vault does not hold a second copy of it (plan W1.8 benchmark).
    await this.o.store.setBase(path, entry.deleted || !data || data.length > BASE_BYTES_LIMIT ? null : data);
    s.base[path] = entry;
    await this.save();
  }

  private async blob(path: string, rev: string): Promise<string> {
    const k = `${path}\u0000${rev}`;
    let n = this.names.get(k);
    if (n === undefined) {
      n = await blobName(this.o.keys, path, rev);
      if (this.names.size > 50_000) this.names.clear();
      this.names.set(k, n);
    }
    return n;
  }

  private async manifestObject(): Promise<string> {
    const key = `\u0000manifest\u0000${this.o.keys.ring?.manifest ?? "manifest"}`;
    let n = this.names.get(key);
    if (n === undefined) {
      n = await manifestName(this.o.keys);
      this.names.set(key, n);
    }
    return n;
  }

  /**
   * The stored ancestor of `path`, only if it is the version `entry` names:
   * bytes and metadata are saved in two steps, and an interruption between
   * them must not hand the merge a wrong ancestor.
   */
  private async baseBytes(path: string, entry: ManifestEntry): Promise<Uint8Array | null> {
    const data = await this.o.store.getBase(path);
    return data && (await sha256Hex(data)) === entry.hash ? data : null;
  }

  private async fetchBlob(path: string, e: ManifestEntry): Promise<Uint8Array> {
    const name = await this.blob(path, e.rev);
    const obj = await this.o.provider.get(name);
    if (!obj) throw new BlobMissingError();
    const data = await unseal(blobKey(this.o.keys, e.e), this.o.keys.vaultId, "blob", name, obj.data);
    if ((await sha256Hex(data)) !== e.hash) throw new DecryptError("A file does not match its manifest entry");
    return data;
  }

  /**
   * This epoch's manifest is missing or isn't one (junk under its name, RR-3):
   * re-create it from the frozen manifest the keyring carries, exactly that
   * one — only the epoch's members could have written a valid manifest, so
   * anything that doesn't open is replaced. Never behind this device's anchor.
   */
  private async recoverManifest(name: string, junk: StoredObject | null): Promise<{ obj: StoredObject; manifest: Manifest; digest: string } | null> {
    const k = this.o.keys;
    const c = k.ring?.carry;
    const old = c && c.epoch !== k.epoch ? k.olderSecrets.get(c.epoch) : undefined;
    if (!c || !old) return null;
    const oldKeys: VaultKeys = { ...k, manifest: (await epochKeys(old, k.vaultId)).manifest };
    const oldName = await manifestNameFor(k, c.label);
    const obj = await this.o.provider.get(oldName);
    const opened = obj ? await openManifest(oldKeys, obj.data, oldName).catch(() => null) : null;
    if (!opened || opened.digest !== c.digest || !opened.manifest.frozen) return null;
    const next = successor(opened.manifest, opened.digest);
    const s = await this.loadState();
    if (s.anchor && s.anchor.counter > next.counter) return null;
    const sealed = await sealManifest(k, next, name);
    try {
      await this.o.provider.put(name, sealed.bytes, junk ? { ifMatch: junk.etag } : { ifNoneMatch: "*" });
    } catch (e) {
      if (!(e instanceof PreconditionFailedError)) throw e;
    }
    const now = await this.o.provider.get(name);
    if (!now) return null;
    const got = await openManifest(k, now.data, name).catch(() => null);
    return got ? { obj: now, ...got } : null;
  }

  private async readManifest(): Promise<{ manifest: Manifest; etag: string | null }> {
    const s = await this.loadState();
    const name = await this.manifestObject();
    let obj = await this.o.provider.get(name);
    let opened: { manifest: Manifest; digest: string } | null = null;
    let failure: unknown = null;
    if (obj) {
      try {
        opened = await openManifest(this.o.keys, obj.data, name);
      } catch (e) {
        if (!(e instanceof DecryptError)) throw e;
        failure = e;
      }
    }
    if (!opened && this.o.keys.ring?.carry) {
      const rec = await this.recoverManifest(name, obj);
      if (rec) {
        obj = rec.obj;
        opened = { manifest: rec.manifest, digest: rec.digest };
      }
    }
    if (!obj) {
      // The manifest vanished: as old as it gets.
      if (s.anchor) throw new RollbackError(s.anchor.counter, 0, "older");
      // A re-keyed epoch always has a manifest: never start it empty.
      if (this.o.keys.ring) throw new DecryptError("This key epoch's manifest is missing");
      return { manifest: emptyManifest(this.o.keys.vaultId), etag: null };
    }
    if (!opened) throw failure ?? new DecryptError();
    const { manifest, digest } = opened;
    const got = { counter: manifest.counter, digest };
    if (checkFreshness(s.anchor, got, manifest.history) === "unproven" && s.freshness !== "unverified") {
      // Too far behind to prove this manifest descends from the one we trusted:
      // say so instead of carrying a verification that no longer holds.
      s.freshness = "unverified";
    }
    // A frozen manifest adds no file (it is its predecessor, marked) and may
    // be on a branch the next epoch doesn't take (two re-keys racing): it
    // never becomes the anchor.
    if (!manifest.frozen && (!s.anchor || got.counter > s.anchor.counter)) {
      s.anchor = got;
      await this.save();
    }
    this.remoteDigest = digest;
    this.lastRemote = manifest;
    if (s.committing?.length) await this.reconcileCommit(manifest);
    return { manifest, etag: obj.etag };
  }

  /**
   * A manifest write whose outcome is unknown left its replaced blob names in
   * `committing`. A revision, once replaced, is never referenced again, so
   * every name the current manifest does not reference is garbage — whether
   * this device's write landed or another device replaced it since — and goes
   * to `pending`. Names still referenced are live: the write did not land.
   */
  private async reconcileCommit(current: Manifest): Promise<void> {
    const s = await this.loadState();
    const names = new Set(s.committing ?? []);
    const live = new Set<string>();
    for (const [path, e] of Object.entries(current.files)) {
      if (e.deleted) continue;
      const n = await this.blob(path, e.rev);
      if (names.has(n)) live.add(n);
    }
    s.pending.push(...[...names].filter((n) => !live.has(n)));
    s.committing = [];
    await this.save();
  }

  /**
   * Blobs replaced by a commit over a called-off freeze (RR-4) wait one round:
   * released to `pending` once a later round, after its keyring check, finds
   * the manifest doesn't reference them.
   */
  private async releaseHold(current: Manifest): Promise<void> {
    const s = await this.loadState();
    if (!s.hold?.length) return;
    const referenced = new Set<string>();
    for (const [path, e] of Object.entries(current.files)) if (!e.deleted) referenced.add(await this.blob(path, e.rev));
    const free = s.hold.filter((n) => !referenced.has(n));
    s.hold = s.hold.filter((n) => referenced.has(n));
    s.pending.push(...free);
    await this.save();
  }

  /**
   * A frozen manifest this device has waited on for `FREEZE_TTL_MS` (its own
   * clock): call the re-key off through the keyring, so the re-keyer's
   * commit fails from now on (RR-4). At epoch 0 there is no keyring to
   * rewrite: finish the re-key instead, for the passphrase alone (nobody
   * else is enrolled at epoch 0). False: the keyring changed meanwhile.
   */
  private async callOffFreeze(frozen: Manifest, digest: string): Promise<boolean> {
    const k = this.o.keys;
    if (k.epoch > 0) {
      try {
        await this.adopt(await rewriteKeyring(this.o.provider, k, this.o.access, (c, f) => ({ contents: { ...c, aborted: [...(c.aborted ?? []), digest].slice(-ABORTED_LENGTH) }, file: f })));
        return true;
      } catch (e) {
        if (e instanceof PreconditionFailedError || e instanceof KeyringCommitLostError) return false;
        throw e;
      }
    }
    if (!k.wrap) return false;
    const prepared = await prepareEpoch(null, k, { carry: { label: "manifest", epoch: 0, digest }, now: this.o.now });
    const name = await manifestName(prepared.keys);
    const next = successor(frozen, digest);
    const sealed = await sealManifest(prepared.keys, next, name);
    await this.o.provider.put(name, sealed.bytes, { ifNoneMatch: "*" });
    try {
      await this.o.provider.put(KEYRING_NAME, prepared.bytes, { ifNoneMatch: "*" });
      await confirmCommit(this.o.provider, prepared.keys, prepared.bytes, { wrap: k.wrap }); // N2
    } catch (e) {
      if (!(e instanceof PreconditionFailedError || e instanceof KeyringCommitLostError)) throw e;
      await this.o.provider.delete(name).catch(() => undefined);
      return false;
    }
    await this.adopt(prepared.keys);
    return true;
  }

  private async round(): Promise<SyncResult> {
    const s = await this.loadState();
    await this.refresh();
    if (this.o.keys.ring?.preRelease) throw new PreReleaseKeyringError();
    const res: SyncResult = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: [], held: [], counter: 0, retries: 0, incomplete: false };
    const held = new Set<string>();
    this.holds = new Map();
    /** Blobs uploaded in this round, reused when a retry pushes the same content again. */
    const uploads = new Map<string, { hash: string; rev: string; size: number; data: Uint8Array | null; epoch: number }>();

    for (let attempt = 0; attempt < this.o.maxAttempts; attempt++) {
      let remote: Manifest;
      let etag: string | null;
      try {
        ({ manifest: remote, etag } = await this.readManifest());
        if (attempt === 0) await this.releaseHold(remote);
        await this.pull(remote, res, held);
      } catch (e) {
        if (e instanceof BlobMissingError) {
          res.retries++;
          continue;
        }
        throw e;
      }
      res.counter = remote.counter;
      // A re-key froze this manifest. Unless the keyring lists the freeze as
      // called off, pull only, and wait FREEZE_TTL_MS on this device's own
      // clock before calling it off.
      const overFreeze = !!remote.frozen;
      if (remote.frozen && !this.o.keys.ring?.aborted.includes(this.remoteDigest)) {
        const now = this.o.now();
        let seen = s.frozenSeen;
        if (seen?.digest !== this.remoteDigest) {
          seen = s.frozenSeen = { digest: this.remoteDigest, at: now };
          await this.save();
        }
        if (now - seen.at < FREEZE_TTL_MS) {
          await this.collectGarbage(remote);
          res.held = [...held];
          res.rekeyPending = true;
          return res;
        }
        const epochBefore = this.o.keys.epoch;
        if (!(await this.callOffFreeze(remote, this.remoteDigest))) await this.refresh();
        res.retries++;
        if (this.o.keys.epoch !== epochBefore) delete s.frozenSeen;
        continue; // read again: under the new keyring the freeze is called off, or the epoch moved on
      }

      if (s.freshness === "unverified") {
        // N6: a device that can't verify it has the latest keys pulls but
        // doesn't upload — served an old epoch, what it wrote would be
        // readable by a device revoked meanwhile. Its changes wait here.
        const waiting = this.localChanges(remote, held, await this.listLocal());
        await this.collectGarbage(remote);
        res.held = [...held];
        if (waiting.length) res.waiting = waiting;
        return res;
      }

      const changes = await this.collectChanges(remote, held, uploads);
      if (changes.size === 0) {
        await this.collectGarbage(remote);
        res.held = [...held];
        return res;
      }

      const next: Manifest = successor(remote, this.remoteDigest);
      for (const [path, c] of changes) next.files[path] = c.entry;
      const sealed = await sealManifest(this.o.keys, next, await this.manifestObject());
      // The blobs this commit replaces. Recorded before the write: if the write
      // succeeds but its answer is lost, the next round finds them unreferenced
      // and queues them (`reconcileCommit`), instead of forgetting them.
      const superseded: string[] = [];
      for (const [path] of changes) {
        const old = remote.files[path];
        if (old && !old.deleted) superseded.push(await this.blob(path, old.rev));
      }
      s.committing = overFreeze ? [] : superseded;
      if (overFreeze) s.hold = [...(s.hold ?? []), ...superseded];
      await this.save();
      try {
        await this.o.provider.put(await this.manifestObject(), sealed.bytes, etag ? { ifMatch: etag } : { ifNoneMatch: "*" });
      } catch (e) {
        if (e instanceof PreconditionFailedError) {
          s.committing = []; // certainly not written: the old blobs are still live
          if (overFreeze) s.hold = (s.hold ?? []).filter((n) => !superseded.includes(n));
          await this.save();
          res.retries++;
          continue;
        }
        throw e;
      }
      // The replaced blobs are queued in the same save as the new anchor, before
      // any base entry forgets them, so an interruption cannot leak them. Over a
      // called-off freeze they wait in `hold` for a later round instead.
      s.anchor = { counter: next.counter, digest: sealed.digest };
      this.lastRemote = next;
      if (!overFreeze) s.pending.push(...superseded);
      s.committing = [];
      delete s.frozenSeen;
      await this.save();
      for (const [path, c] of changes) {
        await this.setBase(path, c.entry, c.data);
        if (c.entry.deleted) {
          res.deleted++;
          this.emit({ kind: "delete", at: this.o.now(), path, bytes: 0, direction: "up" });
        } else res.uploaded++;
      }
      await this.collectGarbage(next);
      res.counter = next.counter;
      res.held = [...held];
      return res;
    }
    res.incomplete = true;
    res.held = [...held];
    return res;
  }

  /** Step 2: bring every path the manifest changed into this device. */
  private async pull(remote: Manifest, res: SyncResult, held: Set<string>): Promise<void> {
    const s = await this.loadState();
    const local = new Map((await this.listLocal()).map((f) => [f.path, f.hash]));
    const sorted = [...new Set([...Object.keys(remote.files), ...Object.keys(s.base), ...local.keys()])].sort();
    // Paths this device keeps out (plan W1.8): judged on the version in the vault.
    const excluded = new Set<string>();
    let planFiles = 0;
    let planBytes = 0;
    for (const path of sorted) {
      const r = remote.files[path];
      if (!r || sameEntry(r, s.base[path]) || held.has(path)) continue;
      const why = this.o.exclude(path, r.deleted ? null : r.size);
      if (why) {
        excluded.add(path);
        this.emit({ kind: "excluded", at: this.o.now(), path, reason: why, direction: "down" });
      } else if (!r.deleted && liveHash(r) !== (local.get(path) ?? null)) {
        planFiles++;
        planBytes += r.size;
      }
    }
    this.emit({ kind: "plan", at: this.o.now(), direction: "down", files: planFiles, bytes: planBytes });
    // Deletions first: a folder `a/` replaced by a file `a` (or the reverse)
    // must be cleared before the new entry is written.
    const gone = (p: string) => remote.files[p]?.deleted === true;
    for (const path of [...sorted.filter(gone), ...sorted.filter((p) => !gone(p))]) {
      if (held.has(path) || excluded.has(path)) continue;
      const r = remote.files[path];
      const b = s.base[path];
      if (sameEntry(r, b) || !r) continue;
      const lh = local.get(path) ?? null;
      const rh = liveHash(r);
      const localChanged = lh !== liveHash(b);

      if (!localChanged || lh === rh) {
        // Only the other side changed (or both made the same change).
        if (lh === rh) {
          await this.setBase(path, r, rh === null ? null : await this.o.local.read(path));
          continue;
        }
        if (rh === null) {
          if (!(await this.o.local.remove(path, lh as string))) {
            this.hold(held, path, "retry");
            continue;
          }
          res.deleted++;
          await this.setBase(path, r, null);
          this.emit({ kind: "delete", at: this.o.now(), path, bytes: 0, direction: "down" });
        } else {
          const data = await this.fetchBlob(path, r);
          if (!(await this.o.local.write(path, data, lh))) {
            this.hold(held, path, "retry");
            continue;
          }
          res.downloaded++;
          await this.setBase(path, r, data);
          this.emit({ kind: "download", at: this.o.now(), path, bytes: data.length, direction: "down" });
        }
        continue;
      }

      // Both sides changed, differently. Reported now, before any dialog opens.
      res.conflicts.push(path);
      this.emit({ kind: "conflict", at: this.o.now(), path });
      if (rh === null) {
        // Deleted there, edited here: the edit wins and is pushed as a new version.
        await this.setBase(path, r, null);
        continue;
      }
      const remoteData = await this.fetchBlob(path, r);
      if (lh === null) {
        // Deleted here, edited there: the edit comes back.
        if (!(await this.o.local.write(path, remoteData, null))) {
          this.hold(held, path, "retry");
          continue;
        }
        res.downloaded++;
        await this.setBase(path, r, remoteData);
        this.emit({ kind: "download", at: this.o.now(), path, bytes: remoteData.length, direction: "down" });
        continue;
      }
      const localData = await this.o.local.read(path);
      if (!localData || (await sha256Hex(localData)) !== lh) {
        this.hold(held, path, "retry"); // edited while we looked: next round
        continue;
      }
      const decision = await this.o.resolver({
        path,
        base: b && !b.deleted ? await this.baseBytes(path, b) : null,
        local: localData,
        remote: remoteData,
      });
      switch (decision.kind) {
        case "hold":
          this.hold(held, path, "conflict");
          break;
        case "local":
          await this.setBase(path, r, remoteData);
          break;
        case "remote":
        case "content": {
          const data = decision.kind === "remote" ? remoteData : decision.data;
          if (!(await this.o.local.write(path, data, lh))) {
            this.hold(held, path, "retry");
            break;
          }
          res.downloaded++;
          await this.setBase(path, r, remoteData);
          this.emit({ kind: "download", at: this.o.now(), path, bytes: remoteData.length, direction: "down" });
          break;
        }
        case "keepBoth": {
          const tag = `${new Date(this.o.now()).toISOString().slice(0, 10)} ${s.deviceId.slice(0, 4)}`;
          const copy = conflictCopyPath(path, tag, (p) => p in remote.files || local.has(p) || p in s.base);
          if (!(await this.o.local.write(copy, remoteData, null))) {
            this.hold(held, path, "retry");
            break;
          }
          local.set(copy, r.hash);
          res.downloaded++;
          await this.setBase(path, r, remoteData);
          this.emit({ kind: "download", at: this.o.now(), path: copy, bytes: remoteData.length, direction: "down" });
          break;
        }
      }
    }
  }

  /** Paths changed on this device since its base (not held), without uploading anything. */
  private localChanges(remote: Manifest, held: Set<string>, files: Array<{ path: string; hash: string }>): string[] {
    const s = this.state!;
    const local = new Map(files.filter((f) => isSyncedPath(f.path)).map((f) => [f.path, f.hash]));
    const out: string[] = [];
    for (const path of [...new Set([...Object.keys(s.base), ...local.keys()])].sort()) {
      if (held.has(path)) continue;
      if ((local.get(path) ?? null) === liveHash(s.base[path])) continue;
      if (!local.has(path) && !(remote.files[path] && !remote.files[path].deleted)) continue;
      out.push(path);
    }
    return out;
  }

  /** Step 3 (blobs): upload every local change; returns the new manifest entries. */
  private async collectChanges(
    remote: Manifest,
    held: Set<string>,
    uploads: Map<string, { hash: string; rev: string; size: number; data: Uint8Array | null; epoch: number }>,
  ): Promise<Map<string, { entry: ManifestEntry; data: Uint8Array | null }>> {
    const s = await this.loadState();
    const listed = await this.listLocal();
    const local = new Map(listed.map((f) => [f.path, f.hash]));
    const sizes = new Map(listed.map((f) => [f.path, f.size ?? null]));
    const out = new Map<string, { entry: ManifestEntry; data: Uint8Array | null }>();
    const paths = [...new Set([...Object.keys(s.base), ...local.keys()])].sort();
    // What goes up, and what this device keeps (plan W1.8): judged before
    // anything is read, so an excluded file never even enters the round.
    const todo: string[] = [];
    let planBytes = 0;
    for (const path of paths) {
      if (held.has(path)) continue;
      const b = s.base[path];
      const lh = local.get(path) ?? null;
      if (lh === liveHash(b)) continue;
      if (!sameEntry(remote.files[path], b)) continue; // not pulled yet (held or raced): next round
      const why = this.o.exclude(path, lh === null ? null : (sizes.get(path) ?? null));
      if (why) {
        this.emit({ kind: "excluded", at: this.o.now(), path, reason: why, direction: "up" });
        continue;
      }
      todo.push(path);
      planBytes += lh === null ? 0 : (sizes.get(path) ?? 0);
    }
    this.emit({ kind: "plan", at: this.o.now(), direction: "up", files: todo.length, bytes: planBytes });
    for (const path of todo) {
      const r = remote.files[path];
      const lh = local.get(path) ?? null;
      const ver = (r?.ver ?? 0) + 1;
      if (lh === null) {
        if (!r || r.deleted) continue; // never existed there, or already deleted
        out.set(path, { entry: { ver, rev: "", hash: "", size: 0, deleted: true, by: s.deviceId }, data: null });
        continue;
      }
      const data = await this.o.local.read(path);
      if (!data) continue;
      // The size was unknown or changed since the listing: judge the bytes about to leave.
      const late = this.o.exclude(path, data.length);
      if (late) {
        this.emit({ kind: "excluded", at: this.o.now(), path, reason: late, direction: "up" });
        continue;
      }
      const hash = await sha256Hex(data);
      let up = uploads.get(path);
      if (!up || up.hash !== hash) {
        const rev = toB64u(randomBytes(12));
        const name = await this.blob(path, rev);
        const sealed = await seal(this.o.keys.blobs, this.o.keys.vaultId, "blob", name, data);
        s.pending.push(name);
        await this.save();
        await this.o.provider.put(name, sealed, { ifNoneMatch: "*" });
        // Kept for the base after the commit only when it will be stored (see setBase).
        up = { hash, rev, size: data.length, data: data.length > BASE_BYTES_LIMIT ? null : data, epoch: this.o.keys.epoch };
        uploads.set(path, up);
        this.emit({ kind: "upload", at: this.o.now(), path, bytes: data.length, direction: "up" });
      }
      out.set(path, { entry: { ver, rev: up.rev, hash, size: up.size, by: s.deviceId, ...(up.epoch ? { e: up.epoch } : {}) }, data: up.data });
    }
    // The manifest must describe a tree a file system can hold: never a live
    // file `x` together with live entries under `x/`. A change that would
    // create that — typically because the other side of the clash is held —
    // is held too, until the clash is settled.
    for (let changed = true; changed; ) {
      changed = false;
      const live = new Set(Object.keys(remote.files).filter((p) => !remote.files[p].deleted));
      for (const [p, c] of out) {
        if (c.entry.deleted) live.delete(p);
        else live.add(p);
      }
      for (const [p, c] of out) {
        if (c.entry.deleted) continue;
        const segs = p.split("/");
        const above = segs.slice(0, -1).some((_, k) => live.has(segs.slice(0, k + 1).join("/")));
        const below = [...live].some((q) => q.startsWith(`${p}/`));
        if (above || below) {
          out.delete(p);
          this.hold(held, p, "clash");
          changed = true;
          break;
        }
      }
    }
    return out;
  }

  /**
   * Delete blobs that are known garbage — every name in `pending` that
   * `current` does not reference: blobs replaced by this device's commits and
   * its own uploads that never got committed. Unknown objects are never
   * touched — they may be another device's upload in flight.
   */
  private async collectGarbage(current: Manifest): Promise<void> {
    const s = await this.loadState();
    if (!s.pending.length) return;
    const referenced = new Set<string>();
    if (s.pending.length) {
      for (const [path, e] of Object.entries(current.files)) {
        if (e.by === s.deviceId && !e.deleted) referenced.add(await this.blob(path, e.rev));
      }
    }
    // Every name stays recorded until its delete succeeded, so an interrupted
    // clean-up is finished by a later round instead of leaking the object.
    const garbage = [...new Set(s.pending.filter((n) => !referenced.has(n)))];
    s.pending = [...garbage];
    await this.save();
    for (const name of garbage) {
      try {
        await this.o.provider.delete(name);
      } catch {
        continue; // costs space, never data; retried after the next round
      }
      s.pending = s.pending.filter((n) => n !== name);
      await this.save();
    }
  }
}
