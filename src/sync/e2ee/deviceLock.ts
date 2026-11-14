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

/** Tail of the waiters on each lock name held in this realm (the fallback). */
const local = new Map<string, Promise<void>>();

/** Whose lock: the vault, and the store holding this device's state. */
export interface LockScope {
  vaultId: string;
  store: object;
}

const storeIds = new WeakMap<object, number>();
let nextStoreId = 0;

function localName(scope: LockScope): string {
  let id = storeIds.get(scope.store);
  if (id === undefined) storeIds.set(scope.store, (id = ++nextStoreId));
  return `${webName(scope)}:${id}`;
}

const webName = (scope: LockScope) => `lumen-e2ee-device:${scope.vaultId}`;

function webLocks(): LockManager | null {
  const nav = (globalThis as { navigator?: { locks?: LockManager } }).navigator;
  return nav?.locks && typeof nav.locks.request === "function" ? nav.locks : null;
}

async function localLock<T>(name: string, ifAvailable: boolean, fn: () => Promise<T>): Promise<T | typeof LOCK_BUSY> {
  if (ifAvailable && local.has(name)) return LOCK_BUSY;
  const before = local.get(name) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = before.then(() => mine);
  local.set(name, tail);
  await before;
  try {
    return await fn();
  } finally {
    release();
    if (local.get(name) === tail) local.delete(name);
  }
}

/** Run `fn` holding this device's lock, waiting for it if another tab holds it. */
export async function withDeviceLock<T>(scope: LockScope, fn: () => Promise<T>): Promise<T> {
  const locks = webLocks();
  if (locks) return locks.request(webName(scope), () => fn()) as Promise<T>;
  return (await localLock(localName(scope), false, fn)) as T;
}

/** Run `fn` holding this device's lock if it is free now; `LOCK_BUSY` without running it if not. */
export async function tryDeviceLock<T>(scope: LockScope, fn: () => Promise<T>): Promise<T | typeof LOCK_BUSY> {
  const locks = webLocks();
  if (locks) return locks.request(webName(scope), { ifAvailable: true }, (lock) => (lock ? fn() : LOCK_BUSY)) as Promise<T | typeof LOCK_BUSY>;
  return localLock(localName(scope), true, fn);
}
