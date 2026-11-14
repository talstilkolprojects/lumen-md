/**
 * A promise with a time limit: it settles as the given promise does, or
 * rejects with a BoundedTimeoutError after `ms`.
 *
 * For checks that must answer even when a browser API or a worker never
 * settles. The AI doctor (src/agents/doctor.ts) runs a dozen local checks
 * in a row. On the e2e build machine one of them never settled, so the
 * report never rendered: no rows, no summary (W4.2). Each check now ends
 * within its limit, and a stuck one shows as its own "timed out" row.
 *
 * The underlying work is not cancelled (most of these APIs take no signal);
 * only the wait for it ends.
 */
export class BoundedTimeoutError extends Error {
  readonly ms: number;
  constructor(ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = "BoundedTimeoutError";
    this.ms = ms;
  }
}

/** `work` (a promise, or a function returning one) bounded to `ms` milliseconds. */
export function bounded<T>(work: Promise<T> | (() => Promise<T>), ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BoundedTimeoutError(ms)), ms);
    let p: Promise<T>;
    try {
      p = typeof work === "function" ? work() : work;
    } catch (e) {
      clearTimeout(timer);
      reject(e);
      return;
    }
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
