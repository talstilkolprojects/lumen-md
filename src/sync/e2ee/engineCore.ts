/**
 * The encrypted sync engine, part 1 of 3 (split out of engine.ts, W4.11; no
 * behaviour change): the device state and its lock, the keys and their
 * refresh, the revocations this device keeps, and manifest and blob I/O.
 * Key changes and pairing are in engineKeys.ts, the sync round in engine.ts.
 */

import { fromB64u, randomBytes, sha256Hex, toB64u, utf8 } from "./bytes";
import { keepBothResolver, type ConflictResolver } from "./conflict";
import { HEADER_NAME } from "./header";
import { blobKey, DecryptError, epochKeys, hmac, revokedHereKey, unseal, verifyHmac, type VaultKeys } from "./keys";
import {
  anchorOf,
  checkedAnchorOf,
  DroppedFromVaultError,
  KeyringCommitLostError,
  KeyringForkError,
  readKeyring,
  refreshKeys,
  RevokedError,
  rewriteKeyring,
  sealAnchor,
  verifyAnchor,
  verifyDropped,
  type KeyAccess,
} from "./keyring";
import { withDeviceLock } from "./deviceLock";
import {
  blobName,
  checkFreshness,
  emptyManifest,
  manifestName,
  manifestNameFor,
  pathRecord,
  openManifest,
  RollbackError,
  sealManifest,
  type Manifest,
  type ManifestEntry,
} from "./manifest";
import { PreconditionFailedError, type StoredObject } from "./provider";
import type { DeviceState, RevokedHere } from "./state";
import {
  BlobMissingError,
  REVOCATION_AT_RISK_MS,
  readmitted,
  sameAnchor,
  successor,
  type E2eeSyncOptions,
  type RekeyRequest,
  type RekeyResult,
} from "./engineTypes";

export abstract class E2eeSyncCore {
  protected readonly o: Required<Omit<E2eeSyncOptions, "resolver" | "access">> & { resolver: ConflictResolver; access: KeyAccess | null };

  protected running: Promise<unknown> = Promise.resolve();

  /** Key changes (`rekeyNow`) running now: no pairing code meanwhile (G3). */
  protected keyChanges = 0;

  /** This engine holds the device lock (`deviceLock`, H3) for the call running now. */
  protected lockHeld = false;

  protected state: DeviceState | null = null;

  /** Digest of the manifest `readManifest` returned last (the parent of the next commit). */
  protected remoteDigest = "";

  /** The keyring (digest) whose pending passphrase change this device already looked at (resumeEpoch). */
  protected resumed = "";

  /** Opaque names already computed (HMAC is cheap, but not free over thousands of rounds). */
  protected readonly names = new Map<string, string>();

  /**
   * The keyring anchor this device verified was reproduced by the current
   * keys in this round's refresh (fifth review 12.11, F3): the keys hold the
   * secret of the keyring it verified, so a manifest of their epoch more than
   * HISTORY_LENGTH commits ahead is no reason to demote it.
   */
  protected anchorVerified = false;

  constructor(opts: E2eeSyncOptions) {
    // `??`, not a spread: an option passed as undefined must still get its default.
    this.o = {
      ...opts,
      resolver: opts.resolver ?? keepBothResolver,
      maxAttempts: opts.maxAttempts ?? 8,
      now: opts.now ?? (() => Date.now()),
      access: opts.access ?? (opts.keys.wrap ? { wrap: opts.keys.wrap } : null),
    };
  }

  /** The keys this device uses now (they change at a re-key). */
  keys(): VaultKeys {
    return this.o.keys;
  }

  /**
   * H1, H2 (ninth review 12.11): what this device remembers about a key
   * change held back or contested at one epoch is void once the epoch has
   * moved: that key change committed (or another did), so the next one is
   * waited on, and counted, from scratch. True when something was dropped.
   */
  protected dropStaleEpochRecords(s: DeviceState, epoch: number): boolean {
    let dirty = false;
    if (s.rekeyBlocked && s.rekeyBlocked.epoch !== epoch) {
      delete s.rekeyBlocked;
      dirty = true;
    }
    if (s.revokeContested && s.revokeContested.epoch !== epoch) {
      delete s.revokeContested;
      dirty = true;
    }
    return dirty;
  }

  /** Adopt keys this device wrote or verified itself, and remember their keyring as verified. */
  protected async adopt(keys: VaultKeys): Promise<void> {
    const s = await this.loadState();
    this.o.keys = keys;
    if (keys.wrap && (!this.o.access || "wrap" in this.o.access)) this.o.access = { wrap: keys.wrap };
    if (keys.ring) s.ring = await checkedAnchorOf(keys);
    s.epoch = Math.max(s.epoch ?? 0, keys.epoch);
    this.rememberSealedRevoked(s, keys);
    this.dropStaleEpochRecords(s, keys.epoch);
    await this.save();
  }

  /**
   * G5: the sealed revoked list only grows, so remember every device a
   * keyring this device adopted listed. Returns true when that added one.
   */
  protected rememberSealedRevoked(s: DeviceState, keys: VaultKeys): boolean {
    const ring = keys.ring;
    if (!ring?.revoked || ring.preRelease) return false;
    const known = s.sealedRevoked ?? [];
    const add = ring.revoked.filter((r) => !known.some((x) => x.device === r.device && x.recipient === r.recipient));
    if (!add.length) return false;
    s.sealedRevoked = [...known, ...add.map((r) => ({ device: r.device, ...(r.recipient ? { recipient: r.recipient } : {}) }))];
    return true;
  }

  /**
   * Step 0: bring the keys up to the keyring, and finish what a cut-off
   * passphrase change left. `enforce`: check the keyring against the devices
   * this device revoked (F2) — off inside a re-key, which revokes them itself.
   */
  protected async refresh(enforce = true): Promise<void> {
    this.anchorVerified = false;
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
      if (e instanceof KeyringForkError) {
        await this.reapplyRevocation(e);
        throw await this.withRevocationsAtRisk(e);
      }
      // F4: "left out, pair again" only when a member of the vault wrote it; otherwise this device was removed.
      if (e instanceof DroppedFromVaultError) {
        const k = await readKeyring(this.o.provider).catch(() => null);
        if (!k || !("device" in this.o.access) || !(await verifyDropped(k.file, this.o.access.device, this.o.keys))) throw new RevokedError();
      }
      throw e;
    }
    // N1: the new keys must reproduce the anchor (they hold the secret of the keyring this device verified).
    const checked = s.ring ? await verifyAnchor(next, s.ring) : false;
    this.o.keys = next;
    this.anchorVerified = checked;
    let dirty = false;
    if (next.ring?.unproven && s.freshness !== "unverified" && !checked) {
      // Too far behind to prove the keyring descends from the one we verified,
      // and no secret-bound anchor to walk forward with (F3: with one, the
      // keys hold the secret of the keyring this device verified, and that is
      // what pairing anchored).
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
    if (this.rememberSealedRevoked(s, next)) dirty = true;
    if (this.dropStaleEpochRecords(s, next.epoch)) dirty = true;
    if (dirty) await this.save();
    if (enforce) await this.enforceRevocations();
    await this.resumeEpoch();
  }

  /** Secret 0 of the vault (the master at epoch 0), from which the revoked-here list's key comes. */
  protected secret0(): Uint8Array | undefined {
    const k = this.o.keys;
    return k.epoch === 0 ? k.secret : k.olderSecrets.get(0);
  }

  protected revokedHereData(s: DeviceState, devices: RevokedHere["devices"]) {
    return utf8(JSON.stringify(["lumen-e2ee-revoked-here/1", this.o.keys.vaultId, s.deviceId, devices]));
  }

  /**
   * The devices this device revoked (F2), checked against their MAC. A list
   * that doesn't verify (changed, or kept from keys that aren't the
   * vault's) is set aside rather than stopping every round (seventh review
   * 12.11, G5): the sealed revoked lists this device saw (`sealedRevoked`)
   * still hold, and the next round says so (`revokedListReset`).
   */
  protected async revokedHere(): Promise<RevokedHere["devices"]> {
    const s = await this.loadState();
    const r = s.revokedHere;
    if (!r) return [];
    const s0 = this.secret0();
    if (!s0) return []; // keys without epoch 0's secret can't check it; the anchor's check refuses them
    let tag: Uint8Array;
    try {
      tag = fromB64u(r.mac);
    } catch {
      tag = new Uint8Array(0);
    }
    if (!(await verifyHmac(await revokedHereKey(s0, this.o.keys.vaultId), tag, this.revokedHereData(s, r.devices)))) {
      delete s.revokedHere;
      s.revokedHereReset = true;
      await this.save();
      return [];
    }
    return r.devices;
  }

  /** Every device this device knows was revoked: its own revocations (F2) and the sealed lists it adopted (G5). */
  protected async knownRevoked(): Promise<Array<{ device: string; recipient?: string }>> {
    const s = await this.loadState();
    const out: Array<{ device: string; recipient?: string }> = [...(s.sealedRevoked ?? [])];
    for (const d of await this.revokedHere()) if (!out.some((x) => x.device === d.device && x.recipient === d.recipient)) out.push({ device: d.device, ...(d.recipient ? { recipient: d.recipient } : {}) });
    return out;
  }

  /** Known revoked devices the current keyring lets back in, by id or key, or no longer lists as revoked (F2, G5). */
  protected async readmittedNow(enrolled: Record<string, string>): Promise<string[]> {
    const list = await this.knownRevoked();
    const ring = this.o.keys.ring;
    const gone = ring?.revoked && !ring.preRelease ? list.filter((d) => !ring.revoked!.some((r) => r.device === d.device)).map((d) => d.device) : [];
    return [...new Set([...readmitted(list, enrolled), ...gone])];
  }

  /** Remember revocations this device made (F2). */
  protected async rememberRevoked(add: RevokedHere["devices"]): Promise<void> {
    if (!add.length) return;
    const s = await this.loadState();
    const s0 = this.secret0();
    if (!s0) return;
    const devices = [...(await this.revokedHere())];
    for (const d of add) if (!devices.some((x) => x.device === d.device && x.recipient === d.recipient)) devices.push(d);
    s.revokedHere = { devices, mac: toB64u(await hmac(await revokedHereKey(s0, this.o.keys.vaultId), this.revokedHereData(s, devices))) };
    await this.save();
  }

  /**
   * F2: a keyring this device adopted lets in a device it revoked — only a
   * storage that ignored a conditional write gets there (a revoked id or key
   * can't be enrolled again). Revoke it again on top (`KeyringForkError` with
   * `revocationReapplied`), or, when this device can't, stop with the
   * revocation at risk.
   */
  protected async enforceRevocations(): Promise<void> {
    const enrolled = this.o.keys.ring?.enrolled;
    if (!enrolled) return;
    const back = await this.readmittedNow(enrolled);
    if (!back.length) return;
    const s = await this.loadState();
    let done: RekeyResult | null = null;
    if (this.o.access && "wrap" in this.o.access && s.freshness !== "unverified") done = await this.rekeyNow({ revoke: back }).catch(() => null);
    if (done) throw new KeyringForkError("a keyring that lets a device this device revoked back in", back, done.epoch);
    throw new KeyringForkError("a keyring that lets a device this device revoked back in", [], null, back);
  }

  /** A fork that this device couldn't repair, naming the devices it revoked lately (F2): their revocation may be undone. */
  protected async withRevocationsAtRisk(e: KeyringForkError): Promise<KeyringForkError> {
    if (e.revocationReapplied.length || e.revocationAtRisk.length) return e;
    const now = this.o.now();
    const s = await this.loadState();
    let list: RevokedHere["devices"] = [];
    try {
      list = await this.revokedHere();
    } catch {
      list = [];
    }
    const ids = new Set([...list.filter((d) => now - d.at < REVOCATION_AT_RISK_MS).map((d) => d.device), ...(s.rekeyed?.revoked ?? [])]);
    return ids.size ? new KeyringForkError(e.detail, [], null, [...ids]) : e;
  }

  /**
   * Finish a passphrase change that was cut off (idempotent): write the new
   * header the keyring carries, then rewrite the keyring without it (RR-6),
   * so the old passphrase's way back to the epoch before is gone.
   */
  protected async resumeEpoch(): Promise<void> {
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
  protected async finishPassphraseChange(): Promise<boolean> {
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

  /** The lock shared by every engine (every tab) of this device on this vault (H3). */
  protected lockName(s: DeviceState): string {
    return `lumen-e2ee-device:${this.o.keys.vaultId}:${s.deviceId}`;
  }

  /**
   * Run `fn` holding this device's lock (ninth review 12.11, H3), waiting
   * for another tab's key change or pairing to finish. Re-entrant within this
   * engine. `reload`: first read the device state again from the store; only
   * at the start of a public call, before anything holds the cached state.
   */
  protected async underDeviceLock<T>(reload: boolean, fn: () => Promise<T>): Promise<T> {
    if (this.lockHeld) return fn();
    return withDeviceLock(this.lockName(await this.loadState()), async () => {
      this.lockHeld = true;
      try {
        if (reload) await this.reloadState();
        return await fn();
      } finally {
        this.lockHeld = false;
      }
    });
  }

  protected async loadState(): Promise<DeviceState> {
    if (this.state) return this.state;
    const loaded = await this.o.store.load();
    this.state = loaded
      ? { ...loaded, base: pathRecord(loaded.base) }
      : { deviceId: toB64u(randomBytes(9)), anchor: null, freshness: "unverified", base: pathRecord(), pending: [] };
    return this.state;
  }

  /**
   * Read the device state again from the store (H3): another tab of this
   * device may have saved it since. Only at the start of a call, under the
   * device lock, before anything holds the cached state.
   */
  protected async reloadState(): Promise<DeviceState> {
    const loaded = await this.o.store.load();
    if (loaded) this.state = { ...loaded, base: pathRecord(loaded.base) };
    const s = await this.loadState();
    // Another tab took this device to a newer epoch: take its keys up from the
    // keyring that tab verified (lineage and descent checked, then the
    // anchor's check), so that the refresh that follows starts from them.
    const access = this.o.access;
    if (s.ring && access && this.o.keys.epoch < s.ring.epoch) {
      const next = await refreshKeys(this.o.provider, this.o.keys, access, s.ring);
      if (!(await verifyAnchor(next, s.ring))) throw new KeyringForkError("this device's stored anchor has no check for the keys another tab adopted");
      this.o.keys = next;
      if (next.wrap && "wrap" in access) this.o.access = { wrap: next.wrap };
    }
    return s;
  }

  protected async save(): Promise<void> {
    if (this.state) await this.o.store.save(this.state);
  }

  /** Serialise calls: one round (or pairing) at a time per device. */
  protected exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.running.then(fn, fn);
    this.running = next.catch(() => undefined);
    return next;
  }

  protected async setBase(path: string, entry: ManifestEntry, data: Uint8Array | null): Promise<void> {
    const s = await this.loadState();
    await this.o.store.setBase(path, entry.deleted ? null : data);
    s.base[path] = entry;
    await this.save();
  }

  protected async blob(path: string, rev: string): Promise<string> {
    const k = `${path}\u0000${rev}`;
    let n = this.names.get(k);
    if (n === undefined) {
      n = await blobName(this.o.keys, path, rev);
      if (this.names.size > 50_000) this.names.clear();
      this.names.set(k, n);
    }
    return n;
  }

  protected async manifestObject(): Promise<string> {
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
  protected async baseBytes(path: string, entry: ManifestEntry): Promise<Uint8Array | null> {
    const data = await this.o.store.getBase(path);
    return data && (await sha256Hex(data)) === entry.hash ? data : null;
  }

  protected async fetchBlob(path: string, e: ManifestEntry): Promise<Uint8Array> {
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
  protected async recoverManifest(name: string, junk: StoredObject | null): Promise<{ obj: StoredObject; manifest: Manifest; digest: string } | null> {
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

  protected async readManifest(): Promise<{ manifest: Manifest; etag: string | null }> {
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
    if (checkFreshness(s.anchor, got, manifest.history) === "unproven" && s.freshness !== "unverified" && !this.anchorVerified) {
      // Too far behind to prove this manifest descends from the one we trusted,
      // and no secret-bound keyring anchor verified this round: say so instead
      // of carrying a verification that no longer holds. With one (F3), the
      // manifest is sealed under keys that hold the secret this device
      // verified, and the device stays verified and anchors on it.
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
  protected async reconcileCommit(current: Manifest): Promise<void> {
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
  protected async releaseHold(current: Manifest): Promise<void> {
    const s = await this.loadState();
    if (!s.hold?.length) return;
    const referenced = new Set<string>();
    for (const [path, e] of Object.entries(current.files)) if (!e.deleted) referenced.add(await this.blob(path, e.rev));
    const free = s.hold.filter((n) => !referenced.has(n));
    s.hold = s.hold.filter((n) => referenced.has(n));
    s.pending.push(...free);
    await this.save();
  }

  /** A key change (engineKeys.ts). */
  protected abstract rekeyNow(opts: RekeyRequest): Promise<RekeyResult>;

  /** N2, F2: revoke again on top of a sibling's keyring (engineKeys.ts). */
  protected abstract reapplyRevocation(fork: KeyringForkError): Promise<void>;
}
