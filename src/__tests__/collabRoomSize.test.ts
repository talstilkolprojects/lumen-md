/**
 * The relay's room size, kept per update (sync-server/collab/roomSize.mjs),
 * is the reviewed accounting's number exactly: after every one of thousands
 * of generated updates it equals `Y.encodeStateAsUpdate(doc).byteLength`,
 * which the relay used to compute on every update. The updates come from
 * several writers and cover what changes a room's encoding: appends, inserts
 * that split another writer's item, deletions (gc'd and merged, or kept
 * with gc off), text with formatting, map keys overwritten, nested types
 * deleted with their children, the same update twice, and updates that
 * arrive before the ones they need (pending).
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
// @ts-expect-error -- plain ESM server module, no types
import { createRoomMeter } from "../../sync-server/collab/roomSize.mjs";
// @ts-expect-error -- plain ESM server module, no types
import { createRelayRoom } from "../../sync-server/collab/relay.mjs";

type Meter = { measure(): number };
const meterOf = createRoomMeter as (doc: Y.Doc) => Meter;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return s / 2 ** 32;
  };
}

const envelope = (n: number, fill: number) => ({ v: 1, iv: new Uint8Array(12).fill(fill), ct: new Uint8Array(16 + n).fill(fill) });

/** One random change by `d` (some do nothing when there is nothing to delete). */
function change(d: Y.Doc, r: () => number, step: number): void {
  const a = d.getArray<unknown>("e2e");
  const t = d.getText("t");
  const m = d.getMap<unknown>("m");
  const k = Math.floor(r() * 12);
  if (k <= 2) a.insert(Math.floor(r() * (a.length + 1)), [envelope(Math.floor(r() * 300), step & 255)]);
  else if (k === 3) a.push([step, `s${step}`, null, true, 1.5, [1, "x"], { n: step }]);
  else if (k === 4 && a.length) {
    const at = Math.floor(r() * a.length);
    a.delete(at, Math.min(a.length - at, 1 + Math.floor(r() * 3)));
  } else if (k === 5) t.insert(Math.floor(r() * (t.length + 1)), r() < 0.5 ? "שלום " : "hello ");
  else if (k === 6 && t.length > 2) t.format(0, Math.floor(r() * t.length), { bold: r() < 0.5 ? true : null });
  else if (k === 7 && t.length) {
    const at = Math.floor(r() * t.length);
    t.delete(at, Math.min(t.length - at, 1 + Math.floor(r() * 4)));
  } else if (k === 8) m.set(`k${Math.floor(r() * 4)}`, r() < 0.5 ? step : new Uint8Array([step & 255, 1, 2]));
  else if (k === 9) {
    const inner = new Y.Map<unknown>();
    inner.set("a", step);
    const list = new Y.Array<unknown>();
    list.push([1, 2, 3]);
    inner.set("list", list);
    a.insert(Math.floor(r() * (a.length + 1)), [inner]);
  } else if (k === 10) {
    // A nested type deleted with what is inside it (its children turn into GC structs).
    const i = a.toArray().findIndex((x: unknown) => x instanceof Y.AbstractType);
    if (i >= 0) a.delete(i, 1);
  } else m.delete(`k${Math.floor(r() * 4)}`);
}

function run(seed: number, gc: boolean, rounds: number) {
  const r = rng(seed);
  const room = new Y.Doc({ gc });
  const meter = meterOf(room);
  const writers = [1, 2, 3, 4].map((id) => {
    const d = new Y.Doc({ gc });
    d.clientID = id * 1000 + seed;
    return d;
  });
  const held: Uint8Array[] = [];
  let checked = 0;
  const expectExact = () => {
    expect(meter.measure()).toBe(Y.encodeStateAsUpdate(room).byteLength);
    checked++;
  };
  for (let i = 0; i < rounds; i++) {
    const d = writers[Math.floor(r() * writers.length)];
    Y.applyUpdate(d, Y.encodeStateAsUpdate(room, Y.encodeStateVector(d)));
    const sv = Y.encodeStateVector(d);
    change(d, r, i);
    const u = Y.encodeStateAsUpdate(d, sv);
    const p = r();
    if (p < 0.08) {
      held.push(u); // arrives later, after updates that need it (pending until then)
      continue;
    }
    Y.applyUpdate(room, u);
    expectExact();
    if (p < 0.14) {
      Y.applyUpdate(room, u); // the same update again: nothing changes
      expectExact();
    }
    if (held.length && r() < 0.3) {
      Y.applyUpdate(room, held.shift()!);
      expectExact();
    }
  }
  for (const u of held) {
    Y.applyUpdate(room, u);
    expectExact();
  }
  return checked;
}

describe("the relay's room size (roomSize.mjs)", () => {
  it("equals the full encoding's length after every update, gc on", () => {
    let n = 0;
    for (const seed of [1, 2, 3, 4, 5]) n += run(seed, true, 500);
    expect(n).toBeGreaterThan(2000);
  });

  it("equals the full encoding's length after every update, gc off", () => {
    let n = 0;
    for (const seed of [11, 12]) n += run(seed, false, 500);
    expect(n).toBeGreaterThan(800);
  });

  it("follows a deleted nested type into the writers of what was inside it", () => {
    // B's value inside A's map is overwritten by C, then D deletes the map: the gc turns B's
    // deleted item into a GC struct, though B is in no deletion of that transaction.
    const room = new Y.Doc();
    const meter = meterOf(room);
    const docs = [1, 2, 3, 4].map((id) => {
      const d = new Y.Doc();
      d.clientID = id;
      return d;
    });
    const step = (d: Y.Doc, f: (d: Y.Doc) => void) => {
      Y.applyUpdate(d, Y.encodeStateAsUpdate(room, Y.encodeStateVector(d)));
      const sv = Y.encodeStateVector(d);
      f(d);
      Y.applyUpdate(room, Y.encodeStateAsUpdate(d, sv));
      expect(meter.measure()).toBe(Y.encodeStateAsUpdate(room).byteLength);
    };
    const [a, b, c, d] = docs;
    step(a, (x) => x.getArray("e2e").push([new Y.Map()]));
    step(b, (x) => (x.getArray("e2e").get(0) as Y.Map<unknown>).set("k", "from b, long enough to matter"));
    step(c, (x) => (x.getArray("e2e").get(0) as Y.Map<unknown>).set("k", 1));
    step(d, (x) => x.getArray("e2e").delete(0, 1));
  });

  it("counts a room loaded from storage, and a measure with nothing new is the same number", () => {
    const src = new Y.Doc();
    src.clientID = 9;
    src.getArray("e2e").push([envelope(50_000, 1), envelope(10, 2)]);
    src.getArray("e2e").delete(1, 1);
    const room = new Y.Doc();
    Y.applyUpdate(room, Y.encodeStateAsUpdate(src));
    const meter = meterOf(room);
    const exact = Y.encodeStateAsUpdate(room).byteLength;
    expect(meter.measure()).toBe(exact);
    expect(meter.measure()).toBe(exact);
  });

  it("keeps the relay room's size exact message by message", async () => {
    const relay = createRelayRoom({ name: "r", authorize: async () => true }) as {
      doc: Y.Doc;
      size: number;
      join(s: { send(b: Uint8Array): void; close(c: number): void }): { receive(b: Uint8Array): Promise<void> };
    };
    let closed: number | null = null;
    const peer = relay.join({ send: () => undefined, close: (c) => (closed = c) });
    await peer.receive(new Uint8Array([1, 114, 2, 0, 1, 120])); // Auth, token "x", address "r"
    const w = new Y.Doc();
    w.clientID = 77;
    const r = rng(7);
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
    for (let i = 0; i < 200; i++) {
      const sv = Y.encodeStateVector(w);
      const a = w.getArray("e2e");
      if (a.length > 3 && r() < 0.3) a.delete(Math.floor(r() * (a.length - 1)), 1);
      else a.insert(Math.floor(r() * (a.length + 1)), [envelope(Math.floor(r() * 200), i & 255)]);
      await peer.receive(new Uint8Array([1, 114, 0, 2, ...varBytes(Y.encodeStateAsUpdate(w, sv))])); // Sync, update
      expect(relay.size).toBe(Y.encodeStateAsUpdate(relay.doc).byteLength);
    }
    expect(closed).toBeNull();
  });
});
