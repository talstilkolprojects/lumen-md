/**
 * Plan W6.48 — live canvas over the session's Yjs document
 * (src/canvas/liveCanvas.ts). Two peers, each a real Y.Doc with a fake
 * Excalidraw (an in-memory scene with Excalidraw's imperative API), joined by
 * a fake relay that carries Yjs updates with a delay, as the collab server
 * would. What a real run with the public server adds (the room proof, the
 * network) is in docs collab/live-canvas.
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { bindLiveCanvas, canvasMapName, mergeElements, wins, type LiveApi, type LiveAwareness, type LiveCollaborator, type LiveElement } from "../canvas/liveCanvas";

type El = LiveElement & { x: number; y: number; type: string };

let nonce = 1;
const el = (id: string, version = 1, extra: Partial<El> = {}): El => ({ id, type: "rectangle", x: 0, y: 0, version, versionNonce: (nonce = (nonce * 48271) % 2147483647), index: null, isDeleted: false, ...extra });

/** Excalidraw, faked: a scene and the bits of the API the binding calls. */
class FakeExcalidraw implements LiveApi {
  elements: El[] = [];
  collaborators = new Map<string, LiveCollaborator>();
  dragging: string[] = [];
  updates = 0;
  captured: unknown[] = [];
  onChange: ((els: readonly El[]) => void) | null = null;
  getSceneElements() {
    return this.elements;
  }
  getAppState() {
    return { selectedElementsAreBeingDragged: this.dragging.length > 0, selectedElementIds: Object.fromEntries(this.dragging.map((id) => [id, true as const])) };
  }
  updateScene(s: { elements?: readonly LiveElement[]; collaborators?: Map<string, LiveCollaborator>; captureUpdate?: unknown }) {
    this.updates++;
    if (s.elements) {
      this.elements = [...(s.elements as El[])];
      this.captured.push(s.captureUpdate);
      // Excalidraw calls onChange after updateScene too.
      this.onChange?.(this.elements);
    }
    if (s.collaborators) this.collaborators = s.collaborators;
  }
  /** A local edit: Excalidraw bumps version and versionNonce, then calls onChange. */
  edit(id: string, patch: Partial<El>) {
    this.elements = this.elements.map((e) => (e.id === id ? { ...e, ...patch, version: e.version + 1, versionNonce: (nonce = (nonce * 48271) % 2147483647) } : e));
    this.onChange?.(this.elements);
  }
  add(e: El) {
    this.elements = [...this.elements, e];
    this.onChange?.(this.elements);
  }
}

/** A relay, faked: each doc's updates reach the other after `delayMs`, in order. */
function relay(a: Y.Doc, b: Y.Doc, delayMs = 0) {
  const pending = new Set<Promise<void>>();
  const wire = (from: Y.Doc, to: Y.Doc) =>
    from.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === "relay") return;
      const p = new Promise<void>((r) => setTimeout(r, delayMs)).then(() => Y.applyUpdate(to, u, "relay"));
      pending.add(p);
      void p.finally(() => pending.delete(p));
    });
  wire(a, b);
  wire(b, a);
  return { settle: async () => { while (pending.size) await Promise.all([...pending]); } };
}

/** Awareness, faked: two peers sharing one states map. */
function awarenessPair(): [LiveAwareness, LiveAwareness] {
  const states = new Map<number, Record<string, unknown>>();
  const listeners = new Set<() => void>();
  const make = (clientID: number, name: string, color: string): LiveAwareness => {
    states.set(clientID, { user: { name, color } });
    return {
      clientID,
      getStates: () => states,
      setLocalStateField(field, value) {
        states.set(clientID, { ...(states.get(clientID) ?? {}), [field]: value });
        for (const l of [...listeners]) l();
      },
      on: (_e, fn) => void listeners.add(fn),
      off: (_e, fn) => void listeners.delete(fn),
    };
  };
  return [make(1, "טל", "#e03131"), make(2, "Dana", "#1971c2")];
}

function peer(doc: Y.Doc, ex: FakeExcalidraw, awareness?: LiveAwareness, onRemote?: (ids: string[]) => void) {
  const live = bindLiveCanvas(doc, "תוכנית", ex, { captureNever: "NEVER", awareness, onRemote });
  ex.onChange = (els) => void live.push(els);
  return live;
}

describe("live canvas: the merge rule (Excalidraw's reconcile)", () => {
  it("the higher version wins; on a tie, the lower versionNonce", () => {
    expect(wins({ id: "a", version: 3, versionNonce: 9 }, { id: "a", version: 2, versionNonce: 1 })).toBe(true);
    expect(wins({ id: "a", version: 2, versionNonce: 1 }, { id: "a", version: 2, versionNonce: 9 })).toBe(true);
    expect(wins({ id: "a", version: 2, versionNonce: 9 }, { id: "a", version: 2, versionNonce: 1 })).toBe(false);
  });

  it("merges by id, keeps fractional-index order, and returns null when nothing changes", () => {
    const local = [el("a", 1, { index: "a1" }), el("b", 1, { index: "a2" })];
    expect(mergeElements(local, [local[0]])).toBeNull();
    const merged = mergeElements(local, [el("c", 1, { index: "a0" }), { ...local[1], version: 5 }]);
    expect(merged?.map((e) => e.id)).toEqual(["c", "a", "b"]);
    expect(merged?.find((e) => e.id === "b")?.version).toBe(5);
  });
});

describe("live canvas: two peers through a relay", () => {
  it("a peer that joins gets the scene; edits on both sides converge", async () => {
    const [da, db] = [new Y.Doc(), new Y.Doc()];
    const net = relay(da, db, 5);
    const [a, b] = [new FakeExcalidraw(), new FakeExcalidraw()];
    a.elements = [el("r1", 1, { index: "a0" }), el("r2", 1, { index: "a1" })];
    peer(da, a);
    await net.settle();
    peer(db, b);
    await net.settle();
    expect(b.elements.map((e) => e.id)).toEqual(["r1", "r2"]);

    a.edit("r1", { x: 100 });
    b.edit("r2", { y: 50 });
    b.add(el("t1", 1, { type: "text", index: "a2", text: "שלום" }));
    await net.settle();
    for (const ex of [a, b]) {
      expect(ex.elements.map((e) => [e.id, e.x, e.y])).toEqual([["r1", 100, 0], ["r2", 0, 50], ["t1", 0, 0]]);
    }
    expect(da.getMap(canvasMapName("תוכנית")).size).toBe(3);
    // Remote changes are drawn without entering the local undo stack.
    expect(b.captured.every((c) => c === "NEVER")).toBe(true);
  });

  it("the same element edited on both sides at once: both end on the same winner", async () => {
    const [da, db] = [new Y.Doc(), new Y.Doc()];
    const net = relay(da, db, 3);
    const [a, b] = [new FakeExcalidraw(), new FakeExcalidraw()];
    a.elements = [el("r1")];
    peer(da, a);
    await net.settle();
    peer(db, b);
    await net.settle();
    a.edit("r1", { x: 10 });
    b.edit("r1", { x: 20 });
    b.edit("r1", { x: 30 }); // b is one version ahead
    await net.settle();
    expect(a.elements[0].x).toBe(30);
    expect(b.elements[0].x).toBe(30);

    a.edit("r1", { x: 1 }); // a: version 4
    b.edit("r1", { x: 2 }); // b: version 4 too: the lower nonce wins on both
    await net.settle();
    expect(a.elements[0].x).toBe(b.elements[0].x);
    expect(a.elements[0].versionNonce).toBe(b.elements[0].versionNonce);
  });

  it("a delete is a tombstone that reaches the other side", async () => {
    const [da, db] = [new Y.Doc(), new Y.Doc()];
    const net = relay(da, db);
    const [a, b] = [new FakeExcalidraw(), new FakeExcalidraw()];
    a.elements = [el("r1"), el("r2")];
    peer(da, a);
    await net.settle();
    peer(db, b);
    await net.settle();
    a.edit("r2", { isDeleted: true });
    await net.settle();
    expect(b.elements.find((e) => e.id === "r2")?.isDeleted).toBe(true);
  });

  it("what someone is dragging stays theirs until they let go", async () => {
    const [da, db] = [new Y.Doc(), new Y.Doc()];
    const net = relay(da, db);
    const [a, b] = [new FakeExcalidraw(), new FakeExcalidraw()];
    a.elements = [el("r1")];
    peer(da, a);
    await net.settle();
    peer(db, b);
    await net.settle();
    b.dragging = ["r1"];
    b.edit("r1", { x: 5 });
    a.edit("r1", { x: 7 });
    a.edit("r1", { x: 8 }); // a's is newer, but b is still dragging
    await net.settle();
    expect(b.elements[0].x).toBe(5);
    b.dragging = [];
    b.edit("r1", { x: 6 }); // b lets go: its version 3 meets a's 3
    await net.settle();
    expect(a.elements[0].x).toBe(b.elements[0].x);
  });

  it("drawing a remote change writes nothing back (no echo)", async () => {
    const [da, db] = [new Y.Doc(), new Y.Doc()];
    const net = relay(da, db);
    const [a, b] = [new FakeExcalidraw(), new FakeExcalidraw()];
    a.elements = [el("r1")];
    peer(da, a);
    await net.settle();
    const lb = peer(db, b);
    await net.settle();
    let sent = 0;
    db.on("update", (_u: Uint8Array, origin: unknown) => {
      if (origin !== "relay") sent++;
    });
    a.edit("r1", { x: 3 });
    await net.settle();
    expect(b.elements[0].x).toBe(3);
    expect(sent).toBe(0);
    expect(lb.push(b.elements)).toBe(0);
  });

  it("pointers become Excalidraw collaborators on the same canvas, and go when the canvas closes", () => {
    const [awA, awB] = awarenessPair();
    const [a, b] = [new FakeExcalidraw(), new FakeExcalidraw()];
    const doc = new Y.Doc();
    const la = peer(doc, a, awA);
    peer(doc, b, awB);
    la.pointer({ pointer: { x: 12, y: 34 }, button: "down" });
    const c = b.collaborators.get("1");
    expect(c).toMatchObject({ username: "טל", pointer: { x: 12, y: 34, tool: "pointer" }, button: "down", color: { background: "#e03131" } });
    expect(a.collaborators.has("1")).toBe(false); // not yourself
    la.destroy();
    expect(b.collaborators.size).toBe(0);
  });

  it("random concurrent edits on two peers, with uneven delays: both end on the same scene", async () => {
    const [da, db] = [new Y.Doc(), new Y.Doc()];
    const net = relay(da, db, 4);
    const [a, b] = [new FakeExcalidraw(), new FakeExcalidraw()];
    a.elements = Array.from({ length: 8 }, (_, i) => el(`e${i}`, 1, { index: `a${i}` }));
    peer(da, a);
    await net.settle();
    peer(db, b);
    await net.settle();
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 16807) % 2147483647) % n;
    for (let round = 0; round < 40; round++) {
      for (let k = 0; k < 3; k++) {
        const ex = rnd(2) ? a : b;
        const id = `e${rnd(8)}`;
        if (rnd(10) === 0) ex.edit(id, { isDeleted: true });
        else ex.edit(id, { x: rnd(1000), y: rnd(1000) });
      }
      if (rnd(3) === 0) await net.settle();
    }
    await net.settle();
    const view = (ex: FakeExcalidraw) => ex.elements.map((e) => `${e.id}@${e.version}:${e.versionNonce}:${e.x},${e.y}:${e.isDeleted}`);
    expect(view(a)).toEqual(view(b));
  });

  it("5,000 shapes: the scene reaches the second peer, and one edit is drawn there within 150 ms at p95 (20 ms relay)", async () => {
    const [da, db] = [new Y.Doc(), new Y.Doc()];
    const net = relay(da, db, 20);
    const [a, b] = [new FakeExcalidraw(), new FakeExcalidraw()];
    a.elements = Array.from({ length: 5000 }, (_, i) => el(`s${i}`, 1, { index: `a${String(i).padStart(5, "0")}`, x: (i % 100) * 20, y: Math.floor(i / 100) * 20 }));
    const sentAt = new Map<string, number>();
    const lat: number[] = [];
    peer(da, a);
    const lb = peer(db, b, undefined, (ids) => {
      for (const id of ids) {
        const t0 = sentAt.get(id);
        if (t0 !== undefined) lat.push(performance.now() - t0);
      }
    });
    await net.settle();
    expect(b.elements).toHaveLength(5000);

    for (let i = 0; i < 60; i++) {
      const id = `s${(i * 83) % 5000}`;
      sentAt.set(id, performance.now());
      a.edit(id, { x: i });
      await net.settle();
    }
    lb.destroy();
    lat.sort((x, y) => x - y);
    const p95 = lat[Math.floor(lat.length * 0.95) - 1];
    expect(lat.length).toBe(60);
    expect(p95).toBeLessThan(150);
  });
});
