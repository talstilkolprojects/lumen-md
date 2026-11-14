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

import type { FreshnessAnchor, ManifestEntry } from "./manifest";

/**
 * How the device knows its anchor is current:
 *   "created"    — this device created the vault;
 *   "paired"     — the anchor came from an existing device in a signed pairing code;
 *   "confirmed"  — the user confirmed freshness by hand after an unverified start;
 *   "unverified" — trust on first use: the first manifest the provider served
 *                  was accepted as-is. Later rollbacks below it are refused, but
 *                  an old state served from the very start would not be noticed,
 *                  so the UI shows "freshness not verified" and claims no protection.
 */
export type FreshnessSource = "created" | "paired" | "confirmed" | "unverified";

export interface DeviceState {
  deviceId: string;
  anchor: FreshnessAnchor | null;
  freshness: FreshnessSource;
  base: Record<string, ManifestEntry>;
  /** Uploaded blob names not yet referenced by a committed manifest, and replaced blobs to delete. */
  pending: string[];
  /** Blobs a manifest write in progress would replace; reconciled if its outcome is unknown. */
  committing?: string[];
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
