/**
 * The encrypted vault relay (plan W4.19, sync-server/vault-relay.js) on
 * Cloudflare Workers + one SQLite Durable Object, on the Workers Free plan
 * (plan W6.23).
 *
 *   GET    /v1/vault/o/            → {"names": [...]}
 *   GET    /v1/vault/o/<name>      → bytes + ETag
 *   PUT    /v1/vault/o/<name>      If-Match / If-None-Match: *
 *   DELETE /v1/vault/o/<name>
 *   GET    /healthz                {"ok":true,"service":"lumen-vault-relay"}
 *
 * It is the same relay as the Node server: every request goes to
 * createVaultRelay() from sync-server/vault-relay.js, unchanged in what it
 * checks (tokens, sizes, the limits, the proof of work). Only the parts a
 * Node process keeps on its disk or in its memory live here in the Durable
 * Object's storage:
 *   - the objects (`m|` metadata, `d|` chunks of CHUNK bytes; a SQLite
 *     Durable Object stores a value of up to 2 MB),
 *   - each space's charged bytes and last use (`s|`), and the total (`T`),
 *   - the day's per-address counts (`c|`) and the day's HMAC key (`k|`): a
 *     Durable Object is evicted when idle, and a count kept only in memory
 *     would start again (the per-address daily limits would not hold).
 *     They are HMACs under the day's key, never addresses, and the previous
 *     day's are deleted with the day, as the Node relay forgets them.
 * One object for the whole relay ("relay"), so the global ceiling
 * (VAULT_RELAY_MAX_TOTAL) and the daily counts are exact.
 *
 * The client address is Cloudflare's CF-Connecting-IP (a client can't set
 * it). Workers Logs are off (wrangler.toml): nothing about requests is
 * logged.
 *
 * Deploy: `npm run share:deploy` (docs: sync/relay-server).
 */
import { Buffer } from "node:buffer";
import relay from "../../sync-server/vault-relay.js";

const { createVaultRelay, charge, etagOf } = relay;

/** A chunk of an object in storage (under the 2 MB value limit of a SQLite Durable Object). */
export const CHUNK = 512 * 1024;
const DAY = 86_400_000;
const BATCH = 128; // keys per storage.get / put / delete call

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "" || /\/health(z)?$/.test(path)) return json({ ok: true, status: "ok", service: "lumen-vault-relay", persistence: "durable-objects" });
    if (!url.pathname.startsWith("/v1/vault/o/")) return json({ error: "not found" }, 404);
    // The address the relay counts: Cloudflare's, never one the client sent.
    const headers = new Headers(request.headers);
    headers.set("x-lumen-client", request.headers.get("cf-connecting-ip") ?? "unknown");
    return env.RELAY.get(env.RELAY.idFromName("relay")).fetch(new Request(request, { headers }));
  },
};

const num = (v, d) => (v === undefined || v === "" || !Number.isFinite(Number(v)) || Number(v) <= 0 ? d : Number(v));

async function* listKeys(storage, prefix) {
  let start;
  for (;;) {
    const page = await storage.list({ prefix, start, limit: 1000 });
    let last;
    for (const [k, v] of page) {
      if (k === start) continue;
      last = k;
      yield [k, v];
    }
    if (last === undefined || page.size < 1000) return;
    start = last;
  }
}
async function deleteKeys(storage, keys) {
  for (let i = 0; i < keys.length; i += BATCH) await storage.delete(keys.slice(i, i + BATCH));
}

/** sync-server/vault-relay.js's store, in Durable Object storage. */
export function durableStore(storage) {
  const meta = (space, name) => `m|${space}|${name}`;
  const chunk = (space, name, v, i) => `d|${space}|${name}|${v}|${i}`;
  const chunkKeys = (space, name, m) => Array.from({ length: m.n }, (_, i) => chunk(space, name, m.v, i));
  const addBytes = async (space, delta, now) => {
    const s = (await storage.get(`s|${space}`)) ?? { bytes: 0, at: now };
    const next = { bytes: s.bytes + delta, at: now };
    const total = ((await storage.get("T")) ?? 0) + delta;
    await storage.put({ [`s|${space}`]: next, T: Math.max(0, total) });
  };
  return {
    async list(space) {
      const names = [];
      for await (const [k] of listKeys(storage, `m|${space}|`)) names.push(k.slice(space.length + 3));
      return names;
    },
    async get(space, name) {
      const m = await storage.get(meta(space, name));
      if (!m) return null;
      const keys = chunkKeys(space, name, m);
      const parts = [];
      for (let i = 0; i < keys.length; i += BATCH) {
        const got = await storage.get(keys.slice(i, i + BATCH));
        for (const k of keys.slice(i, i + BATCH)) {
          const p = got.get(k);
          if (!p) return null; // a write in between: the caller sees no object
          parts.push(p instanceof Uint8Array ? p : new Uint8Array(p));
        }
      }
      return { data: Buffer.concat(parts, m.size), etag: m.etag };
    },
    async put(space, name, data) {
      const now = Date.now();
      const old = await storage.get(meta(space, name));
      const v = (old?.v ?? 0) + 1;
      const n = Math.max(1, Math.ceil(data.length / CHUNK));
      // The new version's chunks first, then its metadata: a reader sees the old object or the new one.
      for (let i = 0; i < n; i += BATCH) {
        const entries = {};
        for (let j = i; j < Math.min(n, i + BATCH); j++) entries[chunk(space, name, v, j)] = new Uint8Array(data.subarray(j * CHUNK, (j + 1) * CHUNK));
        await storage.put(entries);
      }
      await storage.put(meta(space, name), { size: data.length, etag: etagOf(data), v, n });
      await addBytes(space, charge(data.length) - (old ? charge(old.size) : 0), now);
      if (old) await deleteKeys(storage, chunkKeys(space, name, old));
    },
    async delete(space, name) {
      const old = await storage.get(meta(space, name));
      if (!old) return;
      await storage.delete(meta(space, name));
      await deleteKeys(storage, chunkKeys(space, name, old));
      await addBytes(space, -charge(old.size), Date.now());
    },
    async bytes(space) {
      return (await storage.get(`s|${space}`))?.bytes ?? 0;
    },
    async has(space) {
      return (await storage.get(`s|${space}`)) !== undefined;
    },
    async touch(space) {
      const s = await storage.get(`s|${space}`);
      if (s) await storage.put(`s|${space}`, { ...s, at: Date.now() });
    },
    async totalBytes() {
      return (await storage.get("T")) ?? 0;
    },
    async sweep(olderThan) {
      let n = 0;
      const old = [];
      for await (const [k, s] of listKeys(storage, "s|")) if (s.at < olderThan) old.push([k.slice(2), s]);
      for (const [space, s] of old) {
        const keys = [];
        for await (const [k] of listKeys(storage, `m|${space}|`)) keys.push(k);
        for await (const [k] of listKeys(storage, `d|${space}|`)) keys.push(k);
        await deleteKeys(storage, keys);
        await storage.delete(`s|${space}`);
        await storage.put("T", Math.max(0, ((await storage.get("T")) ?? 0) - s.bytes));
        n++;
      }
      return n;
    },
  };
}

/**
 * A count-min sketch like vault-relay.js's, whose cells are kept in storage
 * under the day: `c|<name>|<day>|<row>|<cell>`. Loaded once when the object
 * starts (`cells`: what storage held), so get() and add() stay synchronous.
 */
export function storedSketch(storage, name, width, loaded, depth = 4) {
  const rows = Array.from({ length: depth }, () => new Map());
  let day = loaded.day;
  for (const [row, cell, value] of loaded.cells) rows[row]?.set(cell, value);
  return {
    get: (cells) => Math.min(...cells.map((c, d) => rows[d].get(c) ?? 0)),
    add: (cells, n) =>
      cells.forEach((c, d) => {
        const v = (rows[d].get(c) ?? 0) + n;
        rows[d].set(c, v);
        // Not awaited: the Durable Object's output gate holds the answer until the write is durable.
        void storage.put(`c|${name}|${day}|${d}|${c}`, v);
      }),
    reset: (today) => {
      if (today === day) return; // the object restarted within the day: keep its counts
      day = today;
      rows.forEach((r) => r.clear());
      void (async () => {
        const stale = [];
        for await (const [k] of listKeys(storage, `c|${name}|`)) if (k.split("|")[2] !== String(today)) stale.push(k);
        await deleteKeys(storage, stale);
      })();
    },
    cells: (digest) => rows.map((_, d) => digest.readUInt32BE(d * 4) % width),
  };
}

/** The whole relay: one object, so its limits are exact. */
export class VaultRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.relay = null;
    state.blockConcurrencyWhile(() => this.start());
  }

  async start() {
    const storage = this.state.storage;
    const today = Math.floor(Date.now() / DAY);
    // The day's counts and key, as the last run of this object left them.
    const loaded = new Map();
    for await (const [k, v] of listKeys(storage, "c|")) {
      const [, name, day, row, cell] = k.split("|");
      if (Number(day) !== today) continue;
      if (!loaded.has(name)) loaded.set(name, []);
      loaded.get(name).push([Number(row), Number(cell), v]);
    }
    const keys = new Map();
    for await (const [k, v] of listKeys(storage, "k|")) keys.set(Number(k.slice(2)), v);
    const dayKey = (day) => {
      let key = keys.get(day);
      if (!key) {
        key = crypto.getRandomValues(new Uint8Array(32));
        keys.set(day, key);
        void storage.put(`k|${day}`, key);
        // Yesterday's key goes with yesterday's counts.
        for (const d of [...keys.keys()]) if (d !== day) (keys.delete(d), void storage.delete(`k|${d}`));
      }
      return Buffer.from(key);
    };
    const e = this.env;
    this.relay = createVaultRelay({
      store: durableStore(storage),
      sweep: false,
      clientAddress: (req) => req.headers["x-lumen-client"] || "unknown",
      daySketch: (name, width) => storedSketch(storage, name, width, { day: loaded.has(name) ? today : -1, cells: loaded.get(name) ?? [] }),
      dayKey,
      maxObjectBytes: num(e.VAULT_RELAY_MAX_OBJECT, 2 * 1024 * 1024),
      maxSpaceBytes: num(e.VAULT_RELAY_MAX_SPACE, 128 * 1024 * 1024),
      maxTotalBytes: num(e.VAULT_RELAY_MAX_TOTAL, 768 * 1024 * 1024),
      ratePerMinute: num(e.VAULT_RELAY_RATE, 600),
      retentionDays: num(e.VAULT_RELAY_RETENTION_DAYS, 180),
      newSpacesPerDay: num(e.VAULT_RELAY_NEW_SPACES_PER_DAY, 5),
      newSpacesPer48: e.VAULT_RELAY_NEW_SPACES_PER_48 ? num(e.VAULT_RELAY_NEW_SPACES_PER_48, 80) : undefined,
      addressBytesPerDay: num(e.VAULT_RELAY_ADDRESS_BYTES_PER_DAY, 128 * 1024 * 1024),
      powBits: num(e.VAULT_RELAY_POW_BITS, 0),
      invite: e.VAULT_RELAY_INVITE ?? "",
    });
    if ((await storage.getAlarm()) === null) await storage.setAlarm(Date.now() + DAY);
  }

  /** Retention: once a day, spaces nobody read or wrote for VAULT_RELAY_RETENTION_DAYS go. */
  async alarm() {
    await this.relay.sweep();
    await this.state.storage.setAlarm(Date.now() + DAY);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const headers = {};
    for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
    const req = requestFor(request, `${url.pathname}${url.search}`, headers);
    return new Promise((resolve) => {
      const res = {
        status: 200,
        headers: {},
        writeHead(status, h = {}) {
          this.status = status;
          this.headers = h;
        },
        end(body) {
          const empty = this.status === 204 || this.status === 304;
          resolve(new Response(empty ? null : body ?? "", { status: this.status, headers: this.headers }));
        },
      };
      if (!this.relay.handle(req, res)) resolve(json({ error: "not found" }, 404));
    });
  }
}

/**
 * The parts of Node's IncomingMessage that vault-relay.js reads: method,
 * url, headers and the body as "data" / "end" events, streamed from the
 * Fetch request so an oversized body is cut off (req.destroy) without being
 * read whole.
 */
function requestFor(request, url, headers) {
  const listeners = { data: [], end: [], error: [] };
  let started = false;
  let reader = null;
  const emit = (ev, x) => listeners[ev].forEach((fn) => fn(x));
  const start = () => {
    if (started) return;
    started = true;
    queueMicrotask(async () => {
      try {
        if (request.body) {
          reader = request.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value?.byteLength) emit("data", Buffer.from(value.buffer, value.byteOffset, value.byteLength));
            if (reader === null) return; // destroyed
          }
        }
        emit("end");
      } catch (e) {
        if (reader !== null) emit("error", e);
      }
    });
  };
  return {
    method: request.method,
    url,
    headers,
    on(ev, fn) {
      if (listeners[ev]) listeners[ev].push(fn);
      if (ev === "data" || ev === "end") start();
      return this;
    },
    // vault-relay.js (#483, reviewed) reads an oversized body on to the end and answers 413, and only past
    // four times the limit cuts the connection (req.destroy). A Worker has no connection to cut: the rest of
    // the body is cancelled and the body ends there, so readBody still answers 413 (train 5).
    destroy() {
      const r = reader;
      if (r === null) return;
      reader = null;
      void r.cancel().catch(() => undefined);
      emit("end");
    },
  };
}
