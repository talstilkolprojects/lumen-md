/**
 * The workspace index's waits: a deadline for the vault listing, and the
 * wait of a build for an unlock or a move (plan W6.25: moved out of
 * workspaceIndex.ts unchanged).
 */

export class CheckTimeoutError extends Error {}

/** `p`, or a rejection (CheckTimeoutError) after `ms`. */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CheckTimeoutError(`the vault listing did not settle in ${ms} ms`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Builds waiting for an unlock (U2): woken by the unlock, by `dropIndex` and by any structural change (a vault switch). */
const wakers = new Set<() => void>();
export function wakeBuilds(): void {
  for (const w of [...wakers]) w();
}

/**
 * A wait that ends on unlock (./vault/encrypted/session UNLOCKED_EVENT), on
 * `dropIndex` or on a structural change such as a vault switch (review 14.11
 * U2). Registered before the caller reads the state, so an unlock in between
 * is not lost; `cancel` when the state turned out not to be locked.
 */
export function wakeOnUnlockOrMove(): { woke: Promise<void>; cancel: () => void } {
  let done!: () => void;
  const woke = new Promise<void>((resolve) => {
    done = () => {
      wakers.delete(done);
      if (typeof window !== "undefined") window.removeEventListener("lumen-vault-unlocked", done);
      resolve();
    };
  });
  wakers.add(done);
  if (typeof window !== "undefined") window.addEventListener("lumen-vault-unlocked", done);
  return { woke, cancel: done };
}
