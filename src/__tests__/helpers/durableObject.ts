/**
 * A small simulation of a Cloudflare Durable Object's storage and state,
 * for the Worker tests (plan W6.23): get / put / delete (one key, a list or
 * an object of entries), list({prefix, start, limit}) in key order, alarms,
 * blockConcurrencyWhile. Values are copied in and out, as structured clone
 * does. `evict()` keeps the storage and drops the object, as Cloudflare does
 * with an idle object.
 */
export type Stored = Map<string, unknown>;

const clone = <T>(v: T): T => (v instanceof Uint8Array ? (new Uint8Array(v) as T) : structuredClone(v));

export class FakeStorage {
  readonly data: Stored = new Map();
  alarm: number | null = null;
  writes = 0;
  async get(key: string | string[]): Promise<unknown> {
    if (Array.isArray(key)) return new Map(key.filter((k) => this.data.has(k)).map((k) => [k, clone(this.data.get(k))]));
    return this.data.has(key) ? clone(this.data.get(key)) : undefined;
  }
  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof key === "string" ? [[key, value] as const] : Object.entries(key);
    if (entries.length > 128) throw new Error("put: at most 128 keys");
    for (const [k, v] of entries) {
      this.data.set(k, clone(v));
      this.writes++;
    }
  }
  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      if (key.length > 128) throw new Error("delete: at most 128 keys");
      let n = 0;
      for (const k of key) if (this.data.delete(k)) n++;
      return n;
    }
    return this.data.delete(key);
  }
  async list(opts: { prefix?: string; start?: string; limit?: number } = {}): Promise<Map<string, unknown>> {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(opts.prefix ?? "") && (opts.start === undefined || k >= opts.start)).sort();
    return new Map(keys.slice(0, opts.limit ?? Infinity).map((k) => [k, clone(this.data.get(k))]));
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(t: number): Promise<void> {
    this.alarm = t;
  }
  /** Every stored byte, for scans: keys and values. */
  dump(): Array<[string, Uint8Array]> {
    return [...this.data].map(([k, v]) => [k, v instanceof Uint8Array ? v : new TextEncoder().encode(`${k}=${JSON.stringify(v, (_, x) => (x instanceof Uint8Array ? Buffer.from(x).toString("latin1") : x))}`)]);
  }
}

export interface FakeState {
  storage: FakeStorage;
  ready: Promise<void>;
  blockConcurrencyWhile(fn: () => Promise<unknown>): Promise<unknown>;
}

export function fakeState(storage = new FakeStorage()): FakeState {
  const state: FakeState = {
    storage,
    ready: Promise.resolve(),
    blockConcurrencyWhile(fn) {
      const p = fn();
      state.ready = p.then(() => undefined);
      return p;
    },
  };
  return state;
}
