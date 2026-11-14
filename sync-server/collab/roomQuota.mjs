/**
 * New-room limits for the public collab server (review 2 RR2-469-1, review 4, review 6).
 *
 * One Durable Object (`Quota`, one instance named "quota") counts, per UTC day:
 *   - new rooms on the whole server   COLLAB_NEW_ROOMS_PER_DAY      (default 2,000)
 *   - new rooms per client address     COLLAB_NEW_ROOMS_PER_ADDRESS  (default 20)
 *     (an IPv4 address, or an IPv6 /64)
 *   - new rooms per IPv6 /48           COLLAB_NEW_ROOMS_PER_48       (default 4 × the per-address limit)
 * and, all the time, what is stored (review 6, RR6-469-2):
 *   - rooms                            COLLAB_MAX_ROOMS              (default 20,000)
 *   - bytes                            COLLAB_MAX_STORED_BYTES       (default 4 GB, under the
 *                                      Workers Free plan's 5 GB of Durable Object storage)
 *   - rooms per address                COLLAB_STORED_ROOMS_PER_ADDRESS (default 50)
 *   - rooms per IPv6 /48               COLLAB_STORED_ROOMS_PER_48    (default: the same; review 8)
 *   - bytes per address and per /48    COLLAB_STORED_BYTES_PER_ADDRESS (default 1/200 of the store; review 11)
 * Review 11 (RR11-469-1): a return protects a room only when it comes from
 * someone other than its creator (another owner value), and several small
 * rooms may free one room's share together.
 * When the rooms or the bytes are full, a new room may take the place of
 * stored rooms that nobody came back to: the smallest that frees one room's
 * share of the bytes, else a few smaller ones that free it together (review
 * 8 and 11: only for an attempt every other limit lets in; when they can't,
 * none is evicted and the attempt is refused, and it still counts for the
 * client). A room someone other than its creator joined again within
 * COLLAB_PROTECT_DAYS (default 14) is never evicted, and neither is a room
 * someone who sent its token is connected to.
 *
 * The day is the Quota's own (review 6, RR6-469-1): a room passes ids that do
 * not depend on the day, and the Quota turns them into the day's bucket
 * names with its own clock, which never moves backwards. So a socket opened
 * before midnight and authenticated after it counts against today, and can't
 * reset today's counts.
 *
 * Why a Durable Object and not the Workers rate-limit binding: the binding
 * needs wrangler 4.36 (the deploy script pins 4.20.0), counts per Cloudflare
 * location, not globally, is eventually consistent, and only knows periods of
 * 10 or 60 seconds. A daily cap on the whole server needs one exact counter.
 *
 * What it keeps, and no address:
 *   - the day's counts under bucket names that are an HMAC, under a key for
 *     the day, of an HMAC of the address (from COLLAB_TOKEN_SECRET); the
 *     previous day's buckets are dropped with the day;
 *   - per stored room (by its Durable Object id): its size, when it was last
 *     written, last joined again and last refused to make way, and its
 *     owners: 20 bits of a keyed hash of the address that created it, and
 *     for IPv6 20 bits of one of its /48. About 4,000 IPv4 addresses share
 *     each owner value, so it names none, and two people who share one
 *     rarely both have rooms. The room keeps the same two values with its
 *     first write, so a Quota that restarts in between still counts it.
 * A room is counted once, when its first peer authenticates and nothing of
 * it is stored yet.
 * The counter itself is the `Quota` Durable Object in edge-workers/collab/worker.mjs;
 * this file is its pure part (tested in plain Node).
 */
import { createHmac } from "node:crypto";

const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));

/** The UTC day of `nowMs`, e.g. "2026-11-12". */
export const dayOf = (nowMs = Date.now()) => new Date(nowMs).toISOString().slice(0, 10);

/** The eight 16-bit groups of an IPv6 address, or null (the rule of sync-server/vault-relay.js, #483). */
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

/**
 * What a client is counted as: `{address, p48}`. `address` is an IPv4 address
 * (IPv4-mapped IPv6 too) or an IPv6 /64; `p48` is the IPv6 /48, or null.
 */
export function addressParts(raw) {
  let a = String(raw || "?").trim().toLowerCase();
  if (a.startsWith("[")) a = a.slice(1, a.indexOf("]") >>> 0);
  a = a.replace(/%.*$/, "");
  const g = v6Groups(a);
  if (!g) return { address: a, p48: null };
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return { address: `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`, p48: null };
  const hex = (n) => g.slice(0, n).map((x) => x.toString(16)).join(":");
  return { address: `${hex(4)}::/64`, p48: `${hex(3)}::/48` };
}

const hmacKey = (secret, label) => createHmac("sha256", String(secret || "")).update(label).digest();
const h22 = (key, s) => createHmac("sha256", key).update(s).digest("base64url").slice(0, 22);
const ID = /^[ap]:[\w-]{22}$/;

/**
 * A client's ids, which do not depend on the day: ["a:<hmac>"] and, for
 * IPv6, "p:<hmac>" for its /48. The room keeps them with the socket (no
 * address); the Quota makes the day's bucket names from them. Cloudflare
 * sets CF-Connecting-IP; a client can't.
 */
export function quotaIds(secret, rawAddress) {
  const key = hmacKey(secret, "lumen-collab quota id v2");
  const { address, p48 } = addressParts(rawAddress);
  return [`a:${h22(key, address)}`, ...(p48 ? [`p:${h22(key, p48)}`] : [])];
}

/** Ids as the Quota accepts them: at most one of each kind, well formed. */
export function cleanIds(ids) {
  if (!Array.isArray(ids)) return [];
  const a = ids.find((k) => typeof k === "string" && ID.test(k) && k.startsWith("a:"));
  const p = ids.find((k) => typeof k === "string" && ID.test(k) && k.startsWith("p:"));
  return [a, p].filter(Boolean);
}

/** The day's bucket names for those ids, under a key for the day: the Quota's own day, never a caller's. */
export function dayBuckets(secret, ids, day) {
  const key = hmacKey(secret, `lumen-collab quota v2|${day}`);
  return cleanIds(ids).map((id) => `${id[0]}:${h22(key, id)}`);
}

/** The bucket names for a client on `day` (ids, then the day's names). */
export function quotaBuckets(secret, rawAddress, day = dayOf()) {
  return { day, keys: dayBuckets(secret, quotaIds(secret, rawAddress), day) };
}

/** A room's owner: 20 bits of a keyed hash of the creator's address id (about 4,000 IPv4 addresses share each value). */
export function ownerOf(secret, ids) {
  const a = cleanIds(ids).find((k) => k.startsWith("a:"));
  if (!a) return null;
  return createHmac("sha256", hmacKey(secret, "lumen-collab owner v1")).update(a).digest().readUInt32BE(0) >>> 12;
}

/** The same for the creator's IPv6 /48 (review 8, RR8-469-4), or null for IPv4. */
export function prefixOwnerOf(secret, ids) {
  const p = cleanIds(ids).find((k) => k.startsWith("p:"));
  if (!p) return null;
  return createHmac("sha256", hmacKey(secret, "lumen-collab owner /48 v1")).update(p).digest().readUInt32BE(0) >>> 12;
}

/** An owner value as the Quota accepts it from a room: a 20-bit integer, or null. */
export const cleanOwner = (v) => (Number.isInteger(v) && v >= 0 && v < 1 << 20 ? v : null);

/** The limits, from the Worker's vars. */
export function quotaLimits(env = {}) {
  const perAddress = Math.max(1, Math.floor(num(env.COLLAB_NEW_ROOMS_PER_ADDRESS, 20)));
  return {
    perDay: Math.max(1, Math.floor(num(env.COLLAB_NEW_ROOMS_PER_DAY, 2000))),
    perAddress,
    per48: Math.max(perAddress, Math.floor(num(env.COLLAB_NEW_ROOMS_PER_48, 4 * perAddress))),
    maxRooms: Math.max(1, Math.floor(num(env.COLLAB_MAX_ROOMS, 20_000))),
    maxBytes: Math.max(1, Math.floor(num(env.COLLAB_MAX_STORED_BYTES, 4_000_000_000))),
    storedPerAddress: Math.max(1, Math.floor(num(env.COLLAB_STORED_ROOMS_PER_ADDRESS, 50))),
    // A /48 is one site as a rule (RFC 6177): the same cap as one address (review 8, RR8-469-4).
    storedPer48: Math.max(1, Math.floor(num(env.COLLAB_STORED_ROOMS_PER_48, num(env.COLLAB_STORED_ROOMS_PER_ADDRESS, 50)))),
    // Bytes per address and per /48 (review 11, RR11-469-1): 1/200 of the store, so it takes 200 owners to fill it.
    storedBytesPerAddress: Math.max(1, Math.floor(num(env.COLLAB_STORED_BYTES_PER_ADDRESS, num(env.COLLAB_MAX_STORED_BYTES, 4_000_000_000) / 200))),
    protectMs: Math.max(0, num(env.COLLAB_PROTECT_DAYS, 14)) * 86_400_000,
  };
}

/** Is the store full (rooms or bytes)? */
export const storeFull = (counts, limits) => counts.stored >= limits.maxRooms || (counts.bytes ?? 0) >= limits.maxBytes;

/**
 * The decision, as a pure function of the counts: `counts` is
 * {day, rooms, stored, bytes, buckets: Map, owners: Map}. `day` is the
 * Quota's own; the counts never go back to an earlier day. Returns null to
 * admit (and counts it), or the reason: "rooms-full" | "address-stored" |
 * "prefix-stored" | "address-bytes" | "prefix-bytes" | "day" | "address" | "prefix".
 */
export function admit(counts, keys, day, limits, owner = null, owner48 = null) {
  if (day > counts.day) {
    counts.day = day;
    counts.rooms = 0;
    counts.buckets = new Map();
  }
  if (storeFull(counts, limits)) return "rooms-full";
  if (owner !== null && (counts.owners?.get(owner) ?? 0) >= limits.storedPerAddress) return "address-stored";
  if (owner48 !== null && (counts.owners48?.get(owner48) ?? 0) >= (limits.storedPer48 ?? limits.storedPerAddress)) return "prefix-stored";
  const byteCap = limits.storedBytesPerAddress ?? Infinity;
  if (owner !== null && (counts.ownerBytes?.get(owner) ?? 0) >= byteCap) return "address-bytes";
  if (owner48 !== null && (counts.owner48Bytes?.get(owner48) ?? 0) >= byteCap) return "prefix-bytes";
  if (counts.rooms >= limits.perDay) return "day";
  for (const k of keys) {
    const cap = k.startsWith("p:") ? limits.per48 : limits.perAddress;
    if ((counts.buckets.get(k) ?? 0) >= cap) return k.startsWith("p:") ? "prefix" : "address";
  }
  counts.rooms++;
  for (const k of keys) counts.buckets.set(k, (counts.buckets.get(k) ?? 0) + 1);
  return null;
}

/**
 * A refused attempt still costs the client one of its new rooms for the day
 * (review 8, RR8-469-1): asking again and again for a room the full store
 * can't make way for is not free. The server's own daily count is not
 * charged, so refusals can't use it up for everyone.
 */
export function charge(counts, keys) {
  for (const k of keys) counts.buckets.set(k, (counts.buckets.get(k) ?? 0) + 1);
}

/** A room that refused to make way (someone was connected) goes last for this long. */
export const BUSY_MS = 3_600_000;

/**
 * The stored rooms a new one may replace, in order: none that someone joined
 * again within `protectMs`; the smallest first, then the least recently
 * written; a room that refused within BUSY_MS after all the others (review 8,
 * RR8-469-2). `rooms` is a Map of id → {b: bytes, w: last write, a: last
 * joined again, u: last refused}.
 */
export function evictionOrder(rooms, nowMs, limits) {
  const busy = (r) => (r.u && nowMs - r.u < BUSY_MS ? 1 : 0);
  return [...rooms]
    .filter(([, r]) => !(r.a && nowMs - r.a < limits.protectMs))
    .sort(([, x], [, y]) => busy(x) - busy(y) || (x.b ?? 0) - (y.b ?? 0) || (x.w ?? 0) - (y.w ?? 0))
    .map(([id]) => id);
}

/**
 * What a full store frees for one new room (review 8, RR8-469-1): one room's
 * place when the rooms are full, and the room's share of the bytes when the
 * bytes are (COLLAB_MAX_STORED_BYTES / COLLAB_MAX_ROOMS, or less when the
 * store is over by less). Stored rooms that grew past the cap are not made up
 * for by evicting others: each new room takes one place, never more.
 */
export function needed(counts, limits) {
  const share = Math.max(1, Math.floor(limits.maxBytes / limits.maxRooms));
  const over = (counts.bytes ?? 0) - limits.maxBytes + 1;
  return { rooms: counts.stored >= limits.maxRooms ? 1 : 0, bytes: over > 0 ? Math.min(over, share) : 0 };
}

/** At most this many rooms make way for one new room. */
export const MAX_PLAN_ROOMS = 32;

/**
 * The rooms, of `order` (eviction order), that free `need` for one new room
 * (review 8, RR8-469-1; review 11, RR11-469-1): the smallest one that is
 * enough alone; else the smallest ones, each smaller than that, until they
 * are enough (at most MAX_PLAN_ROOMS, and under two shares in all); null
 * when neither works, and then nothing is evicted.
 */
export function evictionPlan(rooms, order, need) {
  const size = (id) => rooms.get(id)?.b ?? 0;
  const one = order.find((id) => size(id) >= need.bytes);
  if (one !== undefined) return [one];
  const plan = [];
  let freed = 0;
  for (const id of [...order].sort((x, y) => size(x) - size(y))) {
    if (plan.length >= MAX_PLAN_ROOMS) break;
    plan.push(id);
    freed += size(id);
    if (freed >= need.bytes && plan.length >= need.rooms) return plan;
  }
  return null;
}
