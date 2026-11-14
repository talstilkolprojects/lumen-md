/**
 * Wait until the write queue is empty: a write queued while an earlier one
 * was awaited is awaited too, until the queue is the same promise after the
 * await (review #272, step 2.25). A snapshot of the queue would let a
 * highlight edit made meanwhile be dropped on close.
 */
export async function drainQueue(queue: { readonly current: Promise<unknown> }): Promise<void> {
  for (;;) {
    const seen = queue.current;
    await seen;
    if (queue.current === seen) return;
  }
}
