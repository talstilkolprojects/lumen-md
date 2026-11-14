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
 * into an address, nor linked across days. Review 2 (12.11):
 *   - an IPv6 address counts as its /64 (one host holds a whole /64), and an
 *     IPv4-mapped IPv6 address as its IPv4 address;
 *   - the counts live in a fixed-size counting sketch (count-min), so no
 *     number of other addresses can push an address's count out or reset it;
 *     a collision can only over-count (fail closed), never under-count;
 *   - a request reserves its new space and its bytes before it awaits
 *     anything, and gives them back if the write fails, so a burst of
 *     concurrent requests is counted as the sum of its parts;
 *   - every object is charged what the disk holds for it: its size rounded up
 *     to 4 KiB blocks (an empty object costs one block), in every cap.
 *
 * The client address: mounted in server.js, the relay uses the address that
 * server.js reads (SIGNAL_TRUST_PROXY=1 on Fly). Standalone, it trusts no
 * header unless told (review 4, RR4-483-1: on a school network every laptop
 * is a "private peer" and could name any address it liked):
 *   VAULT_RELAY_TRUST_PROXY unset    on Fly (FLY_APP_NAME set): as "fly"; elsewhere: no header
 *   VAULT_RELAY_TRUST_PROXY=0        no header: the socket's address
 *   VAULT_RELAY_TRUST_PROXY=fly      Fly-Client-IP, only on Fly and only from a private peer (Fly's proxy)
 *   VAULT_RELAY_TRUST_PROXY=<CIDRs>  e.g. "10.0.0.2/32,fd00::2/128": the proxies' own addresses; the
 *                                    client is the right-most X-Forwarded-For hop that is not one of them
 * IPv6 clients are counted by their /64, and new spaces also by their /48
 * (VAULT_RELAY_NEW_SPACES_PER_48, default 16 × the per-address limit), so a
 * tunnel's 65,536 /64s are not 65,536 clients (review 4, RR4-483-2).
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
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

/** What the disk holds for an object of n bytes: whole 4 KiB blocks, at least one. */
const BLOCK = 4096;
const charge = (n) => Math.max(1, Math.ceil(n / BLOCK)) * BLOCK;

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
// Once per object (W6.23): a Worker's store and the answer both need it, and a
// SHA-256 of a few MiB is most of a PUT's CPU time on the Workers Free plan.
const etags = new WeakMap();
const etagOf = (data) => {
  let e = etags.get(data);
  if (e === undefined) etags.set(data, (e = `"${sha256(data).slice(0, 32)}"`));
  return e;
};

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
      s.bytes += charge(data.length) - (old ? charge(old.data.length) : 0);
      s.objects.set(name, { data, etag: etagOf(data) });
      s.touched = Date.now();
    },
    async delete(id, name) {
      const s = spaces.get(id);
      const old = s?.objects.get(name);
      if (!s || !old) return;
      s.bytes -= charge(old.data.length);
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
      for (const name of await this.list(id)) {
        const st = await fs.promises.stat(p(id, name)).catch(() => null);
        if (st) n += charge(st.size);
      }
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
/** The app refuses a proof of work above this (src/sync/e2ee/providers/relay.ts MAX_POW_BITS). */
const MAX_POW_BITS = 24;

/** The eight 16-bit groups of an IPv6 address, or null. */
function v6Groups(a) {
  if (!/^[0-9a-f:.]+$/i.test(a) || !a.includes(":")) return null;
  let tail = [];
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (v4) {
    const b = v4.slice(1).map(Number);
    if (b.some((x) => x > 255)) return null;
    tail = [((b[0] << 8) | b[1]).toString(16), ((b[2] << 8) | b[3]).toString(16)];
    a = a.slice(0, v4.index) + "0:0";
  }
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const g = [...head, ...Array(Math.max(0, fill)).fill("0"), ...rest];
  if (g.length !== 8 || g.some((x) => !/^[0-9a-f]{1,4}$/i.test(x))) return null;
  if (v4) g.splice(6, 2, ...tail);
  return g.map((x) => parseInt(x, 16));
}

/** What one client is counted as: an IPv4 address, or an IPv6 /64. */
function addressKey(raw) {
  let a = String(raw || "?").trim().toLowerCase();
  if (a.startsWith("[")) a = a.slice(1, a.indexOf("]") >>> 0);
  a = a.replace(/%.*$/, "");
  const g = v6Groups(a);
  if (!g) return a;
  // IPv4-mapped (::ffff:a.b.c.d): the IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/** An IPv6 client's /48, or null for IPv4 (and IPv4-mapped) addresses. */
function prefix48(raw) {
  let a = String(raw || "?").trim().toLowerCase();
  if (a.startsWith("[")) a = a.slice(1, a.indexOf("]") >>> 0);
  a = a.replace(/%.*$/, "");
  const g = v6Groups(a);
  if (!g || (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)) return null;
  return `${g.slice(0, 3).map((x) => x.toString(16)).join(":")}::/48`;
}

/** An address as 8 IPv6 groups (IPv4 as IPv4-mapped), or null. */
function groupsOf(raw) {
  let a = String(raw || "").trim().toLowerCase();
  if (a.startsWith("[")) a = a.slice(1, a.indexOf("]") >>> 0);
  a = a.replace(/%.*$/, "");
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const b = v4.slice(1).map(Number);
    if (b.some((x) => x > 255)) return null;
    return [0, 0, 0, 0, 0, 0xffff, (b[0] << 8) | b[1], (b[2] << 8) | b[3]];
  }
  return v6Groups(a);
}

/** "10.0.0.2/32,fd00::2/128" → a test of whether an address is in one of the ranges; null when the list doesn't parse. */
function cidrList(text) {
  const ranges = [];
  let parsed = 0;
  for (const part of String(text).split(",").map((x) => x.trim()).filter(Boolean)) {
    const [addr, bits] = part.split("/");
    const g = groupsOf(addr);
    if (!g) return null;
    const isV4 = /^\d+\.\d+\.\d+\.\d+$/.test(addr.trim());
    const n = bits === undefined ? 128 : Number(bits) + (isV4 ? 96 : 0);
    if (!Number.isInteger(n) || n < (isV4 ? 96 : 0) || n > 128) return null;
    parsed++;
    // Review 6 (RR6-483-1): a range wider than /24 (IPv4) or /64 (IPv6) holds clients too (a school's
    // laptops, every ULA address), and a client in the list picks its own address. Such a range is not a proxy.
    if (n < (isV4 ? 120 : 64)) {
      console.warn(`vault-relay: VAULT_RELAY_TRUST_PROXY: "${part}" is wider than ${isV4 ? "/24" : "/64"}, ignored: list the proxies' own addresses (/32, /128)`);
      continue;
    }
    ranges.push({ g, n });
  }
  if (!parsed) return null;
  return (raw) => {
    const g = groupsOf(raw);
    if (!g) return false;
    return ranges.some((r) => {
      for (let bit = 0; bit < r.n; bit += 16) {
        const take = Math.min(16, r.n - bit);
        const mask = (0xffff << (16 - take)) & 0xffff;
        if ((g[bit / 16] & mask) !== (r.g[bit / 16] & mask)) return false;
      }
      return true;
    });
  };
}

/**
 * How the standalone relay reads the client's address (see the module comment).
 * Returns (req) => address.
 */
function addressReader(setting, env) {
  const peerOf = (req) => req.socket?.remoteAddress || "?";
  const value = setting === false ? "0" : setting === true ? "fly" : String(setting ?? "").trim().toLowerCase();
  const onFly = !!env.FLY_APP_NAME;
  if (value === "fly" || (value === "" && onFly) || (value === "auto" && onFly)) {
    return (req) => {
      const peer = peerOf(req);
      const fly = req.headers?.["fly-client-ip"];
      if (onFly && peerKind(peer) !== "public" && typeof fly === "string" && fly.trim()) return fly.trim();
      return peer;
    };
  }
  if (value === "" || value === "0" || value === "auto" || value === "off" || value === "false") return peerOf;
  const isProxy = cidrList(value);
  if (!isProxy) throw new Error(`VAULT_RELAY_TRUST_PROXY: "${setting}" is not 0, fly or a list of CIDR ranges`);
  return (req) => {
    const peer = peerOf(req);
    if (!isProxy(peer)) return peer;
    const xff = req.headers?.["x-forwarded-for"];
    const hops = typeof xff === "string" ? xff.split(",").map((x) => x.trim()).filter(Boolean) : [];
    // From the right: each hop a proxy appended; the first that is not a proxy is the client.
    for (let i = hops.length - 1; i >= 0; i--) if (!isProxy(hops[i])) return hops[i];
    // Every hop is a proxy (review 6, RR6-483-1): the left-most is the client's own word, so the socket's address counts.
    return peer;
  };
}

/** Is a peer address loopback, or on a private network? */
function peerKind(raw) {
  const a = addressKey(raw);
  if (a === "127.0.0.1" || /^127\./.test(a) || a === "0:0:0:0::/64") return "loopback";
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a)) return "private";
  if (/^f[cd][0-9a-f]{0,2}:/.test(a) || /^fe[89ab][0-9a-f]?:/.test(a)) return "private";
  return "public";
}

/**
 * A count-min sketch: `depth` rows of `width` counters, each key adding to one
 * counter per row and reading the smallest. It never under-counts, so a full
 * table fails closed instead of forgetting anyone.
 */
function sketch(width = 1 << 16, depth = 4) {
  const rows = Array.from({ length: depth }, () => new Float64Array(width));
  return {
    get: (cells) => Math.min(...cells.map((c, d) => rows[d][c])),
    add: (cells, n) => cells.forEach((c, d) => (rows[d][c] += n)),
    reset: (_day) => rows.forEach((r) => r.fill(0)),
    cells: (digest) => rows.map((_, d) => digest.readUInt32BE(d * 4) % width),
  };
}

function createVaultRelay(opts = {}) {
  const env = process.env;
  const maxObject = num(opts.maxObjectBytes ?? env.VAULT_RELAY_MAX_OBJECT, 25 * 1024 * 1024);
  const maxSpace = num(opts.maxSpaceBytes ?? env.VAULT_RELAY_MAX_SPACE, 1024 * 1024 * 1024);
  const rate = num(opts.ratePerMinute ?? env.VAULT_RELAY_RATE, 600);
  const retentionDays = num(opts.retentionDays ?? env.VAULT_RELAY_RETENTION_DAYS, 180);
  const dir = opts.dir ?? env.VAULT_RELAY_DIR;
  const store = opts.store ?? (dir ? diskStore(dir) : memoryStore());
  const maxTotal = num(opts.maxTotalBytes ?? env.VAULT_RELAY_MAX_TOTAL, 20 * 1024 * 1024 * 1024);
  const newSpacesPerDay = num(opts.newSpacesPerDay ?? env.VAULT_RELAY_NEW_SPACES_PER_DAY, 5);
  const addressBytesPerDay = num(opts.addressBytesPerDay ?? env.VAULT_RELAY_ADDRESS_BYTES_PER_DAY, maxSpace);
  const invite = String(opts.invite ?? env.VAULT_RELAY_INVITE ?? "");
  // The app refuses more than MAX_POW_BITS, so a higher setting would make every new vault fail.
  const powBits = Math.min(MAX_POW_BITS, Math.floor(num(opts.powBits ?? env.VAULT_RELAY_POW_BITS, 0)));
  const newSpacesPer48 = num(opts.newSpacesPer48 ?? env.VAULT_RELAY_NEW_SPACES_PER_48, newSpacesPerDay * 16);
  /** The client's address: server.js's own reading when mounted there, else the socket (and a proxy's header, when told). */
  const clientAddress = typeof opts.clientAddress === "function" ? opts.clientAddress : addressReader(opts.trustProxy ?? env.VAULT_RELAY_TRUST_PROXY, env);
  /** Per address (as a daily HMAC, never the address): requests this minute, spaces opened and bytes written today. */
  const hits = sketch();
  // The day's counts, and the day's key, can be kept by the host (W6.23: a Cloudflare
  // Durable Object is evicted when idle, and an in-memory count would start again):
  //   opts.daySketch(name, width) → a sketch whose reset(day) keeps the counts of `day`
  //   opts.dayKey(day)            → the 32-byte key of that day
  const daySketch = typeof opts.daySketch === "function" ? opts.daySketch : (_name, width) => sketch(width);
  // Sized for a busy day: 2^17 cells a row keeps collisions rare at a few hundred thousand new spaces.
  const newSpaces = daySketch("spaces", 1 << 17);
  const newSpaces48 = daySketch("spaces48", 1 << 17);
  const written = daySketch("written", 1 << 16);
  let salt = { day: -1, key: Buffer.alloc(0) };
  let minute = -1;
  const addressId = (req) => {
    const now = Date.now();
    const day = Math.floor(now / DAY);
    if (salt.day !== day) {
      // A new day: a new key, and the day's counts start again (the time bucket, not an eviction).
      salt = { day, key: typeof opts.dayKey === "function" ? opts.dayKey(day) : crypto.randomBytes(32) };
      newSpaces.reset(day);
      newSpaces48.reset(day);
      written.reset(day);
    }
    if (minute !== Math.floor(now / 60000)) {
      minute = Math.floor(now / 60000);
      hits.reset();
    }
    return hits.cells(crypto.createHmac("sha256", salt.key).update(addressKey(clientAddress(req))).digest());
  };
  /** The client's IPv6 /48 cells (after addressId, under the same day's key), or null for IPv4. */
  const prefixId = (req) => {
    const p = prefix48(clientAddress(req));
    return p ? newSpaces48.cells(crypto.createHmac("sha256", salt.key).update(`48|${p}`).digest()) : null;
  };
  /**
   * Bytes in all spaces: counted once from the store (one walk at a time),
   * then kept up to date here in synchronous steps, so a check and its
   * reservation are one step. Bytes reserved by writes still in flight are
   * added to a recount, which can only over-count until the next sweep.
   */
  let total = null;
  let totalP = null;
  let generation = 0;
  let pending = 0;
  const loadTotal = () => {
    if (total !== null) return Promise.resolve();
    if (!totalP) {
      const gen = generation;
      totalP = Promise.resolve(typeof store.totalBytes === "function" ? store.totalBytes() : 0).then(
        (n) => {
          if (gen === generation && total === null) total = n + pending;
          totalP = null;
        },
        (e) => {
          totalP = null;
          throw e;
        },
      );
    }
    return totalP;
  };
  /** Reads keep a space alive: at most one touch a day per space. */
  const lastTouch = new Map();
  const touchRead = async (space) => {
    const now = Date.now();
    if (now - (lastTouch.get(space) ?? 0) < DAY) return;
    lastTouch.delete(space);
    // Bounded: the oldest entry goes (the worst case is one more touch for it).
    if (lastTouch.size >= 100000) lastTouch.delete(lastTouch.keys().next().value);
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
    hits.add(addr, 1);
    return hits.get(addr) > rate;
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      req.on("data", (c) => {
        n += c.length;
        if (n > limit) {
          reject(Object.assign(new Error("too large"), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
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
    const addr48 = prefixId(req);
    if (limited(req, addr)) return json(res, 429, { error: "slow down" });
    const auth = /^Bearer (\S+)$/.exec(req.headers.authorization || "");
    if (!auth || !TOKEN.test(auth[1])) return json(res, 401, { error: "token" });
    const space = sha256(`lumen-vault-relay v1|${auth[1]}`);
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
      await exclusive(space, async () => {
        const old = await store.get(space, name);
        await store.delete(space, name);
        if (old && total !== null) total = Math.max(0, total - charge(old.data.length));
      });
      return send(res, 204, "");
    }
    if (req.method !== "PUT") return json(res, 405, { error: "method" });
    // Read the body from the start: a listener attached after the awaits below could miss chunks.
    const body = readBody(req, maxObject);
    body.catch(() => undefined);
    // Opening a space: invite and proof of work (when the operator asks for them), and a daily count.
    // Every count is reserved in the same synchronous step as its check, before the next await,
    // and given back unless the write lands (review 2: concurrent requests).
    let spaceHeld = false;
    let bytesHeld = 0;
    const release = () => {
      if (spaceHeld) {
        newSpaces.add(addr, -1);
        if (addr48) newSpaces48.add(addr48, -1);
      }
      if (bytesHeld) written.add(addr, -bytesHeld);
      spaceHeld = false;
      bytesHeld = 0;
    };
    const fresh = !(await exists(space));
    if (fresh) {
      if (invite && !sameSecret(req.headers["x-lumen-invite"], invite)) return json(res, 403, { error: "invite" });
      if (powBits > 0 && !powOk(space, req.headers["x-lumen-pow"], powBits)) return json(res, 428, { error: "pow", bits: powBits });
      if (newSpaces.get(addr) >= newSpacesPerDay) return json(res, 429, { error: "new spaces today" });
      if (addr48 && newSpaces48.get(addr48) >= newSpacesPer48) return json(res, 429, { error: "new spaces today" });
      newSpaces.add(addr, 1);
      if (addr48) newSpaces48.add(addr48, 1);
      spaceHeld = true;
    }
    let data;
    try {
      data = await body;
    } catch (e) {
      release();
      throw e;
    }
    const cost = charge(data.length);
    // Decided and reserved in one step; reported after the space's own checks.
    const overToday = written.get(addr) + cost > addressBytesPerDay;
    if (!overToday) {
      written.add(addr, cost);
      bytesHeld = cost;
    }
    let verdict;
    try {
      verdict = await exclusive(space, async () => {
        const now = await store.get(space, name);
        const ifMatch = req.headers["if-match"];
        if (req.headers["if-none-match"] === "*" && now) return [412, "exists"];
        if (ifMatch && (!now || now.etag !== ifMatch)) return [412, "changed"];
        const delta = cost - (now ? charge(now.data.length) : 0);
        if ((await store.bytes(space)) + delta > maxSpace) return [507, "space full"];
        if (overToday) return [429, "bytes today"];
        const opened = fresh && !(await exists(space));
        await loadTotal();
        // From the check to the reservation: no await (the total's lock).
        if (delta > 0 && total + delta > maxTotal) return [507, "relay full"];
        total += delta;
        pending += delta;
        try {
          await store.put(space, name, data);
        } catch (e) {
          if (total !== null) total -= delta;
          throw e;
        } finally {
          pending -= delta;
        }
        // The space was opened by a concurrent request: this one did not open it.
        if (spaceHeld && !opened) {
          newSpaces.add(addr, -1);
          if (addr48) newSpaces48.add(addr48, -1);
        }
        spaceHeld = false;
        bytesHeld = 0;
        return null;
      });
    } finally {
      release();
    }
    if (verdict) return json(res, verdict[0], { error: verdict[1] });
    return send(res, 201, "", { ETag: etagOf(data) });
  }

  const sweep = () =>
    store
      .sweep(Date.now() - retentionDays * DAY)
      .then((n) => {
        // Counted again from the store, once, by the next write.
        generation++;
        total = null;
        totalP = null;
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

module.exports = { createVaultRelay, memoryStore, diskStore, powOk, zeroBits, addressKey, charge, sketch, etagOf, MAX_POW_BITS };

if (require.main === module) {
  const relay = createVaultRelay();
  const server = http.createServer((req, res) => {
    if (relay.handle(req, res)) return;
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"not found"}');
  });
  server.listen(num(process.env.PORT, 4446), () => console.log(`vault relay on :${server.address().port}`));
}
