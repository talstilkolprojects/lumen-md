/**
 * The encrypted vault relay (plan W4.19): a blob store for Lumen's encrypted
 * sync, for devices with no desktop sync folder and no WebDAV.
 *
 * What it holds: opaque objects that the app encrypted before sending them
 * (sealed with keys the relay never sees) under opaque names. What it knows:
 * the SHA-256 of each space's bearer token (the token itself is never kept),
 * object sizes and times. No accounts, no logs of addresses.
 *
 *   GET    /v1/vault/o/            → {"names": [...]}
 *   GET    /v1/vault/o/<name>      → bytes + ETag            (404 when none)
 *   PUT    /v1/vault/o/<name>      If-Match / If-None-Match: *   (412 lost race)
 *   DELETE /v1/vault/o/<name>
 *
 * Drop boxes (plan W5.21, the private classroom): a space that many people
 * may add to but nobody but its owner may change. The token says which:
 *
 *   Bearer <t>     a private space (sync): full rights, as above.
 *   Bearer a.<d>   the drop box <d>, append-only: list, read, and create a
 *                  new object (PUT with If-None-Match: *). Overwriting (403
 *                  without If-None-Match, 412 on an existing name) and
 *                  DELETE (403) are refused, so one link holder can neither
 *                  replace nor remove what another one put there.
 *   Bearer o.<o>   the owner of drop box d = base64url(HMAC-SHA256(o,
 *                  "lumen-vault-relay v1|drop")): full rights on it. A
 *                  holder of d cannot work out o.
 *
 * The relay keeps neither d nor o, only the SHA-256 that names the space.
 * A drop box also has a smaller object cap (VAULT_RELAY_MAX_DROP_OBJECT,
 * 2 MiB) and a cap on its number of objects (VAULT_RELAY_MAX_DROP_COUNT,
 * 2,000), so a link holder cannot fill it for everyone else.
 *
 * Limits (env or options): VAULT_RELAY_MAX_OBJECT (25 MiB), VAULT_RELAY_MAX_SPACE
 * (1 GiB), VAULT_RELAY_RATE (600 requests per minute per address),
 * VAULT_RELAY_RETENTION_DAYS (180: a space nobody read or wrote that long is
 * deleted; reads count, review 12.11).
 * VAULT_RELAY_DIR keeps the objects on disk; without it they live in memory.
 *
 * Tokens are free, so a quota per space alone bounds nothing (review 12.11):
 *   VAULT_RELAY_MAX_TOTAL (20 GiB)             all spaces together; past it, 507
 *   VAULT_RELAY_NEW_SPACES_PER_DAY (5)         new spaces one address may open a day
 *   VAULT_RELAY_ADDRESS_BYTES_PER_DAY (= MAX_SPACE)  bytes one address may write a day
 * Addresses are never kept: they are counted under an HMAC with a random key
 * that lives in memory and changes every day, so a count can't be turned back
 * into an address, nor linked across days.
 *
 * For a public relay, opening a space can also require (opt-in):
 *   VAULT_RELAY_INVITE=<secret>     the header `X-Lumen-Invite: <secret>`
 *   VAULT_RELAY_POW_BITS=<n>        a proof of work: `X-Lumen-Pow: <nonce>` with
 *                                   SHA-256("lumen-vault-relay pow v1|<space>|<nonce>")
 *                                   starting with n zero bits (<space>: the hex
 *                                   space id). Without it the answer is 428
 *                                   {"error":"pow","bits":n}; the app solves it.
 * Spaces that already exist are not affected.
 *
 *   node vault-relay.js                       # standalone on $PORT (default 4446)
 *   require('./vault-relay').createVaultRelay({ dir })   # mounted (server.js)
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");

const PREFIX = "/v1/vault/o/";
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const TOKEN = /^(?:([ao])\.)?([A-Za-z0-9_-]{32,128})$/;
const DROP_LABEL = "lumen-vault-relay v1|drop";

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const etagOf = (data) => `"${sha256(data).slice(0, 32)}"`;

/** The drop box id that an owner token opens (the app derives the same with WebCrypto). */
const dropIdOf = (ownerToken) => crypto.createHmac("sha256", ownerToken).update(DROP_LABEL).digest("base64url");

/** Which space a bearer token names, and what it may do there; null for a malformed token. */
function spaceOf(header) {
  const auth = /^Bearer (\S+)$/.exec(header || "");
  const m = auth && TOKEN.exec(auth[1]);
  if (!m) return null;
  const [, kind, token] = m;
  if (!kind) return { id: sha256(`lumen-vault-relay v1|${token}`), append: false, drop: false };
  const drop = kind === "a" ? token : dropIdOf(token);
  return { id: sha256(`lumen-vault-relay v1|drop|${drop}`), append: kind === "a", drop: true };
}

function memoryStore() {
  const spaces = new Map();
  const space = (id) => {
    let s = spaces.get(id);
    if (!s) spaces.set(id, (s = { objects: new Map(), bytes: 0, touched: Date.now() }));
    return s;
  };
  return {
    async list(id) {
      return [...(spaces.get(id)?.objects.keys() ?? [])];
    },
    async get(id, name) {
      return spaces.get(id)?.objects.get(name) ?? null;
    },
    async put(id, name, data) {
      const s = space(id);
      const old = s.objects.get(name);
      s.bytes += data.length - (old ? old.data.length : 0);
      s.objects.set(name, { data, etag: etagOf(data) });
      s.touched = Date.now();
    },
    async delete(id, name) {
      const s = spaces.get(id);
      const old = s?.objects.get(name);
      if (!s || !old) return;
      s.bytes -= old.data.length;
      s.objects.delete(name);
      s.touched = Date.now();
    },
    async bytes(id) {
      return spaces.get(id)?.bytes ?? 0;
    },
    async has(id) {
      return spaces.has(id);
    },
    /** A read keeps the space alive too (retention). */
    async touch(id) {
      const s = spaces.get(id);
      if (s) s.touched = Date.now();
    },
    async totalBytes() {
      let n = 0;
      for (const s of spaces.values()) n += s.bytes;
      return n;
    },
    async sweep(olderThan) {
      let n = 0;
      for (const [id, s] of spaces) if (s.touched < olderThan) (spaces.delete(id), n++);
      return n;
    },
  };
}

function diskStore(dir) {
  const p = (id, name) => path.join(dir, id, name ?? "");
  const touch = async (id) => {
    const now = new Date();
    await fs.promises.utimes(p(id), now, now).catch(() => undefined);
  };
  return {
    async list(id) {
      return (await fs.promises.readdir(p(id)).catch(() => [])).filter((n) => NAME.test(n) && !n.endsWith(".tmp"));
    },
    async get(id, name) {
      const data = await fs.promises.readFile(p(id, name)).catch(() => null);
      return data ? { data, etag: etagOf(data) } : null;
    },
    async put(id, name, data) {
      await fs.promises.mkdir(p(id), { recursive: true });
      const tmp = p(id, `${name}.${crypto.randomBytes(4).toString("hex")}.tmp`);
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, p(id, name));
      await touch(id);
    },
    async delete(id, name) {
      await fs.promises.unlink(p(id, name)).catch(() => undefined);
      await touch(id);
    },
    async bytes(id) {
      let n = 0;
      for (const name of await this.list(id)) n += (await fs.promises.stat(p(id, name)).catch(() => ({ size: 0 }))).size;
      return n;
    },
    async has(id) {
      return !!(await fs.promises.stat(p(id)).catch(() => null))?.isDirectory();
    },
    touch,
    async totalBytes() {
      let n = 0;
      for (const id of await fs.promises.readdir(dir).catch(() => [])) if (/^[0-9a-f]{64}$/.test(id)) n += await this.bytes(id);
      return n;
    },
    async sweep(olderThan) {
      let n = 0;
      for (const id of await fs.promises.readdir(dir).catch(() => [])) {
        const st = await fs.promises.stat(p(id)).catch(() => null);
        if (st?.isDirectory() && st.mtimeMs < olderThan) (await fs.promises.rm(p(id), { recursive: true, force: true }), n++);
      }
      return n;
    },
  };
}

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/** Leading zero bits of a digest. */
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

/** Does `nonce` prove `bits` of work for opening `space`? */
function powOk(space, nonce, bits) {
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(nonce)) return false;
  return zeroBits(crypto.createHash("sha256").update(`lumen-vault-relay pow v1|${space}|${nonce}`).digest()) >= bits;
}

const DAY = 86400000;

function createVaultRelay(opts = {}) {
  const env = process.env;
  const maxObject = num(opts.maxObjectBytes ?? env.VAULT_RELAY_MAX_OBJECT, 25 * 1024 * 1024);
  const maxDropObject = num(opts.maxDropObjectBytes ?? env.VAULT_RELAY_MAX_DROP_OBJECT, 2 * 1024 * 1024);
  const maxDropCount = num(opts.maxDropCount ?? env.VAULT_RELAY_MAX_DROP_COUNT, 2000);
  const maxSpace = num(opts.maxSpaceBytes ?? env.VAULT_RELAY_MAX_SPACE, 1024 * 1024 * 1024);
  const rate = num(opts.ratePerMinute ?? env.VAULT_RELAY_RATE, 600);
  const retentionDays = num(opts.retentionDays ?? env.VAULT_RELAY_RETENTION_DAYS, 180);
  const dir = opts.dir ?? env.VAULT_RELAY_DIR;
  const store = opts.store ?? (dir ? diskStore(dir) : memoryStore());
  const maxTotal = num(opts.maxTotalBytes ?? env.VAULT_RELAY_MAX_TOTAL, 20 * 1024 * 1024 * 1024);
  const newSpacesPerDay = num(opts.newSpacesPerDay ?? env.VAULT_RELAY_NEW_SPACES_PER_DAY, 5);
  const addressBytesPerDay = num(opts.addressBytesPerDay ?? env.VAULT_RELAY_ADDRESS_BYTES_PER_DAY, maxSpace);
  const invite = String(opts.invite ?? env.VAULT_RELAY_INVITE ?? "");
  const powBits = Math.min(32, Math.floor(num(opts.powBits ?? env.VAULT_RELAY_POW_BITS, 0)));
  const hits = new Map();
  /** Per address (as a daily HMAC, never the address): spaces opened and bytes written today. */
  const quota = new Map();
  let salt = { day: -1, key: Buffer.alloc(0) };
  const addressId = (req) => {
    const day = Math.floor(Date.now() / DAY);
    if (salt.day !== day) {
      salt = { day, key: crypto.randomBytes(32) };
      quota.clear();
      hits.clear();
    }
    return crypto.createHmac("sha256", salt.key).update(req.socket?.remoteAddress || "?").digest("base64url").slice(0, 22);
  };
  const quotaOf = (addr) => {
    let q = quota.get(addr);
    if (!q) {
      if (quota.size > 100000) quota.clear();
      quota.set(addr, (q = { spaces: 0, bytes: 0 }));
    }
    return q;
  };
  /** Bytes in all spaces: counted once from the store, then kept up to date here. */
  let total = null;
  const totalNow = async () => (total ??= typeof store.totalBytes === "function" ? await store.totalBytes() : 0);
  /** Reads keep a space alive: at most one touch a day per space. */
  const lastTouch = new Map();
  const touchRead = async (space) => {
    const now = Date.now();
    if (now - (lastTouch.get(space) ?? 0) < DAY) return;
    if (lastTouch.size > 100000) lastTouch.clear();
    lastTouch.set(space, now);
    if (typeof store.touch === "function") await store.touch(space);
  };
  const exists = async (space) => (typeof store.has === "function" ? store.has(space) : (await store.list(space)).length > 0);
  const sameSecret = (a, b) => {
    const x = Buffer.from(String(a ?? ""));
    const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  /** One write at a time per space, so a conditional PUT checks and writes as one step. */
  const locks = new Map();
  const exclusive = (space, fn) => {
    const run = (locks.get(space) || Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    locks.set(space, tail);
    tail.then(() => locks.get(space) === tail && locks.delete(space));
    return run;
  };

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "ETag",
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(body);
  };
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { "Content-Type": "application/json" });

  function limited(req, addr) {
    const minute = Math.floor(Date.now() / 60000);
    const h = hits.get(addr);
    if (!h || h.minute !== minute) {
      hits.set(addr, { minute, n: 1 });
      if (hits.size > 50000) hits.clear();
      return false;
    }
    return ++h.n > rate;
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      const tooLarge = () => Object.assign(new Error("too large"), { status: 413 });
      req.on("data", (c) => {
        n += c.length;
        // Past the limit the rest is read and dropped, so the client gets the 413 instead of a reset
        // connection; past four times the limit the connection is cut.
        if (n > 4 * limit) req.destroy();
        else if (n <= limit) chunks.push(c);
      });
      req.on("end", () => (n > limit ? reject(tooLarge()) : resolve(Buffer.concat(chunks))));
      req.on("error", reject);
    });
  }

  async function serve(req, res, pathname) {
    if (req.method === "OPTIONS") {
      return send(res, 204, "", {
        "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match, If-None-Match, X-Lumen-Invite, X-Lumen-Pow",
        "Access-Control-Max-Age": "600",
      });
    }
    const addr = addressId(req);
    if (limited(req, addr)) return json(res, 429, { error: "slow down" });
    const who = spaceOf(req.headers.authorization);
    if (!who) return json(res, 401, { error: "token" });
    const space = who.id;
    const name = decodeURIComponent(pathname.slice(PREFIX.length));
    if (name === "") {
      if (req.method !== "GET") return json(res, 405, { error: "method" });
      await touchRead(space);
      return json(res, 200, { names: await store.list(space) });
    }
    if (!NAME.test(name)) return json(res, 400, { error: "name" });
    if (req.method === "GET") {
      const o = await store.get(space, name);
      if (o) await touchRead(space);
      return o ? send(res, 200, o.data, { "Content-Type": "application/octet-stream", ETag: o.etag }) : json(res, 404, { error: "none" });
    }
    if (req.method === "DELETE") {
      if (who.append) return json(res, 403, { error: "append-only" });
      await exclusive(space, async () => {
        const old = await store.get(space, name);
        await store.delete(space, name);
        if (old && total !== null) total = Math.max(0, total - old.data.length);
      });
      return send(res, 204, "");
    }
    if (req.method !== "PUT") return json(res, 405, { error: "method" });
    const createOnly = req.headers["if-none-match"] === "*";
    // Refused before the body is read: an append-only token never replaces an object.
    if (who.append && !createOnly) return json(res, 403, { error: "append-only" });
    // Read the body from the start: a listener attached after the awaits below could miss chunks.
    const body = readBody(req, who.drop ? Math.min(maxObject, maxDropObject) : maxObject);
    body.catch(() => undefined);
    const q = quotaOf(addr);
    // Opening a space: invite and proof of work (when the operator asks for them), and a daily count.
    const fresh = !(await exists(space));
    if (fresh) {
      if (invite && !sameSecret(req.headers["x-lumen-invite"], invite)) return json(res, 403, { error: "invite" });
      if (powBits > 0 && !powOk(space, req.headers["x-lumen-pow"], powBits)) return json(res, 428, { error: "pow", bits: powBits });
      if (q.spaces >= newSpacesPerDay) return json(res, 429, { error: "new spaces today" });
    }
    const data = await body;
    const verdict = await exclusive(space, async () => {
      const now = await store.get(space, name);
      const ifMatch = req.headers["if-match"];
      if (createOnly && now) return [412, "exists"];
      if (who.drop && !now && (await store.list(space)).length >= maxDropCount) return [507, "drop box full"];
      if (ifMatch && (!now || now.etag !== ifMatch)) return [412, "changed"];
      const delta = data.length - (now ? now.data.length : 0);
      if ((await store.bytes(space)) + delta > maxSpace) return [507, "space full"];
      if (q.bytes + data.length > addressBytesPerDay) return [429, "bytes today"];
      if ((await totalNow()) + delta > maxTotal) return [507, "relay full"];
      const opened = fresh && !(await exists(space));
      await store.put(space, name, data);
      total = (await totalNow()) + delta;
      q.bytes += data.length;
      if (opened) q.spaces++;
      return null;
    });
    if (verdict) return json(res, verdict[0], { error: verdict[1] });
    return send(res, 201, "", { ETag: etagOf(data) });
  }

  const sweep = () =>
    store
      .sweep(Date.now() - retentionDays * DAY)
      .then((n) => {
        total = null; // counted again from the store
        return n;
      })
      .catch(() => 0);
  const timer = opts.sweep === false ? null : setInterval(sweep, 3600000);
  timer?.unref?.();

  return {
    /** Handles `/v1/vault/…`; returns false for any other path. */
    handle(req, res) {
      const pathname = (req.url || "/").split("?")[0];
      if (!pathname.startsWith(PREFIX)) return false;
      serve(req, res, pathname).catch((e) => json(res, e.status || 500, { error: e.status ? e.message : "error" }));
      return true;
    },
    sweep,
    close() {
      if (timer) clearInterval(timer);
    },
  };
}

module.exports = { createVaultRelay, memoryStore, diskStore, dropIdOf, powOk, zeroBits };

if (require.main === module) {
  const relay = createVaultRelay();
  const server = http.createServer((req, res) => {
    if (relay.handle(req, res)) return;
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"not found"}');
  });
  server.listen(num(process.env.PORT, 4446), () => console.log(`vault relay on :${server.address().port}`));
}
