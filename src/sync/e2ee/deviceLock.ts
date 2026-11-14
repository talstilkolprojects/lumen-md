/**
 * One lock per device across the tabs of a browser (ninth review 12.11, H3).
 *
 * Every tab runs its own `E2eeSync` over the same stored device state, and
 * each engine serialises only its own calls. A key change in one tab and a
 * pairing code in another must not overlap: the code would vouch for the
 * epoch the change is replacing. The Web Locks API (`navigator.locks`) is
 * shared by every tab of an origin, so a key change holds this lock while it
 * runs and a pairing code or answer is made only when it can take the lock
 * at once.
 *
 * Without the Web Locks API (an old browser, Node) the same lock is kept in
 * this JavaScript realm only: engines in one tab (or one test) still exclude
 * each other, but tabs don't. Every browser the app supports has the API.
 *
 * The name (review 16, K6-3) never depends on the device id an engine has
 * cached: two tabs that started on an empty store each make their own id
 * until one of them saves. Across tabs (Web Locks) every tab of an origin is
 * the same device, so the lock is named by the vault alone. In one realm,
 * engines over the same state store are the same device, and engines over
 * different stores are different devices (several simulated devices in one
 * test): the fallback lock is named by the vault and the store object.
 */

/** What `tryDeviceLock` returns when the lock is held elsewhere. */
export const LOCK_BUSY: unique symbol = Symbol("lock busy");

/** What `withDeviceLockWithin` returns when the lock wasn't granted in time (review 34, K34-1). */
export const LOCK_TIMEOUT: unique symbol = Symbol("lock timeout");

/** Tail of the waiters on each lock name held in this realm (the fallback). */
const local = new Map<string, LocalQueue>();

/** Whose lock: the vault, and the store holding this device's state. */
export interface LockScope {
  vaultId: string;
  store: object;
  /** A second lock beside the device's own, e.g. "keys": held while a key change runs (K34-2). */
  part?: string;
}

const storeIds = new WeakMap<object, number>();
let nextStoreId = 0;

function localName(scope: LockScope): string {
  let id = storeIds.get(scope.store);
  if (id === undefined) storeIds.set(scope.store, (id = ++nextStoreId));
  return `${webName(scope)}:${id}`;
}

const webName = (scope: LockScope) => `lumen-e2ee-device:${scope.vaultId}${scope.part ? `:${scope.part}` : ""}`;

function webLocks(): LockManager | null {
  const nav = (globalThis as { navigator?: { locks?: LockManager } }).navigator;
  return nav?.locks && typeof nav.locks.request === "function" ? nav.locks : null;
}

/** One lock name held in this realm (the fallback): whether it is held, and who waits, first in first out. */
interface LocalQueue {
  held: boolean;
  waiters: Array<() => void>;
}

async function localLock<T>(name: string, mode: { ifAvailable?: boolean; waitMs?: number }, fn: () => Promise<T>): Promise<T | typeof LOCK_BUSY | typeof LOCK_TIMEOUT> {
  let q = local.get(name);
  if (!q) local.set(name, (q = { held: false, waiters: [] }));
  const queue = q;
  if (queue.held || queue.waiters.length) {
    if (mode.ifAvailable) return LOCK_BUSY;
    const granted = await new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grant = () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(true);
      };
      if (mode.waitMs !== undefined) {
        timer = setTimeout(() => {
          const i = queue.waiters.indexOf(grant);
          if (i >= 0) queue.waiters.splice(i, 1);
          resolve(false);
        }, mode.waitMs);
      }
      queue.waiters.push(grant);
    });
    if (!granted) return LOCK_TIMEOUT;
  }
  queue.held = true;
  try {
    return await fn();
  } finally {
    const next = queue.waiters.shift();
    if (next) next();
    else {
      queue.held = false;
      local.delete(name);
    }
  }
}

/** Run `fn` holding this device's lock, waiting for it if another tab holds it. */
export async function withDeviceLock<T>(scope: LockScope, fn: () => Promise<T>): Promise<T> {
  const locks = webLocks();
  if (locks) return locks.request(webName(scope), () => fn()) as Promise<T>;
  return (await localLock(localName(scope), {}, fn)) as T;
}

/**
 * Run `fn` holding this device's lock, waiting at most `waitMs` for it
 * (review 34, K34-1): `LOCK_TIMEOUT`, without running `fn`, when another
 * tab still holds it then (a round stuck on a storage request, say).
 */
export async function withDeviceLockWithin<T>(scope: LockScope, waitMs: number, fn: () => Promise<T>): Promise<T | typeof LOCK_TIMEOUT> {
  const locks = webLocks();
  if (!locks) return localLock(localName(scope), { waitMs }, fn) as Promise<T | typeof LOCK_TIMEOUT>;
  let started = false;
  try {
    return (await locks.request(webName(scope), { signal: AbortSignal.timeout(waitMs) }, () => {
      started = true;
      return fn();
    })) as T;
  } catch (e) {
    if (!started && (e as Error)?.name !== undefined && ["TimeoutError", "AbortError"].includes((e as Error).name)) return LOCK_TIMEOUT;
    throw e;
  }
}

/** Run `fn` holding this device's lock if it is free now; `LOCK_BUSY` without running it if not. */
export async function tryDeviceLock<T>(scope: LockScope, fn: () => Promise<T>): Promise<T | typeof LOCK_BUSY> {
  const locks = webLocks();
  if (locks) return locks.request(webName(scope), { ifAvailable: true }, (lock) => (lock ? fn() : LOCK_BUSY)) as Promise<T | typeof LOCK_BUSY>;
  return localLock(localName(scope), { ifAvailable: true }, fn) as Promise<T | typeof LOCK_BUSY>;
}
