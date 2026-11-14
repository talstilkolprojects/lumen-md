/**
 * The encrypted vault relay (plan W4.19, sync-server/vault-relay.js) on
 * Cloudflare Workers + one SQLite Durable Object, on the Workers Free plan
 * (plan W6.23).
 *
 *   GET    /v1/vault/o/            → {"names": [...]}
 *   GET    /v1/vault/o/<name>      → bytes + ETag
 *   PUT    /v1/vault/o/<name>      If-Match / If-None-Match: *
 *   DELETE /v1/vault/o/<name>
 *   GET    /healthz                {"ok":true,"service":"lumen-vault-relay"} (also / and /health;
 *                                   exact paths, so never an object's name)
 *
 * It is the same relay as the Node server: every request goes to
 * createVaultRelay() from sync-server/vault-relay.js, unchanged in what it
 * checks (tokens, sizes, the limits, the proof of work). Only the parts a
 * Node process keeps on its disk or in its memory live here in the Durable
 * Object's storage:
 *   - the objects (`m|` metadata, `d|` chunks of CHUNK bytes; a SQLite
 *     Durable Object stores a value of up to 2 MB),
 *   - each space's charged bytes and last use (`s|`), and the total (`T`),
 *   - the day's per-address counts (`c|`, dayCounters below: a journal and a
 *     snapshot, a bounded number of rows) and the day's HMAC key (`k|`): a
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

/** The health routes: the root, /health and /healthz, and nothing below /v1/vault/o/. */
export const HEALTH = new Set(["", "/health", "/healthz"]);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    // Exact paths only, outside /v1/vault/o/: an object named `health` is an object (review t5, L3).
    if (HEALTH.has(path)) return json({ ok: true, status: "ok", service: "lumen-vault-relay", persistence: "durable-objects" });
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
 * The day's per-address counts (count-min sketches like vault-relay.js's),
 * kept in memory and persisted in a bounded number of rows (review t5, M2):
 *   - `c|<day>|j|<seq>`: a journal row, written once at the end of a request
 *     whose counts changed: the cells that changed, with their new value. A
 *     request whose reservations were all given back (a refused PUT) leaves
 *     every cell as it was persisted and writes nothing.
 *   - `c|<day>|s|<i>` + `c|<day>|m`: a snapshot of every non-zero cell, which
 *     replaces the journal once it holds JOURNAL_MAX rows per snapshot row (or
 *     JOURNAL_MAX when there is no snapshot yet), in one atomic put; the meta
 *     row says up to which journal row the snapshot holds.
 * So a start reads at most (JOURNAL_MAX + 1) × the snapshot's rows + 1 rows,
 * however many addresses the day saw (a sketch has a fixed number of cells),
 * and a counted request costs one row written, plus its share of a snapshot.
 * Values are Float64Array quadruples [sketch, row, cell, value].
 */
export const JOURNAL_MAX = 32;
/** Cells per stored row: 4 × 8 bytes each, 1 MiB a row (the limit is 2 MB). */
export const CELLS_PER_ROW = 32_768;
const SKETCHES = ["spaces", "spaces48", "written"];

export async function dayCounters(storage, today) {
  const sketches = new Map(); // name → { rows: Map<cell, value>[] }
  const persisted = new Map(); // "<i>|<row>|<cell>" → value as storage holds it
  const dirty = new Set();
  let day = today;
  let seq = 0;
  let upTo = -1;
  let snapRows = 0;
  let journal = 0;
  const idx = (name) => {
    const i = SKETCHES.indexOf(name);
    if (i < 0) throw new Error(`unknown sketch ${name}`);
    return i;
  };
  const rowsOf = (i) => {
    const name = SKETCHES[i];
    if (!sketches.has(name)) sketches.set(name, Array.from({ length: 4 }, () => new Map()));
    return sketches.get(name);
  };
  const apply = (quads) => {
    const q = quads instanceof Float64Array ? quads : new Float64Array(quads);
    for (let o = 0; o + 3 < q.length; o += 4) {
      const [i, row, cell, v] = [q[o], q[o + 1], q[o + 2], q[o + 3]];
      if (!SKETCHES[i] || row < 0 || row > 3) continue;
      if (v === 0) rowsOf(i)[row].delete(cell);
      else rowsOf(i)[row].set(cell, v);
      persisted.set(`${i}|${row}|${cell}`, v);
    }
  };
  const pack = (quads) => {
    const out = [];
    for (let o = 0; o < quads.length; o += CELLS_PER_ROW * 4) out.push(Float64Array.from(quads.slice(o, o + CELLS_PER_ROW * 4)));
    return out;
  };
  const dayKeys = async (d, filter = () => true) => {
    const keys = [];
    for await (const [k] of listKeys(storage, "c|")) if (filter(k, k.split("|")[1] === String(d))) keys.push(k);
    return keys;
  };

  // Load today's rows: the snapshot, then the journal rows after it. Other days' rows go.
  const meta = await storage.get(`c|${today}|m`);
  const stale = [];
  const later = [];
  if (meta) {
    upTo = meta.upTo;
    snapRows = meta.rows;
    const keys = Array.from({ length: meta.rows }, (_, i) => `c|${today}|s|${i}`);
    for (let i = 0; i < keys.length; i += BATCH) {
      const got = await storage.get(keys.slice(i, i + BATCH));
      for (const k of keys.slice(i, i + BATCH)) if (got.get(k)) apply(got.get(k));
    }
  }
  for await (const [k, v] of listKeys(storage, "c|")) {
    const [, d, kind, n] = k.split("|");
    if (d !== String(today)) stale.push(k);
    else if (kind === "j") {
      if (Number(n) <= upTo) stale.push(k);
      else later.push([Number(n), v]);
    } else if (kind === "s" && Number(n) >= snapRows) stale.push(k);
  }
  later.sort((a, b) => a[0] - b[0]);
  for (const [n, v] of later) apply(v);
  seq = Math.max(upTo, ...later.map(([n]) => n), -1) + 1;
  journal = later.length;
  if (stale.length) void deleteKeys(storage, stale);

  const compact = () => {
    const quads = [];
    SKETCHES.forEach((name, i) => sketches.get(name)?.forEach((r, row) => r.forEach((v, cell) => quads.push(i, row, cell, v))));
    const rows = pack(quads);
    const entries = { [`c|${day}|m`]: { upTo: seq - 1, rows: rows.length } };
    rows.forEach((r, i) => (entries[`c|${day}|s|${i}`] = r));
    const doneUpTo = seq - 1;
    upTo = doneUpTo;
    snapRows = rows.length;
    journal = 0;
    void (async () => {
      // One put of at most 128 keys is atomic: the snapshot and its meta row together.
      const keys = Object.keys(entries);
      if (keys.length <= 128) await storage.put(entries);
      else for (let i = 0; i < keys.length; i += BATCH) await storage.put(Object.fromEntries(keys.slice(i, i + BATCH).map((k) => [k, entries[k]])));
      // The journal rows the snapshot holds, and the rows of a larger snapshot before it.
      const gone = await dayKeys(day, (k, isDay) => {
        if (!isDay) return false;
        const [, , kind, n] = k.split("|");
        return (kind === "j" && Number(n) <= doneUpTo) || (kind === "s" && Number(n) >= snapRows);
      });
      await deleteKeys(storage, gone);
    })();
  };

  return {
    /** A sketch with vault-relay.js's interface, counting in memory. */
    sketch(name, width, depth = 4) {
      const i = idx(name);
      const rows = rowsOf(i);
      const set = (row, cell, v) => {
        if (v === 0) rows[row].delete(cell);
        else rows[row].set(cell, v);
        dirty.add(`${i}|${row}|${cell}`);
      };
      return {
        get: (cells) => Math.min(...cells.map((c, d) => rows[d].get(c) ?? 0)),
        add: (cells, n) => cells.forEach((c, d) => set(d, c, (rows[d].get(c) ?? 0) + n)),
        reset: (d) => {
          if (d === day) return; // the object restarted within the day: keep its counts
          day = d;
          sketches.forEach((r) => r.forEach((m) => m.clear()));
          persisted.clear();
          dirty.clear();
          seq = 0;
          upTo = -1;
          snapRows = 0;
          journal = 0;
          void dayKeys(d, (k, isDay) => !isDay).then((keys) => deleteKeys(storage, keys));
        },
        cells: (digest) => Array.from({ length: depth }, (_, d) => digest.readUInt32BE(d * 4) % width),
      };
    },
    /**
     * Persists the cells whose value differs from storage's, in one journal row.
     * Not awaited: the Durable Object's output gate holds the answer until the write is durable.
     */
    flush() {
      const quads = [];
      for (const key of dirty) {
        const [i, row, cell] = key.split("|").map(Number);
        const v = rowsOf(i)[row].get(cell) ?? 0;
        if ((persisted.get(key) ?? 0) === v) continue;
        persisted.set(key, v);
        quads.push(i, row, cell, v);
      }
      dirty.clear();
      if (quads.length === 0) return 0;
      const rows = pack(quads);
      for (const r of rows) void storage.put(`c|${day}|j|${String(seq++).padStart(10, "0")}`, r);
      journal += rows.length;
      if (journal >= JOURNAL_MAX * Math.max(1, snapRows)) compact();
      return rows.length;
    },
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
    // The day's counts (a bounded number of rows) and key, as the last run of this object left them.
    this.counters = await dayCounters(storage, today);
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
      daySketch: (name, width) => this.counters.sketch(name, width),
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
    const counters = this.counters;
    return new Promise((resolve) => {
      const res = {
        status: 200,
        headers: {},
        writeHead(status, h = {}) {
          this.status = status;
          this.headers = h;
        },
        end(body) {
          // The request's reservations are settled by now: persist what changed (nothing, for a refused PUT).
          counters.flush();
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
