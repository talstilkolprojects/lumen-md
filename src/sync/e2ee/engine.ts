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
 * Interruption at any point loses nothing: blobs are written before the
 * manifest that references them, the base is saved per file after the local
 * write, and the next round recognises work that was already done (same hash
 * on both sides). Blobs uploaded by an interrupted round are recorded as
 * pending and deleted once they are known to be unreferenced; blobs replaced
 * by a commit are deleted after it.
 */

import { randomBytes, sha256Hex, toB64u } from "./bytes";
import { conflictCopyPath, keepBothResolver, type ConflictResolver } from "./conflict";
import { createHeader, decodeHeader, encodeHeader, HEADER_NAME, unlockHeader, type VaultHeader } from "./header";
import { PBKDF2_MIN_ITERATIONS, type KdfPolicy } from "./kdf";
import { DecryptError, seal, unseal, type VaultKeys } from "./keys";
import { isSyncedPath, type LocalFiles } from "./localFiles";
import {
  blobName,
  checkFreshness,
  emptyManifest,
  HISTORY_LENGTH,
  manifestName,
  pathRecord,
  openManifest,
  RollbackError,
  sealManifest,
  type FreshnessAnchor,
  type Manifest,
  type ManifestEntry,
} from "./manifest";
import { readPairingCode, createPairingCode, PairingError } from "./pairing";
import { PreconditionFailedError, type SyncProvider } from "./provider";
import type { DeviceState, FreshnessSource, SyncStateStore } from "./state";

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

/** A blob the manifest names is missing (replaced by a newer commit meanwhile): the round restarts. */
class BlobMissingError extends Error {}

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

/** Read the header at `provider` and derive the keys; `WrongPassphraseError` on a wrong passphrase. */
export async function unlockVault(
  provider: SyncProvider,
  passphrase: string,
  policy: KdfPolicy = {},
): Promise<{ header: VaultHeader; keys: VaultKeys }> {
  const obj = await provider.get(HEADER_NAME);
  if (!obj) throw new NoVaultError();
  const header = decodeHeader(obj.data, policy);
  return { header, keys: await unlockHeader(header, passphrase) };
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
}

export interface E2eeSyncOptions {
  provider: SyncProvider;
  keys: VaultKeys;
  local: LocalFiles;
  store: SyncStateStore;
  resolver?: ConflictResolver;
  /** Manifest compare-and-swap attempts per round (default 8). */
  maxAttempts?: number;
  /** Clock, for conflict-copy names and pairing codes (tests). */
  now?: () => number;
}

function sameEntry(a: ManifestEntry | undefined, b: ManifestEntry | undefined): boolean {
  if (!a || !b) return a === b;
  return a.ver === b.ver && a.rev === b.rev && !!a.deleted === !!b.deleted;
}

function liveHash(e: ManifestEntry | undefined): string | null {
  return e && !e.deleted ? e.hash : null;
}

export class E2eeSync {
  private readonly o: Required<Omit<E2eeSyncOptions, "resolver">> & { resolver: ConflictResolver };
  private running: Promise<unknown> = Promise.resolve();
  private state: DeviceState | null = null;
  /** Digest of the manifest `readManifest` returned last (the parent of the next commit). */
  private remoteDigest = "";
  /** Opaque names already computed (HMAC is cheap, but not free over thousands of rounds). */
  private readonly names = new Map<string, string>();

  constructor(opts: E2eeSyncOptions) {
    // `??`, not a spread: an option passed as undefined must still get its default.
    this.o = {
      ...opts,
      resolver: opts.resolver ?? keepBothResolver,
      maxAttempts: opts.maxAttempts ?? 8,
      now: opts.now ?? (() => Date.now()),
    };
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
   * anchor. An unverified (TOFU) device cannot issue one: it would pass on a
   * state nobody verified as if it had been.
   */
  async pairingCode(): Promise<string> {
    const s = await this.loadState();
    if (!s.anchor) throw new PairingError("Sync once before pairing another device");
    if (s.freshness === "unverified") {
      throw new PairingError("This device's freshness is not verified: pair it or confirm it before pairing others");
    }
    return createPairingCode(this.o.keys, s.anchor, this.o.now());
  }

  /** Accept a pairing code from an existing device: anchors the rollback guard. */
  pair(code: string): Promise<void> {
    return this.exclusive(async () => {
      const got = await readPairingCode(this.o.keys, code, this.o.now());
      const s = await this.loadState();
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
      s.anchor = got;
      s.freshness = "paired";
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
    return this.exclusive(() => this.round());
  }

  private async setBase(path: string, entry: ManifestEntry, data: Uint8Array | null): Promise<void> {
    const s = await this.loadState();
    await this.o.store.setBase(path, entry.deleted ? null : data);
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
    let n = this.names.get("");
    if (n === undefined) {
      n = await manifestName(this.o.keys);
      this.names.set("", n);
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
    const data = await unseal(this.o.keys.blobs, this.o.keys.vaultId, "blob", name, obj.data);
    if ((await sha256Hex(data)) !== e.hash) throw new DecryptError("A file does not match its manifest entry");
    return data;
  }

  private async readManifest(): Promise<{ manifest: Manifest; etag: string | null }> {
    const s = await this.loadState();
    const obj = await this.o.provider.get(await this.manifestObject());
    if (!obj) {
      // The manifest vanished: as old as it gets.
      if (s.anchor) throw new RollbackError(s.anchor.counter, 0, "older");
      return { manifest: emptyManifest(this.o.keys.vaultId), etag: null };
    }
    const { manifest, digest } = await openManifest(this.o.keys, obj.data, await this.manifestObject());
    const got = { counter: manifest.counter, digest };
    if (checkFreshness(s.anchor, got, manifest.history) === "unproven" && s.freshness !== "unverified") {
      // Too far behind to prove this manifest descends from the one we trusted:
      // say so instead of carrying a verification that no longer holds.
      s.freshness = "unverified";
    }
    if (!s.anchor || got.counter > s.anchor.counter) {
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

  private async round(): Promise<SyncResult> {
    const s = await this.loadState();
    const res: SyncResult = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: [], held: [], counter: 0, retries: 0, incomplete: false };
    const held = new Set<string>();
    /** Blobs uploaded in this round, reused when a retry pushes the same content again. */
    const uploads = new Map<string, { hash: string; rev: string; size: number; data: Uint8Array }>();

    for (let attempt = 0; attempt < this.o.maxAttempts; attempt++) {
      let remote: Manifest;
      let etag: string | null;
      try {
        ({ manifest: remote, etag } = await this.readManifest());
        await this.pull(remote, res, held);
      } catch (e) {
        if (e instanceof BlobMissingError) {
          res.retries++;
          continue;
        }
        throw e;
      }
      res.counter = remote.counter;

      const changes = await this.collectChanges(remote, held, uploads);
      if (changes.size === 0) {
        await this.collectGarbage(remote);
        res.held = [...held];
        return res;
      }

      const next: Manifest = {
        ...remote,
        counter: remote.counter + 1,
        files: pathRecord(remote.files),
        history: remote.counter > 0 ? [...remote.history, [remote.counter, this.remoteDigest] as [number, string]].slice(-HISTORY_LENGTH) : [],
      };
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
      s.committing = superseded;
      await this.save();
      try {
        await this.o.provider.put(await this.manifestObject(), sealed.bytes, etag ? { ifMatch: etag } : { ifNoneMatch: "*" });
      } catch (e) {
        if (e instanceof PreconditionFailedError) {
          s.committing = []; // certainly not written: the old blobs are still live
          await this.save();
          res.retries++;
          continue;
        }
        throw e;
      }
      // The replaced blobs are queued in the same save as the new anchor, before
      // any base entry forgets them, so an interruption cannot leak them.
      s.anchor = { counter: next.counter, digest: sealed.digest };
      s.pending.push(...superseded);
      s.committing = [];
      await this.save();
      for (const [path, c] of changes) {
        await this.setBase(path, c.entry, c.data);
        if (c.entry.deleted) res.deleted++;
        else res.uploaded++;
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
    const local = new Map((await this.o.local.list()).filter((f) => isSyncedPath(f.path)).map((f) => [f.path, f.hash]));
    const sorted = [...new Set([...Object.keys(remote.files), ...Object.keys(s.base), ...local.keys()])].sort();
    // Deletions first: a folder `a/` replaced by a file `a` (or the reverse)
    // must be cleared before the new entry is written.
    const gone = (p: string) => remote.files[p]?.deleted === true;
    for (const path of [...sorted.filter(gone), ...sorted.filter((p) => !gone(p))]) {
      if (held.has(path)) continue;
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
            held.add(path);
            continue;
          }
          res.deleted++;
          await this.setBase(path, r, null);
        } else {
          const data = await this.fetchBlob(path, r);
          if (!(await this.o.local.write(path, data, lh))) {
            held.add(path);
            continue;
          }
          res.downloaded++;
          await this.setBase(path, r, data);
        }
        continue;
      }

      // Both sides changed, differently.
      res.conflicts.push(path);
      if (rh === null) {
        // Deleted there, edited here: the edit wins and is pushed as a new version.
        await this.setBase(path, r, null);
        continue;
      }
      const remoteData = await this.fetchBlob(path, r);
      if (lh === null) {
        // Deleted here, edited there: the edit comes back.
        if (!(await this.o.local.write(path, remoteData, null))) {
          held.add(path);
          continue;
        }
        res.downloaded++;
        await this.setBase(path, r, remoteData);
        continue;
      }
      const localData = await this.o.local.read(path);
      if (!localData || (await sha256Hex(localData)) !== lh) {
        held.add(path); // edited while we looked: next round
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
          held.add(path);
          break;
        case "local":
          await this.setBase(path, r, remoteData);
          break;
        case "remote":
        case "content": {
          const data = decision.kind === "remote" ? remoteData : decision.data;
          if (!(await this.o.local.write(path, data, lh))) {
            held.add(path);
            break;
          }
          res.downloaded++;
          await this.setBase(path, r, remoteData);
          break;
        }
        case "keepBoth": {
          const tag = `${new Date(this.o.now()).toISOString().slice(0, 10)} ${s.deviceId.slice(0, 4)}`;
          const copy = conflictCopyPath(path, tag, (p) => p in remote.files || local.has(p) || p in s.base);
          if (!(await this.o.local.write(copy, remoteData, null))) {
            held.add(path);
            break;
          }
          local.set(copy, r.hash);
          res.downloaded++;
          await this.setBase(path, r, remoteData);
          break;
        }
      }
    }
  }

  /** Step 3 (blobs): upload every local change; returns the new manifest entries. */
  private async collectChanges(
    remote: Manifest,
    held: Set<string>,
    uploads: Map<string, { hash: string; rev: string; size: number; data: Uint8Array }>,
  ): Promise<Map<string, { entry: ManifestEntry; data: Uint8Array | null }>> {
    const s = await this.loadState();
    const local = new Map((await this.o.local.list()).filter((f) => isSyncedPath(f.path)).map((f) => [f.path, f.hash]));
    const out = new Map<string, { entry: ManifestEntry; data: Uint8Array | null }>();
    const paths = new Set([...Object.keys(s.base), ...local.keys()]);
    for (const path of [...paths].sort()) {
      if (held.has(path)) continue;
      const b = s.base[path];
      const r = remote.files[path];
      const lh = local.get(path) ?? null;
      if (lh === liveHash(b)) continue;
      if (!sameEntry(r, b)) continue; // not pulled yet (held or raced): next round
      const ver = (r?.ver ?? 0) + 1;
      if (lh === null) {
        if (!r || r.deleted) continue; // never existed there, or already deleted
        out.set(path, { entry: { ver, rev: "", hash: "", size: 0, deleted: true, by: s.deviceId }, data: null });
        continue;
      }
      const data = await this.o.local.read(path);
      if (!data) continue;
      const hash = await sha256Hex(data);
      let up = uploads.get(path);
      if (!up || up.hash !== hash) {
        const rev = toB64u(randomBytes(12));
        const name = await this.blob(path, rev);
        const sealed = await seal(this.o.keys.blobs, this.o.keys.vaultId, "blob", name, data);
        s.pending.push(name);
        await this.save();
        await this.o.provider.put(name, sealed, { ifNoneMatch: "*" });
        up = { hash, rev, size: data.length, data };
        uploads.set(path, up);
      }
      out.set(path, { entry: { ver, rev: up.rev, hash, size: up.size, by: s.deviceId }, data: up.data });
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
          held.add(p);
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
