/**
 * What a device remembers between sync rounds, per vault:
 *
 *   • the freshness anchor — the newest manifest counter and digest it has
 *     verified (the rollback guard), and how that anchor was obtained;
 *   • the base — for every path, the manifest entry its local copy last
 *     matched, plus the base text, which the conflict dialog needs as the
 *     common ancestor of a three-way merge;
 *   • blobs it uploaded that no manifest references yet (an interrupted
 *     round), so it can delete exactly its own orphans later.
 */

import type { RingAnchor } from "./keyring";
import type { FreshnessAnchor, ManifestEntry } from "./manifest";
import type { PairingRequest } from "./pairing";

/**
 * How the device knows its anchor is current:
 *   "created"    — this device created the vault;
 *   "paired"     — the anchor came from an existing device in a signed pairing code;
 *   "confirmed"  — the user confirmed freshness by hand after an unverified start;
 *   "unverified" — trust on first use: the first manifest the provider served
 *                  was accepted as-is. Later rollbacks below it are refused, but
 *                  an old state served from the very start would not be noticed,
 *                  so the UI shows "freshness not verified" and claims no protection.
 *                  Such a device pulls but doesn't upload: its changes wait on it
 *                  until it is paired or confirmed (third review 12.11, N6).
 */
export type FreshnessSource = "created" | "paired" | "confirmed" | "unverified";

/**
 * The devices this device revoked (fifth review 12.11, F2), with their keys
 * and when, authenticated with `mac` (HMAC under a key from epoch 0's secret,
 * which every keyring of the vault carries). Every re-key and every round
 * checks the keyring against it: a keyring that lets one of them back in is
 * a storage that ignored a conditional write, and this device revokes them
 * again on top of it.
 */
export interface RevokedHere {
  devices: Array<{ device: string; recipient?: string; at: number }>;
  mac: string;
}

export interface DeviceState {
  deviceId: string;
  anchor: FreshnessAnchor | null;
  freshness: FreshnessSource;
  base: Record<string, ManifestEntry>;
  /** Uploaded blob names not yet referenced by a committed manifest, and replaced blobs to delete. */
  pending: string[];
  /** Blobs a manifest write in progress would replace; reconciled if its outcome is unknown. */
  committing?: string[];
  /** The highest keyring epoch this device has seen (plan W1.7): an older keyring is a rollback. */
  epoch?: number;
  /**
   * The keyring this device verified last (re-review 12.11, RR-2): every
   * later keyring must descend from it (same epoch: a higher revision that
   * chains to it; a newer epoch: a chain that lists it). Its `check` (third
   * review, N1) binds it to that epoch's secret: keys that don't hold the
   * secret are refused, however they were opened.
   */
  ring?: RingAnchor;
  /**
   * The last re-key this device committed and confirmed by reading it back
   * (third review 12.11, N2): the keyring it replaced (`parent`) and the
   * devices it revoked. If a keyring at that epoch from the same parent
   * replaces it later (a storage that ignored the compare-and-swap), the
   * device revokes them again on top of it.
   */
  rekeyed?: { epoch: number; digest: string; parent: string | null; parentEpoch: number; revoked: string[]; manifest: FreshnessAnchor | null };
  /** The two-way pairing request this device is waiting to have answered (N3). */
  pairRequest?: PairingRequest;
  /**
   * Until when (this device's clock) a pairing code or answer it made is
   * valid (N3): no key change from this device before then, since a device
   * paired with it would not learn of the change.
   */
  pairingUntil?: number;
  /**
   * A frozen manifest this device has been waiting on, and when it first saw
   * it on its own clock (RR-4): the wait is measured on one clock only.
   */
  frozenSeen?: { digest: string; at: number; epoch?: number };
  /**
   * When (this device's clock) a key change from this device was first held
   * back by another device's freeze (seventh review 12.11, G1). The wait is
   * bounded per key change, not per frozen manifest: once FREEZE_TTL_MS has
   * passed since then, the next attempt freezes over whatever freeze is
   * there, so a device that keeps writing fresh freezes (the one being
   * revoked, which still holds the epoch's secret) can't hold it back for
   * ever. Cleared when a key change from this device commits.
   */
  rekeyBlocked?: { since: number };
  /**
   * Blobs replaced by a commit written over a called-off freeze (RR-4):
   * deleted only after a later round has seen the keyring and the manifest
   * still agree they are unreferenced.
   */
  hold?: string[];
  /** The devices this device revoked (F2): see `RevokedHere`. */
  revokedHere?: RevokedHere;
  /**
   * Every device the sealed `revoked` list of a keyring this device adopted
   * named (seventh review 12.11, G5). The sealed list only grows, so a later
   * keyring that leaves one of them out, or lets one back in, is refused
   * like a readmission — without `revokedHere`, which a reinstall or a
   * restored backup can lose.
   */
  sealedRevoked?: Array<{ device: string; recipient?: string }>;
  /** `revokedHere` didn't verify and was set aside (G5): the next round says so (`SyncResult.revokedListReset`). */
  revokedHereReset?: true;
}

export interface SyncStateStore {
  load(): Promise<DeviceState | null>;
  save(s: DeviceState): Promise<void>;
  getBase(path: string): Promise<Uint8Array | null>;
  setBase(path: string, data: Uint8Array | null): Promise<void>;
}

export function memoryStateStore(): SyncStateStore & { state: DeviceState | null } {
  const bases = new Map<string, Uint8Array>();
  const store = {
    state: null as DeviceState | null,
    async load() {
      return store.state ? (JSON.parse(JSON.stringify(store.state)) as DeviceState) : null;
    },
    async save(s: DeviceState) {
      store.state = JSON.parse(JSON.stringify(s)) as DeviceState;
    },
    async getBase(path: string) {
      return bases.get(path)?.slice() ?? null;
    },
    async setBase(path: string, data: Uint8Array | null) {
      if (data) bases.set(path, data.slice());
      else bases.delete(path);
    },
  };
  return store;
}

/** The browser store: IndexedDB through idb-keyval, one database per vault id. */
export async function idbStateStore(vaultId: string): Promise<SyncStateStore> {
  const { createStore, get, set, del } = await import("idb-keyval");
  const db = createStore(`lumen-e2ee-${vaultId}`, "state");
  return {
    async load() {
      return (await get<DeviceState>("device", db)) ?? null;
    },
    async save(s) {
      await set("device", s, db);
    },
    async getBase(path) {
      return (await get<Uint8Array>(`base:${path}`, db)) ?? null;
    },
    async setBase(path, data) {
      if (data) await set(`base:${path}`, data, db);
      else await del(`base:${path}`, db);
    },
  };
}
