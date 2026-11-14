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

import { randomBytes, sha256Hex, toB64u } from "./bytes";
import { conflictCopyPath } from "./conflict";
import { seal } from "./keys";
import { PreReleaseKeyringError } from "./keyring";
import { isSyncedPath } from "./localFiles";
import { FREEZE_TTL_MS, sealManifest, type Manifest, type ManifestEntry } from "./manifest";
import { PreconditionFailedError } from "./provider";
import { BlobMissingError, liveHash, sameEntry, successor, type SyncResult } from "./engineTypes";
import { E2eeSyncPairing } from "./enginePairing";

// W4.11: the engine is split into engineTypes.ts, vaultOpen.ts,
// engineCore.ts, engineKeys.ts and enginePairing.ts (W8.5); everything is still imported from here.
export {
  DropDevicesRequiredError,
  KeyChangeInProgressError,
  NoVaultError,
  PairingAbortedError,
  PairingDuringKeyChangeError,
  PairingPendingError,
  RevocationContestedError,
  UnverifiedDeviceError,
  VaultExistsError,
  type E2eeSyncOptions,
  type PairingComparison,
  type RekeyRequest,
  type RekeyResult,
  type SyncResult,
} from "./engineTypes";
export { createVault, unlockVault, unlockWithDevice } from "./vaultOpen";


export class E2eeSync extends E2eeSyncPairing {
  sync(): Promise<SyncResult> {
    // K6-1 (review 16): under the device lock, from the state as stored, so a
    // tab with an older cached state doesn't save it over another tab's.
    return this.exclusive(() => this.underDeviceLock(true, () => this.round()));
  }

  private async round(): Promise<SyncResult> {
    const s = await this.loadState();
    await this.refresh();
    if (this.o.keys.ring?.preRelease) throw new PreReleaseKeyringError();
    const res: SyncResult = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: [], held: [], counter: 0, retries: 0, incomplete: false };
    if (s.revokedHereReset) {
      res.revokedListReset = true; // G5: said once
      delete s.revokedHereReset;
      await this.save();
    }
    const held = new Set<string>();
    /** Blobs uploaded in this round, reused when a retry pushes the same content again. */
    const uploads = new Map<string, { hash: string; rev: string; size: number; data: Uint8Array; epoch: number }>();

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
      const liveFreeze = !!remote.frozen && !this.o.keys.ring?.aborted.includes(this.remoteDigest);
      if (!liveFreeze && s.frozenSeen) {
        // The run of freezes is over (an unfrozen manifest, or one the keyring
        // lists as called off: ninth review 12.11, H1): the next freeze is
        // waited on in full.
        delete s.frozenSeen;
        await this.save();
      }
      if (liveFreeze) {
        const now = this.o.now();
        // G1: the wait runs from the first of an unbroken run of freezes at
        // this epoch, whatever their digests: a fresh freeze every few
        // minutes doesn't restart it.
        let seen = s.frozenSeen;
        if (!seen || seen.epoch !== this.o.keys.epoch || seen.at > now) {
          seen = s.frozenSeen = { digest: this.remoteDigest, at: now, epoch: this.o.keys.epoch };
          await this.save();
        } else if (seen.digest !== this.remoteDigest) {
          seen.digest = this.remoteDigest;
          await this.save();
        }
        if (now - seen.at < FREEZE_TTL_MS) {
          await this.collectGarbage(remote);
          res.held = [...held];
          res.rekeyPending = true;
          return res;
        }
        const epochBefore = this.o.keys.epoch;
        const calledOff = await this.callOffFreeze(remote, this.remoteDigest);
        if (!calledOff) await this.refresh();
        res.retries++;
        // H1: called off, the run is over: a fresh freeze after it (an honest
        // re-key that starts now) is waited on in full, by rounds and by this
        // device's own re-key (`keyChangeBlockedSince`), even when this round
        // has nothing to upload.
        if (calledOff || this.o.keys.epoch !== epochBefore) {
          delete s.frozenSeen;
          await this.save();
        }
        continue; // read again: under the new keyring the freeze is called off, or the epoch moved on
      }

      if (s.freshness === "unverified") {
        // N6: a device that can't verify it has the latest keys pulls but
        // doesn't upload — served an old epoch, what it wrote would be
        // readable by a device revoked meanwhile. Its changes wait here.
        const waiting = this.localChanges(remote, held, await this.o.local.list());
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
      if (!overFreeze) s.pending.push(...superseded);
      s.committing = [];
      delete s.frozenSeen;
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
    uploads: Map<string, { hash: string; rev: string; size: number; data: Uint8Array; epoch: number }>,
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
        up = { hash, rev, size: data.length, data, epoch: this.o.keys.epoch };
        uploads.set(path, up);
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
