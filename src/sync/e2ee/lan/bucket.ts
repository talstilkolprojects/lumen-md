/**
 * The host's bucket (plan W2.19): the vault's sealed objects, kept in this
 * device's IndexedDB so the host serves the same vault after a reload. The
 * objects are what a WebDAV folder would hold: the header, HMAC-named sealed
 * manifests and blobs. Nothing readable.
 *
 * Writes go through one queue, so a conditional write (compare-and-swap on
 * the etag) can't interleave with another one in this tab.
 */

import { randomBytes, toB64u } from "../bytes";
import { PreconditionFailedError, type StoredObject, type SyncProvider } from "../provider";

interface Row {
  data: Uint8Array;
  etag: string;
}

interface ObjectStore {
  get(name: string): Promise<Row | undefined>;
  set(name: string, row: Row): Promise<void>;
  del(name: string): Promise<void>;
  keys(): Promise<string[]>;
}

async function idbObjects(dbName: string): Promise<ObjectStore> {
  const { createStore, get, set, del, keys } = await import("idb-keyval");
  const store = createStore(dbName, "objects");
  return {
    get: (n) => get<Row>(n, store),
    set: (n, r) => set(n, r, store),
    del: (n) => del(n, store),
    keys: async () => (await keys(store)).map(String),
  };
}

export const HOST_DB = "lumen-lan-host";

/** A SyncProvider over `objects` (IndexedDB by default; a Map in the tests). */
export function bucketProvider(objects: () => Promise<ObjectStore>): SyncProvider {
  let opened: Promise<ObjectStore> | null = null;
  const db = () => (opened ??= objects());
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const run = chain.then(job, job);
    chain = run.catch(() => undefined);
    return run;
  };
  return {
    id: "lan-bucket",
    async get(name): Promise<StoredObject | null> {
      const r = await (await db()).get(name);
      return r ? { data: new Uint8Array(r.data), etag: r.etag } : null;
    },
    put(name, data, cond) {
      return serial(async () => {
        const s = await db();
        const cur = await s.get(name);
        if (cond && "ifMatch" in cond && cur?.etag !== cond.ifMatch) throw new PreconditionFailedError(name);
        if (cond && "ifNoneMatch" in cond && cur) throw new PreconditionFailedError(name);
        const etag = toB64u(randomBytes(9));
        await s.set(name, { data: new Uint8Array(data), etag });
        return { etag };
      });
    },
    delete(name) {
      return serial(async () => (await db()).del(name));
    },
    async list() {
      return (await db()).keys();
    },
  };
}

/** The host bucket of this device. */
export function hostBucket(dbName = HOST_DB): SyncProvider {
  return bucketProvider(() => idbObjects(dbName));
}

/** A bucket in memory, with the same semantics (tests). */
export function mapBucket(map = new Map<string, Row>()): SyncProvider {
  return bucketProvider(async () => ({
    get: async (n) => map.get(n),
    set: async (n, r) => void map.set(n, r),
    del: async (n) => void map.delete(n),
    keys: async () => [...map.keys()],
  }));
}
