// Review 2 (RR2-469-1): the public collab server limits new rooms, per day on the whole server, per
// address (IPv4, or IPv6 /64) and per IPv6 /48, and how many rooms are stored at once.
// Review 6: the day is the Quota's own (RR6-469-1); stored bytes and rooms per address are capped, and a
// full store makes way with the smallest room nobody came back to (RR6-469-2).
// Review 8: only for an attempt that passes everything else, one room per new room, and only when that room is
// enough; a refused attempt still counts; a room in use goes last; the owner survives a Quota restart; and a
// /48 has a stored-room cap too (RR8-469-1 to -4).
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM server module, no types
import { addressParts, admit, BUSY_MS, dayOf, evictionOrder, evictionPlan, needed, ownerOf, prefixOwnerOf, quotaBuckets, quotaIds, quotaLimits } from "../../sync-server/collab/roomQuota.mjs";
// @ts-expect-error -- plain ESM server module, no types
import { Quota } from "../../edge-workers/collab/worker.mjs";

type Counts = { day: string; rooms: number; stored: number; bytes: number; buckets: Map<string, number>; owners: Map<number, number> };
const fresh = (): Counts => ({ day: "", rooms: 0, stored: 0, bytes: 0, buckets: new Map(), owners: new Map() });
const SECRET = "k".repeat(40);
/** Someone other than any room's creator in these tests (review 11: only such a return protects a room). */
const visitor = ownerOf(SECRET, quotaIds(SECRET, "192.0.2.250"));

function memState() {
  const data = new Map<string, unknown>();
  return {
    data,
    storage: {
      async list() {
        return new Map(data);
      },
      async put(o: Record<string, unknown>) {
        for (const [k, v] of Object.entries(o)) data.set(k, v);
      },
      async delete(k: string | string[]) {
        for (const x of ([] as string[]).concat(k)) data.delete(x);
      },
      async deleteAll() {
        data.clear();
      },
    },
  };
}

const realNow = Date.now;
/** The clock at `iso` (the Quota reads Date.now). */
const at = (iso: string) => {
  const t = Date.parse(iso);
  Date.now = () => t;
};
afterEach(() => {
  Date.now = realNow;
});

describe("new-room limits (roomQuota.mjs)", () => {
  it("counts IPv4 by address, IPv6 by /64 and /48, and IPv4-mapped as IPv4", () => {
    expect(addressParts("203.0.113.7")).toEqual({ address: "203.0.113.7", p48: null });
    expect(addressParts("::ffff:203.0.113.7")).toEqual({ address: "203.0.113.7", p48: null });
    expect(addressParts("2001:db8:1:2:aaaa::1")).toEqual({ address: "2001:db8:1:2::/64", p48: "2001:db8:1::/48" });
    expect(addressParts("[2001:db8:1:2:bbbb::9]").address).toBe("2001:db8:1:2::/64");
  });

  it("keeps no address: ids are HMACs, bucket names an HMAC of them under a key for the day", () => {
    const ids = quotaIds(SECRET, "2001:db8:1:2::1");
    expect(ids).toHaveLength(2);
    for (const k of ids) expect(k).toMatch(/^[ap]:[\w-]{22}$/);
    expect(quotaIds(SECRET, "2001:db8:1:2::ffff")).toEqual(ids);
    const a = quotaBuckets(SECRET, "2001:db8:1:2::1", "2026-11-12");
    expect(a.keys).toHaveLength(2);
    expect(JSON.stringify([ids, a])).not.toContain("2001");
    expect(quotaBuckets(SECRET, "2001:db8:1:2::ffff", "2026-11-12").keys).toEqual(a.keys);
    expect(quotaBuckets(SECRET, "2001:db8:1:2::1", "2026-11-13").keys[0]).not.toBe(a.keys[0]);
    expect(quotaBuckets(SECRET, "203.0.113.7").keys).toHaveLength(1);
    // An owner is 20 bits: it names no address.
    const o = ownerOf(SECRET, quotaIds(SECRET, "203.0.113.7"));
    expect(o).toBeGreaterThanOrEqual(0);
    expect(o).toBeLessThan(2 ** 20);
  });

  it("refuses past the per-address, per-/48, daily and stored limits, and never goes back a day", () => {
    const L = quotaLimits({ COLLAB_NEW_ROOMS_PER_DAY: "10", COLLAB_NEW_ROOMS_PER_ADDRESS: "2", COLLAB_NEW_ROOMS_PER_48: "3", COLLAB_MAX_ROOMS: "5", COLLAB_MAX_STORED_BYTES: "1000", COLLAB_STORED_ROOMS_PER_ADDRESS: "3" });
    expect(L).toMatchObject({ perDay: 10, perAddress: 2, per48: 3, maxRooms: 5, maxBytes: 1000, storedPerAddress: 3 });
    expect(quotaLimits({})).toMatchObject({ maxRooms: 20_000, maxBytes: 4_000_000_000, storedPerAddress: 50, protectMs: 14 * 86_400_000 });
    const c = fresh();
    const day = "2026-11-12";
    const v6 = (i: number) => quotaBuckets(SECRET, `2001:db8:7:${i}::1`, day).keys;
    expect(admit(c, v6(1), day, L)).toBeNull();
    expect(admit(c, v6(1), day, L)).toBeNull();
    expect(admit(c, v6(1), day, L)).toBe("address");
    expect(admit(c, v6(2), day, L)).toBeNull();
    expect(admit(c, v6(3), day, L)).toBe("prefix");
    for (let i = 0; i < 7; i++) expect(admit(c, quotaBuckets(SECRET, `198.51.100.${i}`, day).keys, day, L)).toBeNull();
    expect(admit(c, quotaBuckets(SECRET, "198.51.100.99", day).keys, day, L)).toBe("day");
    // An earlier day changes nothing: the counts stay today's.
    expect(admit(c, quotaBuckets(SECRET, "198.51.100.98", "2026-11-11").keys, "2026-11-11", L)).toBe("day");
    expect(c.day).toBe(day);
    // The next day the daily counts start over; the stored rooms and bytes don't.
    c.stored = 5;
    expect(admit(c, v6(1), "2026-11-13", L)).toBe("rooms-full");
    c.stored = 4;
    c.bytes = 1000;
    expect(admit(c, v6(1), "2026-11-13", L)).toBe("rooms-full");
    c.bytes = 10;
    c.owners.set(7, 3);
    expect(admit(c, v6(1), "2026-11-13", L, 7)).toBe("address-stored");
    expect(admit(c, v6(1), "2026-11-13", L, 8)).toBeNull();
    expect(c.rooms).toBe(1);
  });

  it("evicts the smallest, then the least recently written, never a room someone came back to recently", () => {
    const L = quotaLimits({ COLLAB_PROTECT_DAYS: "14" });
    const now = Date.parse("2026-11-12T12:00:00Z");
    const rooms = new Map([
      ["big-old", { b: 900, w: now - 50 * 86_400_000, a: 0 }],
      ["small-new", { b: 10, w: now - 1000, a: 0 }],
      ["small-old", { b: 10, w: now - 9 * 86_400_000, a: 0 }],
      ["tiny-back", { b: 1, w: now - 60 * 86_400_000, a: now - 86_400_000 }],
      ["tiny-back-long-ago", { b: 1, w: now - 60 * 86_400_000, a: now - 30 * 86_400_000 }],
    ]);
    expect(evictionOrder(rooms, now, L)).toEqual(["tiny-back-long-ago", "small-old", "small-new", "big-old"]);
  });
});

describe("the Quota object (worker.mjs)", () => {
  it("keeps its counts in storage and drops yesterday's buckets; the caller can't name the day (RR6-469-1)", async () => {
    const st = memState();
    const env = { COLLAB_TOKEN_SECRET: SECRET, COLLAB_NEW_ROOMS_PER_ADDRESS: "1" };
    const ids = quotaIds(SECRET, "203.0.113.7");
    at("2026-11-12T23:59:00Z");
    const q = new Quota(st, env);
    expect(await q.admit(ids, "r1")).toBeNull();
    // Woken again (a new instance): the count was kept. A day given by the caller is ignored.
    const q2 = new Quota(st, env);
    expect(await q2.admit(ids, "2026-11-13")).toBe("address");
    expect(await q2.admit(["junk"], "r2")).toBeNull(); // malformed ids are ignored, the day still counts
    expect(await q2.saved("r1", 100, "")).toBe(1);
    at("2026-11-13T00:01:00Z");
    expect(await q2.admit(ids, "r3")).toBeNull();
    expect([...st.data.keys()].filter((x) => x.startsWith("b:"))).toHaveLength(1);
    expect(st.data.get("day")).toBe("2026-11-13");
    expect(st.data.get("stored")).toBe(1);
    expect(st.data.get("bytes")).toBe(100);
    // The clock going back doesn't take the counts back.
    at("2026-11-12T23:00:00Z");
    expect(await q2.admit(ids, "r4")).toBe("address");
    expect(st.data.get("day")).toBe("2026-11-13");
    expect(await q2.forget("r1")).toBe(0);
    expect(await q2.forget("r1")).toBe(0);
    expect(dayOf(Date.UTC(2026, 10, 12, 23, 59))).toBe("2026-11-12");
  });

  it("counts stored bytes and rooms per address; a full store makes way only with a room nobody came back to (RR6-469-2)", async () => {
    const st = memState();
    const evicted: string[] = [];
    const env: Record<string, unknown> = { COLLAB_TOKEN_SECRET: SECRET, COLLAB_MAX_ROOMS: "3", COLLAB_STORED_ROOMS_PER_ADDRESS: "2" };
    env.ROOMS = { idFromString: (d: string) => d, get: (d: string) => ({ canEvict: async () => d !== "busy", evict: async () => (d === "busy" ? false : (evicted.push(d), true)) }) };
    const q = new Quota(st, env);
    at("2026-11-12T10:00:00Z");
    const one = quotaIds(SECRET, "198.51.100.1");
    // Two rooms per address are stored; the third is refused for that address.
    expect(await q.admit(one, "a1")).toBeNull();
    await q.saved("a1", 50, "a1");
    expect(await q.admit(one, "a2")).toBeNull();
    await q.saved("a2", 5, "busy");
    expect(await q.admit(one, "a3")).toBe("address-stored");
    expect(await q.admit(quotaIds(SECRET, "198.51.100.2"), "b1")).toBeNull();
    await q.saved("b1", 20, "b1");
    expect(q.counts.bytes).toBe(75);
    // b1 has a visitor back: it is kept. The store is full: a new user's room replaces the smallest that
    // can go (a2 is in use and refuses, so a1).
    await q.joined("b1", visitor);
    expect(await q.admit(quotaIds(SECRET, "192.0.2.55"), "c1")).toBeNull();
    expect(evicted).toEqual(["a1"]);
    expect(st.data.has("r:a1")).toBe(false);
    expect(st.data.has("r:b1")).toBe(true);
    await q.saved("c1", 1, "c1");
    // Full again, and every room is in use or came back recently: refused.
    await q.joined("c1", visitor);
    expect(await q.admit(quotaIds(SECRET, "192.0.2.56"), "d1")).toBe("rooms-full");
    expect(evicted).toEqual(["a1"]);
  });

  it("a refused attempt evicts nothing and still counts; small rooms make way together, up to what one new room needs (RR8-469-1, RR11-469-1)", async () => {
    const st = memState();
    const evicted: string[] = [];
    // The byte cap per owner is lifted here, so the big room stays protected (RR14-469-1a has its own case).
    const env: Record<string, unknown> = { COLLAB_TOKEN_SECRET: SECRET, COLLAB_MAX_ROOMS: "100", COLLAB_MAX_STORED_BYTES: "1000", COLLAB_NEW_ROOMS_PER_ADDRESS: "3", COLLAB_STORED_BYTES_PER_ADDRESS: "1000000" };
    env.ROOMS = { idFromString: (d: string) => d, get: (d: string) => ({ canEvict: async () => true, evict: async () => (evicted.push(d), true) }) };
    const q = new Quota(st, env);
    at("2026-11-12T10:00:00Z");
    // Three small notes from three people, and a big room someone else came back to (protected), over the cap.
    for (let i = 0; i < 3; i++) {
      expect(await q.admit(quotaIds(SECRET, `192.0.2.${i}`), `v${i}`)).toBeNull();
      await q.saved(`v${i}`, 2, `v${i}`);
    }
    expect(await q.admit(quotaIds(SECRET, "203.0.113.1"), "big")).toBeNull();
    await q.saved("big", 1200, "big");
    expect(await q.joined("big", visitor)).toBe(true);
    // One room's share is 1000/100 = 10 bytes; the notes nobody came back to hold 6 in all: refused, nothing
    // evicted, and each refusal is one of the address's 3 rooms for the day.
    const attacker = quotaIds(SECRET, "198.51.100.66");
    for (let i = 0; i < 3; i++) expect(await q.admit(attacker, `x${i}`)).toBe("rooms-full");
    expect(await q.admit(attacker, "x3")).toBe("address");
    expect(evicted).toEqual([]);
    expect(q.counts.stored).toBe(4);
    // Grown to 2 + 4 + 5: together they are one share, so they make way for one new room, the largest first.
    await q.saved("v1", 4, "v1");
    await q.saved("v2", 5, "v2");
    expect(await q.admit(quotaIds(SECRET, "198.51.100.7"), "n1")).toBeNull();
    expect(evicted).toEqual(["v2", "v1", "v0"]);
  });

  it("the creator's own return protects nothing; bytes per address are capped (RR11-469-1)", async () => {
    const st = memState();
    const env: Record<string, unknown> = { COLLAB_TOKEN_SECRET: SECRET, COLLAB_MAX_STORED_BYTES: "20000" };
    const q = new Quota(st, env);
    at("2026-11-12T10:00:00Z");
    const one = quotaIds(SECRET, "198.51.100.1");
    expect(await q.admit(one, "a1")).toBeNull();
    await q.saved("a1", 60, "a1", { o: ownerOf(SECRET, one), p: null });
    expect(await q.joined("a1", ownerOf(SECRET, one))).toBe(false);
    expect(await q.joined("a1", null)).toBe(false);
    expect(st.data.get("r:a1")).toMatchObject({ a: 0 });
    // 20000/200 = 100 bytes per address: past it, no new room for that address; another address is not affected.
    expect(await q.admit(one, "a2")).toBeNull();
    await q.saved("a2", 50, "a2");
    expect(await q.admit(one, "a3")).toBe("address-bytes");
    expect(await q.admit(quotaIds(SECRET, "198.51.100.2"), "b1")).toBeNull();
    expect(await q.joined("a1", visitor)).toBe(true);
  });

  it("plans: the share of one room, the smallest room that is enough, else small ones together (RR8-469-1, RR11-469-1)", () => {
    const L = quotaLimits({ COLLAB_MAX_ROOMS: "10", COLLAB_MAX_STORED_BYTES: "1000" });
    expect(needed({ stored: 5, bytes: 999 }, L)).toEqual({ rooms: 0, bytes: 0 });
    expect(needed({ stored: 5, bytes: 1000 }, L)).toEqual({ rooms: 0, bytes: 1 });
    expect(needed({ stored: 10, bytes: 5000 }, L)).toEqual({ rooms: 1, bytes: 100 });
    const rooms = new Map([["a", { b: 5 }], ["b", { b: 150 }], ["c", { b: 120 }]]);
    expect(evictionPlan(rooms, ["a", "c", "b"], { rooms: 1, bytes: 100 })).toEqual(["c"]);
    expect(evictionPlan(rooms, ["a", "c", "b"], { rooms: 1, bytes: 0 })).toEqual(["a"]);
    expect(evictionPlan(rooms, ["a"], { rooms: 0, bytes: 100 })).toBeNull();
    // None is enough alone: rooms smaller than the need together, the largest first (RR11-469-1, RR14-469-1c).
    const small = new Map([["s1", { b: 40 }], ["s2", { b: 30 }], ["s3", { b: 50 }], ["s4", { b: 90 }]]);
    expect(evictionPlan(small, ["s2", "s1", "s3", "s4"], { rooms: 0, bytes: 100 })).toEqual(["s4", "s3"]);
    expect(evictionPlan(small, ["s2"], { rooms: 0, bytes: 100 })).toBeNull();
  });

  it("a room in use doesn't stop the search, and goes last for an hour (RR8-469-2)", async () => {
    const st = memState();
    const asked: string[] = [];
    const env: Record<string, unknown> = { COLLAB_TOKEN_SECRET: SECRET, COLLAB_MAX_ROOMS: "12", COLLAB_STORED_ROOMS_PER_ADDRESS: "50" };
    const busy = new Set(Array.from({ length: 10 }, (_, i) => `t${i}`));
    env.ROOMS = { idFromString: (d: string) => d, get: (d: string) => ({ canEvict: async () => (asked.push(d), !busy.has(d)), evict: async () => !busy.has(d) }) };
    const q = new Quota(st, env);
    at("2026-11-12T10:00:00Z");
    // Ten tiny rooms someone holds, then one ordinary room: more than eight refusals before the one that can go.
    for (let i = 0; i < 10; i++) {
      expect(await q.admit(quotaIds(SECRET, `192.0.2.${i}`), `t${i}`)).toBeNull();
      await q.saved(`t${i}`, 1, `t${i}`);
    }
    for (const id of ["ok", "ok2"]) {
      expect(await q.admit(quotaIds(SECRET, `198.51.100.${id.length}`), id)).toBeNull();
      await q.saved(id, 50, id);
    }
    expect(await q.admit(quotaIds(SECRET, "203.0.113.9"), "n1")).toBeNull();
    expect(asked.filter((d) => d.startsWith("t"))).toHaveLength(10);
    expect(q.counts.registry.has("ok")).toBe(false);
    // The ten refused: they go last now, so the next new room asks the ordinary room first.
    expect(evictionOrder(q.counts.registry, Date.now(), quotaLimits(env))[0]).toBe("ok2");
    expect(evictionOrder(q.counts.registry, Date.now() + BUSY_MS, quotaLimits(env))[0]).toMatch(/^t/);
  });

  it("the owner comes with the room's first write, so a Quota restart doesn't lose it; a /48 has a stored cap (RR8-469-3, -4)", async () => {
    const st = memState();
    const env: Record<string, unknown> = { COLLAB_TOKEN_SECRET: SECRET, COLLAB_STORED_ROOMS_PER_ADDRESS: "2", COLLAB_NEW_ROOMS_PER_48: "100" };
    at("2026-11-12T10:00:00Z");
    const one = quotaIds(SECRET, "198.51.100.1");
    const owner = { o: ownerOf(SECRET, one), p: prefixOwnerOf(SECRET, one) };
    for (const rid of ["a1", "a2"]) {
      expect(await new Quota(st, env).admit(one, rid)).toBeNull();
      // A new instance (the old one evicted from memory) gets the owner from the room.
      await new Quota(st, env).saved(rid, 10, "", owner);
    }
    expect(await new Quota(st, env).admit(one, "a3")).toBe("address-stored");
    // Junk from a room is not an owner.
    const q = new Quota(st, env);
    expect(await q.admit(quotaIds(SECRET, "198.51.100.2"), "b1")).toBeNull();
    await new Quota(st, env).saved("b1", 10, "", { o: "x", p: 2 ** 21 });
    expect(st.data.get("r:b1")).toMatchObject({ o: null, p: null });
    // IPv6: one /48, a new /64 each time, still two stored rooms.
    const v6 = (n: number) => quotaIds(SECRET, `2001:db8:77:${n.toString(16)}::1`);
    for (let n = 1; n <= 2; n++) {
      const q6 = new Quota(st, env);
      expect(await q6.admit(v6(n), `p${n}`)).toBeNull();
      await q6.saved(`p${n}`, 10, "");
    }
    expect(await new Quota(st, env).admit(v6(3), "p3")).toBe("prefix-stored");
  });

  // Review 14 (RR14-469-1, -2): each gap as a regression, at a scale where the store really is full.
  it("RR14-469-1a: an owner's rooms that grew past its byte cap after admission make way first, protected or not", async () => {
    const st = memState();
    const evicted: string[] = [];
    // 8,000 bytes, 10 rooms: one room's share 800; 40 bytes per owner.
    const env: Record<string, unknown> = { COLLAB_TOKEN_SECRET: SECRET, COLLAB_MAX_ROOMS: "10", COLLAB_MAX_STORED_BYTES: "8000" };
    env.ROOMS = { idFromString: (d: string) => d, get: (d: string) => ({ canEvict: async () => true, evict: async () => (evicted.push(d), true) }) };
    const q = new Quota(st, env);
    at("2026-11-12T10:00:00Z");
    const a = quotaIds(SECRET, "203.0.113.5");
    for (const rid of ["g1", "g2"]) {
      expect(await q.admit(a, rid)).toBeNull();
      await q.saved(rid, 10, rid);
      expect(await q.joined(rid, { o: visitor, p: null })).toBe(true); // someone else came back: protected
    }
    expect(await q.admit(quotaIds(SECRET, "192.0.2.9"), "note")).toBeNull();
    await q.saved("note", 5, "note");
    // Both of the owner's rooms grow past its 40 bytes after admission, and fill the store.
    await q.saved("g1", 4000, "g1");
    await q.saved("g2", 4000, "g2");
    expect(q.counts.bytes).toBeGreaterThanOrEqual(8000);
    expect(await q.admit(quotaIds(SECRET, "198.51.100.30"), "n1")).toBeNull();
    expect(evicted).toHaveLength(1);
    expect(evicted[0]).toMatch(/^g/);
    expect(q.counts.registry.has("note")).toBe(true);
  });

  it("RR14-469-1b: a return from another /64 of the creator's own /48 protects nothing; another address does", async () => {
    const st = memState();
    const env: Record<string, unknown> = { COLLAB_TOKEN_SECRET: SECRET };
    const q = new Quota(st, env);
    at("2026-11-12T10:00:00Z");
    const v6 = (n: number) => quotaIds(SECRET, `2001:db8:77:${n.toString(16)}::1`);
    const who = (ids: string[]) => ({ o: ownerOf(SECRET, ids), p: prefixOwnerOf(SECRET, ids) });
    expect(await q.admit(v6(1), "r6")).toBeNull();
    await q.saved("r6", 10, "r6", who(v6(1)));
    expect(await q.joined("r6", who(v6(2)))).toBe(false);
    expect(await q.joined("r6", who(quotaIds(SECRET, "2001:db8:99::1")))).toBe(true);
  });

  it("RR14-469-1c: 32 tiny rooms don't block a plan that larger rooms under the need can make", () => {
    const rooms = new Map<string, { b: number }>();
    for (let i = 0; i < 40; i++) rooms.set(`tiny${i}`, { b: 1 });
    for (let i = 0; i < 5; i++) rooms.set(`mid${i}`, { b: 60 });
    const order = [...rooms.keys()]; // eviction order: smallest first
    const plan = evictionPlan(rooms, order, { rooms: 0, bytes: 100 });
    expect(plan).not.toBeNull();
    expect(plan!.reduce((n: number, id: string) => n + rooms.get(id)!.b, 0)).toBeGreaterThanOrEqual(100);
    expect(plan!.length).toBeLessThanOrEqual(2);
  });

  it("RR14-469-2: every canEvict call counts, also those inside a plan that then fails", async () => {
    const st = memState();
    let asks = 0;
    // 1,000 bytes, 10 rooms: share 100. 300 rooms of 10 bytes: a plan needs 10 of them. The first 9 always agree, every other refuses.
    const env: Record<string, unknown> = { COLLAB_TOKEN_SECRET: SECRET, COLLAB_MAX_ROOMS: "10", COLLAB_MAX_STORED_BYTES: "1000" };
    const agree = new Set(Array.from({ length: 9 }, (_, i) => `k${i}`));
    env.ROOMS = { idFromString: (d: string) => d, get: (d: string) => ({ canEvict: async () => (asks++, agree.has(d)), evict: async () => true }) };
    const q = new Quota(st, env);
    at("2026-11-12T10:00:00Z");
    for (let i = 0; i < 300; i++) await q.saved(`k${i}`, 10, `k${i}`);
    expect(await q.admit(quotaIds(SECRET, "198.51.100.40"), "n1")).toBe("rooms-full");
    expect(asks).toBeLessThanOrEqual(256);
  });
});

