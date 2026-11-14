/**
 * `SyncProvider` (plan 3.4, steps 4 and 10): what the encrypted sync needs
 * from a storage service — a flat bucket of named, opaque objects with
 * conditional writes. Real providers (Dropbox, Google Drive, WebDAV, S3) are
 * plan 3.5; each maps `put`'s condition onto its own primitive (WebDAV and S3
 * `If-Match`, Dropbox `mode: update` with a rev).
 *
 * The provider only ever receives the fixed header name, 43-character HMAC
 * names and sealed bytes (see keys.ts and manifest.ts).
 */

export interface StoredObject {
  data: Uint8Array;
  /** The provider's revision / ETag of this object, opaque to the client. */
  etag: string;
}

/**
 * The condition for `put`:
 *   { ifMatch: etag }    — replace only if the object is still at `etag` (compare-and-swap);
 *   { ifNoneMatch: "*" } — create only if nothing is there yet;
 *   undefined            — unconditional.
 */
export type PutCondition = { ifMatch: string } | { ifNoneMatch: "*" } | undefined;

export interface SyncProvider {
  /** Short identifier for logs ("memory", "webdav"…). */
  readonly id: string;
  /** The object, or null when there is none. */
  get(name: string): Promise<StoredObject | null>;
  /** Write; rejects with `PreconditionFailedError` when `cond` does not hold. Returns the new etag. */
  put(name: string, data: Uint8Array, cond?: PutCondition): Promise<{ etag: string }>;
  /** Delete; a no-op when the object is missing. */
  delete(name: string): Promise<void>;
  /** Every object name. */
  list(): Promise<string[]>;
}

export class PreconditionFailedError extends Error {
  constructor(public readonly objectName: string) {
    super("The object changed since it was read (precondition failed)");
    this.name = "PreconditionFailedError";
  }
}

/** A transient failure (network down, timeout); the sync round can be retried. */
export class ProviderUnavailableError extends Error {
  constructor(message = "The sync provider is unavailable") {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

export interface MemoryProviderOptions {
  /**
   * Called before and after each operation; throw from it to simulate a
   * network failure. `phase: "after"` with a write simulates "the write
   * happened but the answer was lost".
   */
  fault?: (op: "get" | "put" | "delete" | "list", name: string, phase: "before" | "after") => void;
  /** Awaited inside each operation so concurrent devices interleave (tests). */
  yield?: () => Promise<void>;
}

/** An in-memory provider: the simulated folder of the tests. `objects` is what the provider sees. */
export interface MemoryProvider extends SyncProvider {
  readonly objects: Map<string, StoredObject>;
}

export function memoryProvider(opts: MemoryProviderOptions = {}): MemoryProvider {
  const objects = new Map<string, StoredObject>();
  let seq = 0;
  const step = async (op: "get" | "put" | "delete" | "list", name: string, phase: "before" | "after") => {
    if (opts.yield) await opts.yield();
    opts.fault?.(op, name, phase);
  };
  return {
    id: "memory",
    objects,
    async get(name) {
      await step("get", name, "before");
      const o = objects.get(name);
      const out = o ? { data: o.data.slice(), etag: o.etag } : null;
      await step("get", name, "after");
      return out;
    },
    async put(name, data, cond) {
      await step("put", name, "before");
      const cur = objects.get(name);
      if (cond && "ifMatch" in cond && cur?.etag !== cond.ifMatch) throw new PreconditionFailedError(name);
      if (cond && "ifNoneMatch" in cond && cur) throw new PreconditionFailedError(name);
      const etag = `e${++seq}-${Math.random().toString(36).slice(2, 8)}`;
      objects.set(name, { data: data.slice(), etag });
      await step("put", name, "after");
      return { etag };
    },
    async delete(name) {
      await step("delete", name, "before");
      objects.delete(name);
      await step("delete", name, "after");
    },
    async list() {
      await step("list", "", "before");
      const names = [...objects.keys()];
      await step("list", "", "after");
      return names;
    },
  };
}
