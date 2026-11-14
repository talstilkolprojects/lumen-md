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
 */

/** What `tryDeviceLock` returns when the lock is held elsewhere. */
export const LOCK_BUSY: unique symbol = Symbol("lock busy");

/** Tail of the waiters on each lock name held in this realm (the fallback). */
const local = new Map<string, Promise<void>>();

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

/** Run `fn` holding the lock `name`, waiting for it if another tab holds it. */
export async function withDeviceLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = webLocks();
  if (locks) return locks.request(name, () => fn()) as Promise<T>;
  return (await localLock(name, false, fn)) as T;
}

/** Run `fn` holding the lock `name` if it is free now; `LOCK_BUSY` without running it if not. */
export async function tryDeviceLock<T>(name: string, fn: () => Promise<T>): Promise<T | typeof LOCK_BUSY> {
  const locks = webLocks();
  if (locks) return locks.request(name, { ifAvailable: true }, (lock) => (lock ? fn() : LOCK_BUSY)) as Promise<T | typeof LOCK_BUSY>;
  return localLock(name, true, fn);
}
