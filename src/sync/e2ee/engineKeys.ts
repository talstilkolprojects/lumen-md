/**
 * The encrypted sync engine, part 2 of 3 (split out of engine.ts, W4.11; no
 * behaviour change): key changes (freeze, commit, revocation, calling a
 * freeze off), enrolment, freshness and pairing.
 */

import { equalBytes } from "./bytes";
import { encodeHeader, HEADER_NAME, rekeyHeader, type VaultHeader } from "./header";
import { PBKDF2_DEFAULT_ITERATIONS, WeakKdfError } from "./kdf";
import { type VaultKeys } from "./keys";
import {
  ABORTED_LENGTH,
  anchorOf,
  checkedAnchorOf,
  confirmCommit,
  enrollDevice,
  KEYRING_NAME,
  KeyringCommitLostError,
  KeyringForkError,
  keyringContents,
  keysFromKeyring,
  prepareEpoch,
  PreReleaseKeyringError,
  readKeyring,
  RevokedDeviceEnrollError,
  rewriteKeyring,
  sealAnchor,
  unwrapSecret,
  verifyAnchor,
} from "./keyring";
import { LOCK_BUSY, tryDeviceLock, withDeviceLock } from "./deviceLock";
import { FREEZE_TTL_MS, FROZEN_PROTOCOL, manifestName, RollbackError, sealManifest, type FreshnessAnchor, type Manifest } from "./manifest";
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
import { PreconditionFailedError, proveCas } from "./provider";
import type { DeviceState, FreshnessSource } from "./state";
import {
  DeviceBusyError,
  DropDevicesRequiredError,
  KEY_CHANGE_LOCK_WAIT_MS,
  KeyChangeInProgressError,
  PairingDuringKeyChangeError,
  PairingPendingError,
  readmitted,
  REKEY_BLOCK_WINDOW_MS,
  RevocationContestedError,
  sameAnchor,
  successor,
  UnverifiedDeviceError,
  verifiedKdf,
  type RekeyRequest,
  type RekeyResult,
} from "./engineTypes";
import { E2eeSyncCore } from "./engineCore";

/** @internal One of the engine's parts: use `E2eeSync`, never extend these (review 34). */
export abstract class E2eeSyncKeys extends E2eeSyncCore {
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
    // H3: under the device lock, from the state as stored (another tab of
    // this device may have changed it since this engine read it).
    return this.exclusive(() => this.underDeviceLock(true, () => this.rekeyNow(opts), KEY_CHANGE_LOCK_WAIT_MS));
  }

  /**
   * Run `fn` holding this device's lock if no key change holds it now, in
   * any tab (H3); `PairingDuringKeyChangeError` at once otherwise, as for a
   * key change in this engine (G3). The state is read again from the store
   * first, and keys another tab moved on to are taken up.
   * @internal
   */
  protected async pairingUnderLock<T>(fn: (s: DeviceState) => Promise<T>): Promise<T> {
    const out = await tryDeviceLock(this.lockScope(), async () => {
      this.lockHeld = true;
      try {
        const s = await this.reloadState();
        if (s.ring && !sameAnchor(s.ring, anchorOf(this.o.keys))) await this.refresh();
        return await fn(await this.loadState());
      } finally {
        this.lockHeld = false;
      }
    });
    if (out === LOCK_BUSY) {
      // K34-2 (review 34): changing keys, or only syncing in another tab?
      const keys = await tryDeviceLock({ ...this.lockScope(), part: "keys" }, async () => true);
      throw keys === LOCK_BUSY ? new PairingDuringKeyChangeError() : new DeviceBusyError();
    }
    return out;
  }

  /**
   * Since when a key change from this device has been held back by another
   * device's freeze (G1): the first refusal, kept across fresh freezes (the
   * device being revoked can write one every few minutes), or when this
   * device's rounds first saw the current run of foreign freezes. A refusal
   * older than REKEY_BLOCK_WINDOW_MS is a key change given up long ago: the
   * wait starts again, so it can't cut short the wait on an honest re-key
   * that started just now (t8). So does a refusal from an earlier epoch
   * (ninth review 12.11, H1): the key change that held this device back
   * has committed since, and the freeze now in the way is another one.
   * @internal
   */
  protected async keyChangeBlockedSince(s: DeviceState, now: number): Promise<number> {
    const epoch = this.o.keys.epoch;
    const valid = (t: number | undefined): t is number => t !== undefined && t <= now && now - t < REKEY_BLOCK_WINDOW_MS;
    let since = s.rekeyBlocked?.epoch === epoch ? s.rekeyBlocked.since : undefined;
    if (!valid(since)) {
      since = now;
      s.rekeyBlocked = { since, epoch };
      await this.save();
    }
    const seen = s.frozenSeen;
    return seen && seen.epoch === this.o.keys.epoch && valid(seen.at) ? Math.min(since, seen.at) : since;
  }

  /**
   * H2 (ninth review 12.11): a revocation's commit just lost. When the live
   * keyring is still at the epoch this device re-keyed from, the keyring was
   * rewritten at that epoch (an enrollment, a call-off, or a no-op), not
   * replaced by another device's key change. Counted per epoch and per
   * device being removed; from the second loss in a row, throws
   * `RevocationContestedError`: retrying can't win against a writer that
   * still holds the epoch's secret and the storage login, so the user is
   * told to take the storage login away first.
   * @internal
   */
  protected async countContestedRevocation(s: DeviceState, previous: VaultKeys, revoke: string[]): Promise<void> {
    const epoch = previous.epoch;
    const live = await readKeyring(this.o.provider).catch(() => null);
    if (!live || live.file.epoch !== epoch) {
      if (s.revokeContested) {
        delete s.revokeContested;
        await this.save();
      }
      return;
    }
    // K6-2 (review 16): a loss counts only when the keyring really was
    // rewritten by a holder of this epoch's secret: another keyring than
    // the one this device re-keyed from, that opens under the epoch's keys,
    // at a later revision. A refusal the storage made up, or an older
    // revision it serves, is a plain storage error, not "contested".
    const rev = previous.ring?.rev ?? -1;
    const rewritten = live.digest !== previous.ring?.digest && (await keyringContents(live.file, previous).then((c) => c.rev > rev, () => false));
    if (!rewritten) return;
    const was = s.revokeContested;
    const same = !!was && was.epoch === epoch && was.devices.some((d) => revoke.includes(d));
    const losses = (same ? was.losses : 0) + 1;
    s.revokeContested = { epoch, devices: [...new Set([...(same ? was.devices : []), ...revoke])], losses };
    await this.save();
    if (losses >= 2) throw new RevocationContestedError(revoke, losses);
  }

  /**
   * No key change while a pairing code or answer from this device is valid
   * (N3). `fromStore`: also the one another tab of this device saved since
   * this engine read the state (H3), which is then kept.
   * @internal
   */
  protected async checkNoPairingPending(fromStore = false): Promise<void> {
    const s = await this.loadState();
    if (fromStore) {
      const stored = await this.o.store.load().catch(() => null);
      if (stored?.pairingUntil !== undefined && stored.pairingUntil > (s.pairingUntil ?? 0)) s.pairingUntil = stored.pairingUntil;
    }
    if (s.pairingUntil !== undefined && this.o.now() < s.pairingUntil) throw new PairingPendingError(s.pairingUntil);
  }

  /** @internal */
  protected async rekeyNow(opts: RekeyRequest): Promise<RekeyResult> {
    this.keyChanges++;
    try {
      // H3: also when a round re-applies a revocation (enforceRevocations,
      // reapplyRevocation): no other tab of this device makes a code meanwhile.
      // K34-2: the "keys" lock beside the device's own tells a pairing code
      // refused meanwhile, in any tab, that keys are changing (not a round).
      return await this.underDeviceLock(false, () => withDeviceLock({ ...this.lockScope(), part: "keys" }, () => this.rekeyRunning(opts)));
    } finally {
      this.keyChanges--;
    }
  }

  /** @internal */
  protected async rekeyRunning(opts: RekeyRequest): Promise<RekeyResult> {
    const s = await this.loadState();
    await this.refresh(false);
    const previous = this.o.keys;
    const reset = !!previous.ring?.preRelease;
    const enrolled = previous.ring?.enrolled ?? {};
    // A device that can't verify it has the latest keys can't vouch for the
    // device list either (RR-5, third review N3): its re-key wraps the new
    // epoch for the passphrase and the devices it enrolls now, no other.
    // Served an old epoch, it so never wraps for a device revoked meanwhile.
    // Leaving devices out takes the user's consent (fifth review F3).
    const leftOut = !reset && s.freshness === "unverified" ? Object.keys(enrolled).filter((id) => !(opts.revoke ?? []).includes(id) && !(id in (opts.enroll ?? {}))) : [];
    if (leftOut.length && !opts.dropDevices) throw new DropDevicesRequiredError(leftOut);
    const dropDevices = leftOut.length > 0;
    await this.checkNoPairingPending();
    await proveCas(this.o.provider);
    const current = await readKeyring(this.o.provider);
    if (current ? current.file.epoch !== previous.epoch || current.digest !== previous.ring?.digest : previous.epoch !== 0) {
      // H2: rewritten between this device's refresh and here (the probe's
      // writes are enough of a cue for a writer that polls) counts as a loss too.
      if (opts.revoke?.length) await this.countContestedRevocation(s, previous, opts.revoke);
      throw new PreconditionFailedError(KEYRING_NAME);
    }
    // F2: the devices this device revoked stay out of every re-key it makes,
    // by id and by key; G5: so do those of every sealed list it adopted.
    const mine = await this.knownRevoked();
    const revoke = [...new Set([...(opts.revoke ?? []), ...(await this.readmittedNow(enrolled))])];
    const written: string[] = [];
    let header: { header: VaultHeader; master: Uint8Array } | null = null;
    if (opts.newPassphrase !== undefined) {
      // The KDF family stays what the authenticated header says (RR-10, F5):
      // PBKDF2 stays PBKDF2 unless `kdf` asks for Argon2id; Argon2id, or a
      // header that doesn't verify, stays (or becomes) Argon2id.
      const was = (await verifiedKdf(await this.o.provider.get(HEADER_NAME), previous)) ?? { alg: "argon2id" };
      const wantPbkdf2 = opts.kdf === "pbkdf2-sha256" || (opts.kdf === undefined && (was.alg === "pbkdf2-sha256" || opts.pbkdf2Iterations !== undefined));
      if (wantPbkdf2 && was.alg !== "pbkdf2-sha256") throw new WeakKdfError("This vault's passphrase is protected with Argon2id; a passphrase change doesn't move it to PBKDF2");
      const pbkdf2 = wantPbkdf2 ? (opts.pbkdf2Iterations ?? Math.max(PBKDF2_DEFAULT_ITERATIONS, was.iterations ?? 0)) : undefined;
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
      // Another device's freeze that the keyring doesn't list as called off is
      // a key change in progress (fifth review 12.11, Q2): wait it out on this
      // device's own clock, as a round does, instead of freezing over it at
      // once. Against a storage that drops If-Match on the keyring only, that
      // freeze is the other re-keyer's intent, and this re-key doesn't race it.
      // The wait is bounded per key change, not per frozen manifest (seventh
      // review 12.11, G1): once FREEZE_TTL_MS has passed since this device
      // was first held back, it freezes over whatever freeze is there, so
      // the device being revoked can't hold its own revocation back by
      // writing a fresh freeze every few minutes. Nothing in the freeze (its
      // digest, `at`, `by`) moves this device's clock.
      if (m.frozen && m.frozen.by !== s.deviceId && !previous.ring?.aborted.includes(this.remoteDigest)) {
        const since = await this.keyChangeBlockedSince(s, now);
        if (now - since < FREEZE_TTL_MS) throw new KeyChangeInProgressError(since + FREEZE_TTL_MS);
      }
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
      revoke,
      enroll: opts.enroll,
      newPassphraseMaster: header?.master,
      newHeader: header ? encodeHeader(header.header) : undefined,
      carry: { label: previous.ring?.manifest ?? "manifest", epoch: previous.epoch, digest: frozenDigest },
      dropDevices,
      excludeRecipients: mine.map((r) => r.recipient).filter((r): r is string => !!r),
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
    //    No pairing code or answer from this device may have become valid
    //    meanwhile (G3): checked again right before the commit.
    try {
      await this.checkNoPairingPending(true);
    } catch (e) {
      await this.o.provider.delete(name).catch(() => undefined);
      throw e;
    }
    try {
      await this.o.provider.put(KEYRING_NAME, prepared.bytes, current ? { ifMatch: current.etag } : { ifNoneMatch: "*" });
    } catch (e) {
      if (e instanceof PreconditionFailedError) {
        await this.o.provider.delete(name).catch(() => undefined);
        if (revoke.length) await this.countContestedRevocation(s, previous, revoke);
      }
      throw e; // anything else: the outcome is unknown, and the manifest stays for the keyring that may have landed
    }
    // Read it back (third review 12.11, N2): a storage that passed the
    // probe can still drop the condition on this write, and let another
    // device's key change replace this one. Then the result says so
    // (`confirmed: false`): the revocation may not have taken effect.
    let lost: KeyringCommitLostError | null = null;
    try {
      await confirmCommit(this.o.provider, keys, prepared.bytes, { wrap: keys.wrap! }, revoke);
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
    delete s.rekeyBlocked;
    delete s.revokeContested;
    s.rekeyed = { epoch: keys.epoch, digest: keys.ring!.digest, parent: current?.digest ?? null, parentEpoch: previous.epoch, revoked: revoke, manifest: anchorBefore };
    await this.adopt(keys);
    // F2: remembered here, so a keyring that lets them back in later — at any epoch — is caught.
    await this.rememberRevoked(revoke.map((device) => ({ device, ...(enrolled[device] ? { recipient: enrolled[device] } : {}), at: now })));

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
   * N2, F2: this device's re-key, confirmed when it was written, was
   * replaced by a keyring made from the same parent — another device's
   * re-key that the storage let through without its compare-and-swap, or
   * anything built on top of that since, at any later epoch. That device
   * didn't know of this one's revocations, so it wrapped the new epoch for
   * the revoked devices again. Revoke them again on top of the live keyring
   * (it descends from the keyring this device verified before its re-key,
   * and a holder of that epoch's secret made it), then throw a
   * `KeyringForkError` naming them: what was written in between may be
   * readable by them. Returns quietly when that isn't the case.
   * @internal
   */
  protected async reapplyRevocation(fork: KeyringForkError): Promise<void> {
    const s = await this.loadState();
    const r = s.rekeyed;
    const access = this.o.access;
    if (!r || !r.revoked.length || fork.revocationReapplied.length || !access || !("wrap" in access) || s.freshness === "unverified") return;
    const k = await readKeyring(this.o.provider);
    if (!k || k.file.epoch < r.epoch || k.digest === r.digest || k.file.vaultId !== this.o.keys.vaultId) return;
    let sibling: VaultKeys;
    let c: Awaited<ReturnType<typeof keyringContents>>;
    try {
      sibling = await keysFromKeyring(k.file, await unwrapSecret(k.file, access), this.o.keys, { digest: k.digest });
      c = await keyringContents(k.file, sibling);
    } catch {
      return;
    }
    const mySecret = this.o.keys.olderSecrets.get(r.parentEpoch);
    const theirSecret = sibling.olderSecrets.get(r.parentEpoch);
    const fromParent = r.parent !== null && c.chain.some(([e, , d]) => e === r.parentEpoch && d === r.parent);
    if (!fromParent || c.chain.some(([, , d]) => d === r.digest) || !mySecret || !theirSecret || !equalBytes(mySecret, theirSecret)) return;
    // Every device this device revoked that the live keyring doesn't list as revoked, or lets in by id or key.
    let mine: Array<{ device: string; recipient?: string }>;
    try {
      mine = await this.knownRevoked();
    } catch {
      return;
    }
    const list = [...mine, ...r.revoked.filter((d) => !mine.some((x) => x.device === d)).map((device) => ({ device }))];
    const missing = [...new Set([...readmitted(list, c.devices), ...r.revoked.filter((d) => !c.revoked.some((x) => x.device === d))])];
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
    throw new KeyringForkError(`another device's keyring, at epoch ${k.file.epoch}, replaced this device's at ${r.epoch}`, missing, done.epoch);
  }

  /**
   * Enroll a device at the current epoch (no re-key): its age recipient
   * goes into the sealed list and gets a wrap of the epoch secret. Refused on
   * an unverified device and on a provider without working conditional
   * writes, like `rekey`.
   */
  enroll(device: string, recipient: string): Promise<void> {
    return this.exclusive(() => this.underDeviceLock(true, async () => {
      const s = await this.loadState();
      await this.refresh();
      if (this.o.keys.ring?.preRelease) throw new PreReleaseKeyringError();
      if (s.freshness === "unverified") throw new UnverifiedDeviceError("enroll devices");
      // F2: a device this device revoked doesn't come back, by id or by key.
      if ((await this.knownRevoked()).some((r) => r.device === device || r.recipient === recipient)) throw new RevokedDeviceEnrollError(device);
      await this.checkNoPairingPending();
      await proveCas(this.o.provider);
      await this.adopt(await enrollDevice(this.o.provider, this.o.keys, device, recipient, this.o.access));
    }));
  }

  /** How this device knows its view of the vault is current. */
  async freshness(): Promise<{ source: FreshnessSource; verified: boolean; counter: number | null }> {
    const s = await this.loadState();
    return { source: s.freshness, verified: s.freshness !== "unverified", counter: s.anchor?.counter ?? null };
  }

  /** The creator of the vault anchors on the manifest it just wrote. */
  markCreated(anchor: FreshnessAnchor): Promise<void> {
    return this.exclusive(() => this.underDeviceLock(true, async () => {
      const s = await this.loadState();
      s.anchor = anchor;
      s.freshness = "created";
      await this.save();
    }));
  }

  /**
   * A pairing code for a new device, carrying this device's newest verified
   * anchors: the manifest and the keyring. An unverified (TOFU) device cannot
   * issue one: it would pass on a state nobody verified as if it had been.
   */
  pairingCode(): Promise<string> {
    // Seventh review 12.11, G3: serialised with key changes. A key change
    // running now (its keyring write may be stalled) would make the code
    // vouch for the epoch it is replacing: refused at once, not queued.
    if (this.keyChanges > 0) return Promise.reject(new PairingDuringKeyChangeError());
    // H3: nor while another tab of this device changes keys (the device lock).
    return this.exclusive(() => this.pairingUnderLock(async (s) => {
      if (!s.anchor) throw new PairingError("Sync once before pairing another device");
      if (s.freshness === "unverified") {
        throw new PairingError("This device's freshness is not verified: pair it or confirm it before pairing others");
      }
      const now = this.o.now();
      const code = await createPairingCode(this.o.keys, s.anchor, now, anchorOf(this.o.keys));
      s.pairingUntil = Math.max(s.pairingUntil ?? 0, now + PAIRING_TTL_MS); // N3: no key change while it is valid
      await this.save();
      return code;
    }));
  }

  /**
   * Two-way pairing, step 1, on the new device (third review 12.11, N3): a
   * request naming the keyring and manifest this device sees now. The user
   * enters it on an existing device (`answerPairing`), and that device's
   * answer here (`pair`).
   */
  pairingRequest(): Promise<string> {
    return this.exclusive(() => this.underDeviceLock(true, async () => {
      await this.refresh();
      const s = await this.loadState();
      const { code, request } = await createPairingRequest(this.o.keys, s.anchor, this.o.now(), anchorOf(this.o.keys));
      s.pairRequest = request;
      await this.save();
      return code;
    }));
  }

  /**
   * Two-way pairing, step 2, on an existing, verified device: check the new
   * device's request against this device's *current* keyring and manifest —
   * read now, not when anything was issued — and answer with them, bound to
   * the request. A new device shown an older epoch or revision is refused
   * here (`PairingEpochError("older")`), whichever device made the newer one.
   */
  answerPairing(request: string): Promise<string> {
    // H3: not while another tab of this device changes keys (the device lock).
    return this.exclusive(() => this.pairingUnderLock(async (s) => {
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
    }));
  }

  /**
   * Call off this device's pairing (info I3): the codes and answers it gave
   * out stop holding back its key changes, so an urgent revocation needn't
   * wait up to 5 minutes, and a request it is waiting to have answered is
   * forgotten (its answer is refused from now on). A code or answer already
   * given out still verifies on the device it was given to, so tell that
   * device not to use it — pair it again after the key change.
   */
  cancelPairing(): Promise<void> {
    return this.exclusive(() => this.underDeviceLock(true, async () => {
      const s = await this.loadState();
      delete s.pairingUntil;
      delete s.pairRequest;
      await this.save();
    }));
  }

  /** Accept a pairing code from an existing device: anchors the rollback guards (manifest and keyring). */
  pair(code: string): Promise<void> {
    return this.exclusive(() => this.underDeviceLock(true, async () => {
      const s = await this.loadState();
      // F6: the keys must reproduce the anchor this device verified before
      // anything is sealed with them (a state from before N1 has no check:
      // the refresh seals it, as every other entry point does).
      if (s.ring && !(await verifyAnchor(this.o.keys, s.ring))) await this.refresh();
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
    }));
  }

  /** The user confirmed by hand (e.g. compared with another device) that the vault is current. */
  confirmFreshness(): Promise<void> {
    return this.exclusive(() => this.underDeviceLock(true, async () => {
      const s = await this.loadState();
      if (!s.anchor) throw new Error("Nothing to confirm yet: sync once first");
      if (s.freshness === "unverified") s.freshness = "confirmed";
      await this.save();
    }));
  }

  /**
   * A frozen manifest this device has waited on for `FREEZE_TTL_MS` (its own
   * clock): call the re-key off through the keyring, so the re-keyer's
   * commit fails from now on (RR-4). At epoch 0 there is no keyring to
   * rewrite: finish the re-key instead, for the passphrase alone (nobody
   * else is enrolled at epoch 0). False: the keyring changed meanwhile.
   * @internal
   */
  protected async callOffFreeze(frozen: Manifest, digest: string): Promise<boolean> {
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
}
