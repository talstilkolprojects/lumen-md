/**
 * The encrypted vault relay (plan W4.19, #483) as routes of the public
 * live-share Worker (decision 5.16): one public service that only ever holds
 * ciphertext, under the same rules as the rooms (PRIVACY.he.md, "הערכת השפעה").
 * The protocol is sync-server/vault-relay.js's, so the app's relay provider
 * (src/sync/e2ee/providers/relay.ts) talks to either:
 *
 *   GET    /v1/vault/o/            → {"names": [...]}
 *   GET    /v1/vault/o/<name>      → bytes + ETag            (404 when none)
 *   PUT    /v1/vault/o/<name>      If-Match / If-None-Match: *   (412 lost race)
 *   DELETE /v1/vault/o/<name>
 *
 * What it keeps:
 *   - Objects the app encrypted before sending them, under opaque names, in
 *     one Durable Object per space (VaultSpace). The space is named by
 *     SHA-256("lumen-vault-relay v1|" + bearer token); the token itself is
 *     never kept. No accounts.
 *   - Retention: a space nobody read or wrote for VAULT_RELAY_RETENTION_DAYS
 *     (wrangler.toml: 90, the rooms' RETENTION_DAYS) is deleted by its
 *     object's alarm. Reads count (at most one touch a day).
 *   - No IP addresses: nothing is logged (Workers Logs are off). The daily
 *     limits count an address only as the rooms' quota does: quotaIds() of the
 *     address, then a bucket under a key for the day (roomQuota.mjs), in one
 *     VaultQuota object. Buckets of other days are deleted.
 *
 * Limits (wrangler.toml [vars]; defaults below): VAULT_RELAY_MAX_OBJECT,
 * VAULT_RELAY_MAX_SPACE, VAULT_RELAY_MAX_TOTAL (all spaces, 507 past it),
 * VAULT_RELAY_NEW_SPACES_PER_DAY and VAULT_RELAY_NEW_SPACES_PER_48 (per
 * address and per IPv6 /48, 429), VAULT_RELAY_ADDRESS_BYTES_PER_DAY (429),
 * VAULT_RELAY_RATE (requests per minute per space, 429). Every object is
 * charged its size rounded up to 4 KiB blocks, as on Node.
 * Opening a space can also require VAULT_RELAY_INVITE (header X-Lumen-Invite)
 * and VAULT_RELAY_POW_BITS (header X-Lumen-Pow; 428 {"error":"pow","bits"}).
 *
 * Differences from the Node relay, both because a Worker has no one place
 * that sees every request: the request rate is counted per space (in its
 * object), not per address; and the day key is derived from
 * COLLAB_TOKEN_SECRET and the day, as for rooms, not a random key in memory.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { dayBuckets, dayOf, quotaIds } from "../../sync-server/collab/roomToken.mjs";

export const VAULT_PREFIX = "/v1/vault/o/";
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const IDS = /^[ap]:[A-Za-z0-9_-]{22}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A Durable Object value holds at most 2 MB. */
const CHUNK = 1_000_000;
const BLOCK = 4096;
/** The app refuses a proof of work above this (relay.ts MAX_POW_BITS). */
export const MAX_POW_BITS = 24;

/** What an object of n bytes is charged: whole 4 KiB blocks, at least one (vault-relay.js). */
export const charge = (n) => Math.max(1, Math.ceil(n / BLOCK)) * BLOCK;
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
export const etagOf = (data) => `"${sha256(data).slice(0, 32)}"`;
export const spaceOf = (token) => sha256(`lumen-vault-relay v1|${token}`);

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export function vaultLimits(env = {}) {
  const maxSpace = num(env.VAULT_RELAY_MAX_SPACE, 1024 * 1024 * 1024);
  const newSpacesPerDay = num(env.VAULT_RELAY_NEW_SPACES_PER_DAY, 5);
  return {
    maxObject: num(env.VAULT_RELAY_MAX_OBJECT, 25 * 1024 * 1024),
    maxSpace,
    maxTotal: num(env.VAULT_RELAY_MAX_TOTAL, 20 * 1024 * 1024 * 1024),
    newSpacesPerDay,
    newSpacesPer48: num(env.VAULT_RELAY_NEW_SPACES_PER_48, newSpacesPerDay * 16),
    addressBytesPerDay: num(env.VAULT_RELAY_ADDRESS_BYTES_PER_DAY, maxSpace),
    rate: num(env.VAULT_RELAY_RATE, 600),
    retentionDays: num(env.VAULT_RELAY_RETENTION_DAYS, 90),
    invite: String(env.VAULT_RELAY_INVITE ?? ""),
    powBits: Math.min(MAX_POW_BITS, Math.floor(num(env.VAULT_RELAY_POW_BITS, 0))),
  };
}

function zeroBits(buf) {
  let n = 0;
  for (const b of buf) {
    if (b === 0) {
      n += 8;
      continue;
    }
    n += Math.clz32(b) - 24;
    break;
  }
  return n;
}

/** Does `nonce` prove `bits` of work for opening `space`? (vault-relay.js powOk) */
export function powOk(space, nonce, bits) {
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(nonce)) return false;
  return zeroBits(createHash("sha256").update(`lumen-vault-relay pow v1|${space}|${nonce}`).digest()) >= bits;
}

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "ETag", "cache-control": "no-store" };
const send = (status, body = null, headers = {}) => new Response(body, { status, headers: { ...CORS, ...headers } });
const json = (status, obj) => send(status, JSON.stringify(obj), { "content-type": "application/json" });

/** True when the Worker should hand the request to handleVault. */
export const isVaultPath = (pathname) => pathname.startsWith(VAULT_PREFIX);

/**
 * The Worker end: CORS, the bearer token and the name are checked here;
 * the space's own object does the rest. The token goes no further than this
 * function: the object gets the space id.
 */
export async function handleVault(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return send(204, null, {
      "access-control-allow-methods": "GET, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type, If-Match, If-None-Match, X-Lumen-Invite, X-Lumen-Pow",
      "access-control-max-age": "600",
    });
  }
  if (!env.VAULT) return json(404, { error: "not found" });
  const auth = /^Bearer (\S+)$/.exec(request.headers.get("authorization") || "");
  if (!auth || !TOKEN.test(auth[1])) return json(401, { error: "token" });
  let name;
  try {
    name = decodeURIComponent(url.pathname.slice(VAULT_PREFIX.length));
  } catch {
    return json(400, { error: "name" });
  }
  if (name !== "" && !NAME.test(name)) return json(400, { error: "name" });
  if (name === "" && request.method !== "GET") return json(405, { error: "method" });
  if (!["GET", "PUT", "DELETE"].includes(request.method)) return json(405, { error: "method" });
  const limits = vaultLimits(env);
  const size = Number(request.headers.get("content-length") ?? 0);
  if (request.method === "PUT" && size > limits.maxObject) return json(413, { error: "too large" });
  const space = spaceOf(auth[1]);
  const headers = new Headers();
  for (const h of ["if-match", "if-none-match", "x-lumen-invite", "x-lumen-pow", "content-type"]) {
    const v = request.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  headers.set("x-vault-space", space);
  // The address only as the quota's ids (keyed hashes), never as it is.
  headers.set("x-vault-ids", JSON.stringify(quotaIds(env.COLLAB_TOKEN_SECRET, request.headers.get("cf-connecting-ip"))));
  const body = request.method === "PUT" ? await request.arrayBuffer() : undefined;
  if (body && body.byteLength > limits.maxObject) return json(413, { error: "too large" });
  const inner = new Request(`https://vault/${encodeURIComponent(name)}`, { method: request.method, headers, body });
  return env.VAULT.get(env.VAULT.idFromName(space)).fetch(inner);
}

/** One space: its objects (chunked), its size and when it was last used. */
export class VaultSpace {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.limits = vaultLimits(env);
    this.chain = Promise.resolve();
    this.minute = -1;
    this.hits = 0;
  }

  /** One request at a time: a conditional PUT checks and writes as one step, across the quota's await. */
  exclusive(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  quota() {
    return this.env.VAULT_QUOTA ? this.env.VAULT_QUOTA.get(this.env.VAULT_QUOTA.idFromName("vault")) : null;
  }

  async ask(op, body) {
    const q = this.quota();
    if (!q) return { ok: true };
    const res = await q.fetch(new Request(`https://quota/${op}`, { method: "POST", body: JSON.stringify(body) }));
    return res.json();
  }

  async meta() {
    return (await this.state.storage.get("m")) ?? null;
  }

  async touch(m, nowMs = Date.now(), force = false) {
    if (!force && nowMs - m.touched < DAY_MS) return;
    m.touched = nowMs;
    await this.state.storage.put("m", m);
    await this.state.storage.setAlarm(nowMs + this.limits.retentionDays * DAY_MS);
  }

  async readObject(name) {
    const head = await this.state.storage.get(`h:${name}`);
    if (!head) return null;
    const keys = Array.from({ length: head.n }, (_, i) => `c:${name}:${i}`);
    const parts = keys.length ? await this.state.storage.get(keys) : new Map();
    const data = new Uint8Array(head.size);
    let at = 0;
    for (const k of keys) {
      const part = parts.get(k);
      data.set(part, at);
      at += part.byteLength;
    }
    return { data, etag: head.etag, size: head.size, n: head.n };
  }

  async fetch(request) {
    const nowMs = Date.now();
    const minute = Math.floor(nowMs / 60000);
    if (minute !== this.minute) (this.minute = minute), (this.hits = 0);
    if (++this.hits > this.limits.rate) return json(429, { error: "slow down" });
    const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
    const space = request.headers.get("x-vault-space") ?? "";
    let ids = [];
    try {
      ids = JSON.parse(request.headers.get("x-vault-ids") ?? "[]").filter((k) => typeof k === "string" && IDS.test(k));
    } catch {
      ids = [];
    }
    if (request.method === "GET") {
      const m = await this.meta();
      if (!m) return name === "" ? json(200, { names: [] }) : json(404, { error: "none" });
      if (name === "") {
        const heads = await this.state.storage.list({ prefix: "h:" });
        await this.touch(m, nowMs);
        return json(200, { names: [...heads.keys()].map((k) => k.slice(2)) });
      }
      const o = await this.readObject(name);
      if (!o) return json(404, { error: "none" });
      await this.touch(m, nowMs);
      return send(200, o.data, { "content-type": "application/octet-stream", ETag: o.etag });
    }
    const body = request.method === "PUT" ? new Uint8Array(await request.arrayBuffer()) : null;
    return this.exclusive(() => (request.method === "DELETE" ? this.remove(name) : this.write(name, body, request.headers, space, ids)));
  }

  async remove(name) {
    const m = await this.meta();
    const head = m ? await this.state.storage.get(`h:${name}`) : null;
    if (!m || !head) return send(204);
    const freed = charge(head.size);
    await this.state.storage.delete([`h:${name}`, ...Array.from({ length: head.n }, (_, i) => `c:${name}:${i}`)]);
    m.bytes = Math.max(0, m.bytes - freed);
    await this.touch(m, Date.now(), true);
    await this.ask("adjust", { delta: -freed });
    return send(204);
  }

  async write(name, data, headers, space, ids) {
    const L = this.limits;
    if (data.byteLength > L.maxObject) return json(413, { error: "too large" });
    const m = await this.meta();
    const fresh = !m;
    if (fresh) {
      if (L.invite && !sameSecret(headers.get("x-lumen-invite"), L.invite)) return json(403, { error: "invite" });
      if (L.powBits > 0 && !powOk(space, headers.get("x-lumen-pow"), L.powBits)) return json(428, { error: "pow", bits: L.powBits });
    }
    const head = fresh ? null : await this.state.storage.get(`h:${name}`);
    if (headers.get("if-none-match") === "*" && head) return json(412, { error: "exists" });
    const ifMatch = headers.get("if-match");
    if (ifMatch && (!head || head.etag !== ifMatch)) return json(412, { error: "changed" });
    const cost = charge(data.byteLength);
    const delta = cost - (head ? charge(head.size) : 0);
    if ((m?.bytes ?? 0) + delta > L.maxSpace) return json(507, { error: "space full" });
    const held = await this.ask("reserve", { ids, fresh, cost, delta });
    if (!held.ok) return json(held.status ?? 429, { error: held.error ?? "quota" });
    try {
      const etag = etagOf(data);
      const n = Math.ceil(data.byteLength / CHUNK);
      const entries = { [`h:${name}`]: { etag, size: data.byteLength, n } };
      for (let i = 0; i < n; i++) entries[`c:${name}:${i}`] = data.slice(i * CHUNK, (i + 1) * CHUNK);
      // put() takes at most 128 entries at a time.
      const all = Object.entries(entries);
      for (let i = 0; i < all.length; i += 100) await this.state.storage.put(Object.fromEntries(all.slice(i, i + 100)));
      if (head && head.n > n) await this.state.storage.delete(Array.from({ length: head.n - n }, (_, i) => `c:${name}:${n + i}`));
      const next = { bytes: (m?.bytes ?? 0) + delta, touched: m?.touched ?? 0 };
      await this.touch(next, Date.now(), true);
      return send(201, null, { ETag: etag });
    } catch (e) {
      await this.ask("release", { ...held.hold, delta }).catch(() => undefined);
      throw e;
    }
  }

  /** Retention: delete the space when nobody read or wrote it for retentionDays. */
  async alarm() {
    const m = await this.meta();
    if (!m) return;
    const keep = this.limits.retentionDays * DAY_MS;
    if (Date.now() - m.touched < keep) {
      await this.state.storage.setAlarm(m.touched + keep);
      return;
    }
    await this.state.storage.deleteAll();
    await this.ask("adjust", { delta: -m.bytes }).catch(() => undefined);
  }
}

/**
 * The relay's counters: bytes in all spaces, and per address and per IPv6
 * /48 the spaces opened and bytes written today, under the day's buckets
 * (roomQuota.mjs dayBuckets). Single-threaded, so a check and its
 * reservation are one step.
 */
export class VaultQuota {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.limits = vaultLimits(env);
  }

  async today() {
    const day = dayOf();
    const was = await this.state.storage.get("day");
    if (was !== day) {
      const old = await this.state.storage.list({ prefix: "d:" });
      if (old.size) await this.state.storage.delete([...old.keys()]);
      await this.state.storage.put("day", day);
    }
    return day;
  }

  async fetch(request) {
    const op = new URL(request.url).pathname.slice(1);
    const b = await request.json();
    const L = this.limits;
    const total = (await this.state.storage.get("t")) ?? 0;
    if (op === "adjust") {
      await this.state.storage.put("t", Math.max(0, total + Number(b.delta || 0)));
      return Response.json({ ok: true });
    }
    const day = await this.today();
    const ids = Array.isArray(b.ids) ? b.ids.filter((k) => typeof k === "string" && IDS.test(k)) : [];
    const keys = dayBuckets(this.env.COLLAB_TOKEN_SECRET, ids, day).map((k) => `d:${k}`);
    const a = keys.find((k) => k.startsWith("d:a:"));
    const p = keys.find((k) => k.startsWith("d:p:"));
    const got = keys.length ? await this.state.storage.get(keys) : new Map();
    const ca = (a && got.get(a)) || { s: 0, b: 0 };
    const cp = (p && got.get(p)) || { s: 0, b: 0 };
    const cost = Math.max(0, Number(b.cost) || 0);
    const delta = Number(b.delta) || 0;
    if (op === "release") {
      if (b.day !== day) return Response.json({ ok: true });
      if (b.fresh && a) ca.s = Math.max(0, ca.s - 1);
      if (b.fresh && p) cp.s = Math.max(0, cp.s - 1);
      if (a) ca.b = Math.max(0, ca.b - cost);
      const put = { t: Math.max(0, total - delta) };
      if (a) put[a] = ca;
      if (p) put[p] = cp;
      await this.state.storage.put(put);
      return Response.json({ ok: true });
    }
    if (op !== "reserve") return Response.json({ ok: false, status: 400, error: "op" });
    // Without an address (a request that didn't come through Cloudflare's edge), no new space.
    if (b.fresh && !a) return Response.json({ ok: false, status: 429, error: "new spaces today" });
    if (b.fresh && ca.s >= L.newSpacesPerDay) return Response.json({ ok: false, status: 429, error: "new spaces today" });
    if (b.fresh && p && cp.s >= L.newSpacesPer48) return Response.json({ ok: false, status: 429, error: "new spaces today" });
    if (a && ca.b + cost > L.addressBytesPerDay) return Response.json({ ok: false, status: 429, error: "bytes today" });
    if (delta > 0 && total + delta > L.maxTotal) return Response.json({ ok: false, status: 507, error: "relay full" });
    if (b.fresh) (ca.s += 1), p && (cp.s += 1);
    ca.b += cost;
    const put = { t: total + delta };
    if (a) put[a] = ca;
    if (p) put[p] = cp;
    await this.state.storage.put(put);
    return Response.json({ ok: true, hold: { ids, day, fresh: Boolean(b.fresh), cost } });
  }
}
