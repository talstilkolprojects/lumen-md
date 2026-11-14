/**
 * Plan W6.23 (review 12.11 #15): the public live-share server's E2EE check
 * reads only the incoming update, never the whole room.
 *
 *  - The new check gives the same answer as the old one (apply the room and
 *    the update to a probe document and look at everything) on a few
 *    thousand generated updates: envelopes appended, inserted between
 *    existing ones, deleted, compacted; text, maps, nested types, envelopes
 *    with extra fields, updates that need structs the room doesn't have.
 *  - A 4 MB room: one update costs well under the CPU time Cloudflare
 *    Workers gives a Durable Object per WebSocket message on the Free plan
 *    (10 ms), measured here with a timer, and does not grow with the room.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
// @ts-expect-error -- plain ESM server module, no types
import { checkE2eeUpdate, createRelayRoom } from "../../sync-server/collab/relay.mjs";

type Check = (doc: Y.Doc, update: Uint8Array) => string | null;
const check = checkE2eeUpdate as Check;

/** Workers Free: 10 ms of CPU per request, and each WebSocket message is one (developers.cloudflare.com/workers/platform/limits). */
const WORKERS_FREE_CPU_MS = 10;

const isEnvelope = (x: unknown): boolean => {
  if (!x || typeof x !== "object" || Array.isArray(x) || x instanceof Uint8Array) return false;
  const o = x as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "v" && k !== "iv" && k !== "ct" && k !== "s")) return false;
  return (
    typeof o.v === "number" &&
    Number.isInteger(o.v) &&
    o.iv instanceof Uint8Array &&
    o.iv.byteLength === 12 &&
    o.ct instanceof Uint8Array &&
    o.ct.byteLength >= 16 &&
    (o.s === undefined || o.s === 1)
  );
};

/** The check as #469 shipped it: the room encoded again for every update. */
function fullCheck(doc: Y.Doc, update: Uint8Array): string | null {
  const probe = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(probe, update);
  } catch {
    probe.destroy();
    return "malformed";
  }
  try {
    if (probe.store.pendingStructs !== null || probe.store.pendingDs !== null) return "incomplete";
    for (const [name, type] of probe.share) {
      if (name === "e2e") continue;
      if (type._start !== null || type._map.size > 0) return "plaintext";
    }
    const raw = probe.share.get("e2e");
    if (!raw) return null;
    if (raw._map.size > 0) return "plaintext";
    for (const item of probe.getArray("e2e").toArray()) if (!isEnvelope(item)) return "not-envelope";
    return null;
  } finally {
    probe.destroy();
  }
}

/** A small deterministic PRNG, so a failure can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const envelope = (ctBytes = 40, fill = 2) => ({ v: 2, iv: new Uint8Array(12).fill(1), ct: new Uint8Array(ctBytes).fill(fill) });

/** What a peer that has the room (or none of it) sends after `edit`. */
function updateFrom(room: Y.Doc, edit: (d: Y.Doc) => void, opts: { clientID?: number; partial?: boolean } = {}) {
  const d = new Y.Doc();
  if (opts.clientID !== undefined) d.clientID = opts.clientID;
  Y.applyUpdate(d, Y.encodeStateAsUpdate(room));
  const sv = Y.encodeStateVector(d);
  edit(d);
  const u = Y.encodeStateAsUpdate(d, sv);
  d.destroy();
  return u;
}

const EDITS: Array<[string, (d: Y.Doc, r: () => number) => void]> = [
  ["append", (d) => d.getArray("e2e").push([envelope()])],
  ["append snapshot", (d) => d.getArray("e2e").push([{ ...envelope(64), s: 1 }])],
  ["insert at start", (d) => d.getArray("e2e").insert(0, [envelope()])],
  ["insert in the middle", (d, r) => { const a = d.getArray("e2e"); a.insert(Math.floor(r() * (a.length + 1)), [envelope()]); }],
  ["several at once", (d, r) => { const a = d.getArray("e2e"); a.insert(Math.floor(r() * (a.length + 1)), [envelope(), envelope(20), envelope()]); }],
  ["delete one", (d, r) => { const a = d.getArray("e2e"); if (a.length) a.delete(Math.floor(r() * a.length), 1); }],
  ["compact", (d) => { const a = d.getArray("e2e"); const n = a.length; a.push([{ ...envelope(80), s: 1 }]); if (n) a.delete(0, n); }],
  ["text", (d) => d.getText("codemirror").insert(0, "a note")],
  ["map", (d) => d.getMap("meta").set("title", "x")],
  [
    "key on the array",
    (d) => {
      // Another peer's Y.Map("e2e"): its key lands on the room's array type.
      const m = new Y.Doc();
      m.getMap("e2e").set("k", "x");
      Y.applyUpdate(d, Y.encodeStateAsUpdate(m));
      m.destroy();
    },
  ],
  ["a string in the array", (d, r) => { const a = d.getArray("e2e"); a.insert(Math.floor(r() * (a.length + 1)), ["a note"]); }],
  ["short iv", (d) => d.getArray("e2e").push([{ ...envelope(), iv: new Uint8Array(8) }])],
  ["extra field", (d) => d.getArray("e2e").push([{ ...envelope(), text: "leak" }])],
  ["nested type", (d) => d.getArray("e2e").push([new Y.Map()])],
  ["nested text", (d) => { const t = new Y.Text(); d.getArray("e2e").push([t]); t.insert(0, "x"); }],
  ["binary", (d) => d.getArray("e2e").push([new Uint8Array(40)])],
];

describe("checkE2eeUpdate reads only the update", () => {
  it("answers as the full check does, on 3,000 generated updates", () => {
    const r = rng(0x5eed);
    let compared = 0;
    const seen = new Map<string, number>();
    for (let round = 0; round < 60; round++) {
      // A room that passed the check, built by three peers.
      const room = new Y.Doc();
      for (let i = 0; i < 40; i++) {
        const legal = EDITS.filter(([n]) => ["append", "insert in the middle", "several at once", "delete one", "compact", "append snapshot", "insert at start"].includes(n));
        const [, edit] = legal[Math.floor(r() * legal.length)];
        Y.applyUpdate(room, updateFrom(room, (d) => edit(d, r), { clientID: 1 + Math.floor(r() * 3) }));
      }
      expect(fullCheck(room, new Uint8Array([0, 0]))).toBeNull();
      for (let k = 0; k < 50; k++) {
        const [name, edit] = EDITS[Math.floor(r() * EDITS.length)];
        const u = updateFrom(room, (d) => edit(d, r), { clientID: 10 + Math.floor(r() * 3) });
        const want = fullCheck(room, u);
        expect([name, check(room, u)]).toEqual([name, want]);
        seen.set(String(want), (seen.get(String(want)) ?? 0) + 1);
        compared++;
        // Updates sent before the room had what they build on.
        const late = new Y.Doc();
        late.clientID = 20;
        Y.applyUpdate(late, Y.encodeStateAsUpdate(room));
        late.getArray("e2e").push([envelope()]);
        const step1 = Y.encodeStateAsUpdate(late, Y.encodeStateVector(room));
        const sv = Y.encodeStateVector(late);
        edit(late, r);
        const step2 = Y.encodeStateAsUpdate(late, sv);
        late.destroy();
        expect([name, "late", check(room, step2)]).toEqual([name, "late", fullCheck(room, step2)]);
        compared++;
        if (want === null) Y.applyUpdate(room, u);
        if (k % 7 === 0) Y.applyUpdate(room, step1);
      }
      room.destroy();
    }
    expect(compared).toBe(6000);
    // Every answer came up, so each branch was compared.
    for (const why of ["null", "plaintext", "not-envelope"]) expect(seen.get(why) ?? 0).toBeGreaterThan(20);
  });

  it("refuses an update that needs what the room lacks, and garbage", () => {
    const room = new Y.Doc();
    const a = new Y.Doc();
    a.getArray("e2e").push([envelope()]);
    const first = Y.encodeStateAsUpdate(a);
    const sv = Y.encodeStateVector(a);
    a.getArray("e2e").push([envelope()]);
    const second = Y.encodeStateAsUpdate(a, sv);
    expect(check(room, second)).toBe("incomplete");
    expect(fullCheck(room, second)).toBe("incomplete");
    expect(check(room, first)).toBeNull();
    expect(check(room, new Uint8Array([1, 2, 3, 250]))).toBe("malformed");
  });

  it("leaves the room as it was", () => {
    const room = new Y.Doc();
    Y.applyUpdate(room, updateFrom(room, (d) => d.getArray("e2e").push([envelope(), envelope()])));
    const before = Y.encodeStateAsUpdate(room);
    expect(check(room, updateFrom(room, (d) => d.getText("t").insert(0, "x")))).toBe("plaintext");
    expect(check(room, updateFrom(room, (d) => d.getArray("e2e").insert(1, [envelope()])))).toBeNull();
    expect(Y.encodeStateAsUpdate(room)).toEqual(before);
  });
});

/** A room of `bytes`: a compacted snapshot and many small envelopes from several peers, as src/collab/e2e.ts makes them. */
function bigRoom(bytes: number, smallCount: number) {
  const room = new Y.Doc();
  const peer = new Y.Doc();
  peer.clientID = 7;
  const snapBytes = bytes - smallCount * 220;
  peer.getArray("e2e").push([{ ...envelope(snapBytes, 3), s: 1 }]);
  Y.applyUpdate(room, Y.encodeStateAsUpdate(peer));
  const others = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
  others.forEach((d, i) => {
    d.clientID = 100 + i;
    Y.applyUpdate(d, Y.encodeStateAsUpdate(room));
  });
  for (let i = 0; i < smallCount; i++) {
    const d = others[i % others.length];
    Y.applyUpdate(d, Y.encodeStateAsUpdate(room, Y.encodeStateVector(d)));
    const sv = Y.encodeStateVector(d);
    const a = d.getArray("e2e");
    // Interleaved, so the room keeps thousands of separate structs.
    a.insert(i % 5 === 0 ? Math.floor(a.length / 2) : a.length, [envelope(180, i & 255)]);
    Y.applyUpdate(room, Y.encodeStateAsUpdate(d, sv));
  }
  for (const d of [peer, ...others]) d.destroy();
  return room;
}

const p = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];

describe("a 4 MB room", () => {
  it("checks and applies one update within the Workers CPU budget", async () => {
    const room = bigRoom(4_000_000, 4000);
    const size = Y.encodeStateAsUpdate(room).byteLength;
    expect(size).toBeGreaterThan(3_900_000);
    const structs = [...room.store.clients.values()].reduce((n, l) => n + l.length, 0);
    expect(structs).toBeGreaterThan(1000);

    // The relay's own path: a peer's message, checked, applied, acknowledged.
    const sent: Uint8Array[] = [];
    let closed: number | null = null;
    const relay = createRelayRoom({ name: "big", state: Y.encodeStateAsUpdate(room), authorize: async () => true, maxBytes: 4_400_000 }) as {
      join(s: { send(b: Uint8Array): void; close(c: number): void }): { receive(b: Uint8Array): Promise<void> };
      size: number;
    };
    const peer = relay.join({ send: (b) => sent.push(b), close: (c) => (closed = c) });
    const frame = (type: number, body: number[]) => new Uint8Array([3, 98, 105, 103, type, ...body]); // address "big"
    const varBytes = (u: Uint8Array) => {
      const out: number[] = [];
      let n = u.byteLength;
      while (n > 127) {
        out.push((n & 127) | 128);
        n >>>= 7;
      }
      out.push(n);
      return [...out, ...u];
    };
    await peer.receive(new Uint8Array([3, 98, 105, 103, 2, 0, 1, 120])); // Auth, token "x"
    const writer = new Y.Doc();
    writer.clientID = 555;
    Y.applyUpdate(writer, Y.encodeStateAsUpdate(room));

    const checkMs: number[] = [];
    const messageMs: number[] = [];
    const oldMs: number[] = [];
    const r = rng(42);
    const next = () => {
      const sv = Y.encodeStateVector(writer);
      const a = writer.getArray("e2e");
      a.insert(Math.floor(r() * a.length), [envelope(180, checkMs.length & 255)]);
      return Y.encodeStateAsUpdate(writer, sv);
    };
    for (let i = 0; i < 220; i++) {
      const warm = i < 20; // JIT warm-up, not measured
      const u = next();
      let t = performance.now();
      expect(check(room, u)).toBeNull();
      if (!warm) checkMs.push(performance.now() - t);
      Y.applyUpdate(room, u);
      t = performance.now();
      await peer.receive(frame(0, [2, ...varBytes(u)])); // Sync, update
      if (!warm) messageMs.push(performance.now() - t);
    }
    // The old check, for the record (after, so its 4 MB documents don't add GC pauses to the numbers above).
    for (let i = 0; i < 5; i++) {
      const u = next();
      const t = performance.now();
      expect(fullCheck(room, u)).toBeNull();
      oldMs.push(performance.now() - t);
      Y.applyUpdate(room, u);
      await peer.receive(frame(0, [2, ...varBytes(u)]));
    }
    expect(closed).toBeNull();
    const line = `4 MB room (${size} bytes, ${structs} structs): check p50 ${p(checkMs, 0.5).toFixed(3)} ms, p95 ${p(checkMs, 0.95).toFixed(3)} ms; ` +
      `whole message (check + apply + ack) p50 ${p(messageMs, 0.5).toFixed(3)} ms, p95 ${p(messageMs, 0.95).toFixed(3)} ms, max ${Math.max(...messageMs).toFixed(3)} ms; ` +
      `the old full check p50 ${p(oldMs, 0.5).toFixed(1)} ms`;
    console.log(line);
    expect(p(messageMs, 0.95)).toBeLessThan(WORKERS_FREE_CPU_MS);
    expect(p(checkMs, 0.5)).toBeLessThan(WORKERS_FREE_CPU_MS / 20);
    expect(p(checkMs, 0.95)).toBeLessThan(WORKERS_FREE_CPU_MS / 2);
  });

  it("costs the same in a small room and a 4 MB one (it follows the update, not the room)", () => {
    const small = bigRoom(40_000, 40);
    const big = bigRoom(4_000_000, 4000);
    const time = (room: Y.Doc) => {
      const w = new Y.Doc();
      w.clientID = 999;
      Y.applyUpdate(w, Y.encodeStateAsUpdate(room));
      const ms: number[] = [];
      for (let i = 0; i < 40; i++) {
        const sv = Y.encodeStateVector(w);
        w.getArray("e2e").push([envelope(180, i)]);
        const u = Y.encodeStateAsUpdate(w, sv);
        const t = performance.now();
        check(room, u);
        ms.push(performance.now() - t);
        Y.applyUpdate(room, u);
      }
      return p(ms, 0.5);
    };
    time(small); // warm up
    const s = time(small);
    const b = time(big);
    console.log(`check p50: 40 KB room ${s.toFixed(3)} ms, 4 MB room ${b.toFixed(3)} ms`);
    // A room 100 times larger: well under 100 times slower (the old check was linear).
    expect(b).toBeLessThan(Math.max(s * 10, 0.5));
  });

  it("still refuses an update that would make the room too large", async () => {
    const room = bigRoom(1_000_000, 200);
    let closed: number | null = null;
    const relay = createRelayRoom({ name: "big", state: Y.encodeStateAsUpdate(room), authorize: async () => true, maxBytes: 1_050_000 }) as {
      join(s: { send(b: Uint8Array): void; close(c: number): void }): { receive(b: Uint8Array): Promise<void> };
    };
    const peer = relay.join({ send: () => undefined, close: (c) => (closed = c) });
    await peer.receive(new Uint8Array([3, 98, 105, 103, 2, 0, 1, 120]));
    const w = new Y.Doc();
    Y.applyUpdate(w, Y.encodeStateAsUpdate(room));
    const send = async (ct: number) => {
      const sv = Y.encodeStateVector(w);
      w.getArray("e2e").push([envelope(ct)]);
      const u = Y.encodeStateAsUpdate(w, sv);
      const len: number[] = [];
      let n = u.byteLength;
      while (n > 127) {
        len.push((n & 127) | 128);
        n >>>= 7;
      }
      len.push(n);
      await peer.receive(new Uint8Array([3, 98, 105, 103, 0, 2, ...len, ...u]));
    };
    for (let i = 0; i < 10 && closed === null; i++) await send(4000);
    expect(closed).toBeNull();
    await send(60_000);
    expect(closed).toBe(4413);
  });
});
