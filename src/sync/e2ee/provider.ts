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

import { randomBytes, toB64u } from "./bytes";

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
  /**
   * False when create-only (`ifNoneMatch: "*"`) isn't atomic on this storage
   * (Google Drive: look → create → look, third review 12.11 N7). Syncing
   * works; key and device changes are refused (`proveCas`): sync-only.
   */
  readonly atomicCreate?: boolean;
}

export class PreconditionFailedError extends Error {
  constructor(public readonly objectName: string) {
    super("The object changed since it was read (precondition failed)");
    this.name = "PreconditionFailedError";
  }
}

/**
 * The provider doesn't refuse a stale conditional write (re-review 12.11,
 * RR-7/RR-8). Syncing still works — a lost race at worst costs an extra
 * round — but a re-key or an enrollment could silently fork the keys, so
 * those are refused on it.
 */
export class CasUnsupportedError extends Error {
  constructor(public readonly provider: string, detail: string) {
    super(
      `This storage (${provider}) doesn't refuse stale conditional writes (${detail}). Lumen can sync with it, but it can't change keys or devices here: a re-key, a revocation or an enrollment could silently fork the keys. Use a storage that supports If-Match / If-None-Match (see the docs).`,
    );
    this.name = "CasUnsupportedError";
  }
}

const proven = new WeakSet<object>();

/**
 * How hard the probes push (W6.27, measured against real servers): three
 * If-Match replacements in a row, and three rounds of four racing creates.
 * With one replacement and one race of two, the probe accepted WsgiDAV 4.4.0
 * 11 times in 200 and sabre/dav 4.7.1's FS backend 6 in 200.
 */
export const PROBE_REPLACEMENTS = 3;
export const PROBE_RACE_ROUNDS = 3;
export const PROBE_RACE_WRITERS = 4;

/** A random 43-character name and sealed-blob-sized random bytes: what a blob upload looks like (N2). */
function probeObject(): { name: string; data: () => Uint8Array } {
  const name = toB64u(randomBytes(32));
  const size = 1 + 12 + 256 + 16; // format byte, nonce, the smallest padded plaintext, tag
  return {
    name,
    data: () => {
      const d = randomBytes(size);
      d[0] = 1;
      return d;
    },
  };
}

/**
 * Prove that `provider` honours both conditions (RR-7): create-only on a
 * new object succeeds and on an existing one is refused — also when two
 * creates race —; If-Match with the current etag succeeds and with a stale
 * one is refused, leaving the object as it was. Throws `CasUnsupportedError`
 * when a condition is ignored, or when the provider says its create-only
 * isn't atomic (`atomicCreate: false`, N7). The result is remembered per
 * provider object.
 *
 * The probe objects have random names and blob-sized random contents (N2),
 * so a provider can't single the probe out by its name. This proves a
 * storage is configured right; it can't prove a malicious one honours the
 * conditions on the writes that matter — the engine reads each keyring
 * write back for that (spec §9).
 */
export async function proveCas(provider: SyncProvider): Promise<void> {
  if (proven.has(provider)) return;
  if (provider.atomicCreate === false) throw new CasUnsupportedError(provider.id, "its create-only write is not atomic");
  const probe = probeObject();
  const race = probeObject();
  const name = probe.name;
  const refused = async (data: Uint8Array, cond: PutCondition): Promise<boolean> => {
    try {
      await provider.put(name, data, cond);
      return false;
    } catch (e) {
      if (e instanceof PreconditionFailedError) return true;
      throw e;
    }
  };
  const races: string[] = [];
  try {
    const first = probe.data();
    let cur = await provider.put(name, first, { ifNoneMatch: "*" });
    if (!(await refused(probe.data(), { ifNoneMatch: "*" }))) throw new CasUnsupportedError(provider.id, "If-None-Match: * on an existing object was accepted");
    // Several replacements back to back (W6.27): on a server whose ETag is the
    // file's mtime in seconds (WsgiDAV, sabre/dav's FS backend), one
    // replacement that happens to straddle a second passes; three in a row don't.
    for (let i = 0; i < PROBE_REPLACEMENTS; i++) {
      const next = probe.data();
      const b = await provider.put(name, next, { ifMatch: cur.etag });
      if (b.etag === cur.etag) throw new CasUnsupportedError(provider.id, "a write kept the same etag");
      if (!(await refused(probe.data(), { ifMatch: cur.etag }))) throw new CasUnsupportedError(provider.id, "If-Match with a stale etag was accepted");
      const now = await provider.get(name);
      if (!now || !sameBytes(now.data, next) || now.etag !== b.etag) throw new CasUnsupportedError(provider.id, "a refused write changed the object");
      cur = b;
    }
    // Creates at once: exactly one may win (where the storage lets a race show).
    for (let round = 0; round < PROBE_RACE_ROUNDS; round++) {
      const r = round === 0 ? race : probeObject();
      races.push(r.name);
      const wins = await Promise.all(Array.from({ length: PROBE_RACE_WRITERS }, () => r.data()).map((d) => provider.put(r.name, d, { ifNoneMatch: "*" }).then(() => 1, (e) => (e instanceof PreconditionFailedError ? 0 : Promise.reject(e)))));
      if (wins.reduce((x, y) => x + y, 0) !== 1) throw new CasUnsupportedError(provider.id, "racing create-only writes both succeeded");
    }
  } finally {
    await provider.delete(name).catch(() => undefined);
    for (const r of races.length ? races : [race.name]) await provider.delete(r).catch(() => undefined);
  }
  proven.add(provider);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
