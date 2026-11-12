// Review 2 (RR2-469-1): the public collab server limits new rooms, per day on the whole server, per
// address (IPv4, or IPv6 /64) and per IPv6 /48, and how many rooms are stored at once.
// Review 6: the day is the Quota's own (RR6-469-1); stored bytes and rooms per address are capped, and a
// full store makes way with the smallest room nobody came back to (RR6-469-2).
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM server module, no types
import { addressParts, admit, dayOf, evictionOrder, ownerOf, quotaBuckets, quotaIds, quotaLimits } from "../../sync-server/collab/roomQuota.mjs";
// @ts-expect-error -- plain ESM server module, no types
import { Quota } from "../../edge-workers/collab/worker.mjs";

type Counts = { day: string; rooms: number; stored: number; bytes: number; buckets: Map<string, number>; owners: Map<number, number> };
const fresh = (): Counts => ({ day: "", rooms: 0, stored: 0, bytes: 0, buckets: new Map(), owners: new Map() });
const SECRET = "k".repeat(40);

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
    env.ROOMS = { idFromString: (d: string) => d, get: (d: string) => ({ evict: async () => (d === "busy" ? false : (evicted.push(d), true)) }) };
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
    await q.joined("b1");
    expect(await q.admit(quotaIds(SECRET, "192.0.2.55"), "c1")).toBeNull();
    expect(evicted).toEqual(["a1"]);
    expect(st.data.has("r:a1")).toBe(false);
    expect(st.data.has("r:b1")).toBe(true);
    await q.saved("c1", 1, "c1");
    // Full again, and every room is in use or came back recently: refused.
    await q.joined("c1");
    expect(await q.admit(quotaIds(SECRET, "192.0.2.56"), "d1")).toBe("rooms-full");
    expect(evicted).toEqual(["a1"]);
  });
});
