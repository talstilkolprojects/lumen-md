/**
 * Plan W4.8: the public live-share server never sees a note.
 *
 *  - sync-server/collab/relay.mjs: the check that a room holds nothing but
 *    the encrypted envelopes of src/collab/e2e.ts, and the Hocuspocus
 *    protocol for one room, driven by the real @hocuspocus/provider and the
 *    app's real E2E transport;
 *  - edge-workers/collab/worker.mjs: the Cloudflare Worker and its Durable
 *    Objects, in a small simulation of their runtime (hibernating sockets,
 *    attachments, storage, alarms): two people edit together, the storage
 *    holds no text, a plaintext room is refused, retention deletes;
 *  - sync-server/collab-server.mjs: COLLAB_E2EE_ONLY and the retention sweep.
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error -- ws ships no types (no @types/ws in the lockfile)
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { wireE2E } from "../collab/e2e";
import { requestRoomToken } from "../collab/roomToken";
import { committedRoomName } from "../collab/roomProof";
import { roomSocketUrl } from "../collab/persistentProvider";
// @ts-expect-error -- plain ESM server module, no types
import { checkE2eeUpdate, createRelayRoom, updateInMessage } from "../../sync-server/collab/relay.mjs";
// @ts-expect-error -- plain ESM server module, no types
import worker, { CollabRoom, Quota, Signal } from "../../edge-workers/collab/worker.mjs";
// @ts-expect-error -- plain ESM server module, no types
import { createCollabServer } from "../../sync-server/collab-server.mjs";
// @ts-expect-error -- plain ESM server module, no types
import { openStore } from "../../sync-server/collab/sqliteStore.mjs";

type Check = (doc: Y.Doc, update: Uint8Array) => string | null;

/** Integration tests wait on real sockets: 30 s each, not vitest's 5 s. */
/** The parts of a `ws` server socket these tests use. */
interface NodeSocket {
  readyState: number;
  OPEN: number;
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  on(event: string, fn: (...args: never[]) => void): void;
}
interface NodeServer {
  on(event: "connection", fn: (ws: NodeSocket, req: { url?: string }) => void): void;
  once(event: string, fn: () => void): void;
  close(fn: () => void): void;
  address(): { port: number };
}
const listen = async (): Promise<NodeServer> => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }) as NodeServer;
  await new Promise<void>((r) => wss.once("listening", r));
  cleanups.push(() => new Promise<void>((r) => wss.close(r)));
  return wss;
};
const check = checkE2eeUpdate as Check;

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

const envelope = () => ({ v: 2, iv: new Uint8Array(12).fill(1), ct: new Uint8Array(40).fill(2) });
const containsText = (bytes: Uint8Array, text: string) =>
  Buffer.from(bytes).toString("utf8").includes(text) || Buffer.from(bytes).toString("latin1").includes(text);

describe("checkE2eeUpdate", () => {
  const updateOf = (fill: (d: Y.Doc) => void, base?: Y.Doc) => {
    const d = new Y.Doc();
    if (base) Y.applyUpdate(d, Y.encodeStateAsUpdate(base));
    const sv = Y.encodeStateVector(d);
    fill(d);
    return Y.encodeStateAsUpdate(d, sv);
  };

  it("lets envelopes in", () => {
    expect(check(new Y.Doc(), updateOf((d) => d.getArray("e2e").push([envelope(), { ...envelope(), s: 1 }])))).toBeNull();
  });

  it("refuses any text, map or array outside the envelopes", () => {
    expect(check(new Y.Doc(), updateOf((d) => d.getText("codemirror").insert(0, "hello")))).toBe("plaintext");
    expect(check(new Y.Doc(), updateOf((d) => d.getMap("meta").set("title", "x")))).toBe("plaintext");
    expect(check(new Y.Doc(), updateOf((d) => d.getArray("e2e").push(["a note"])))).toBe("not-envelope");
    expect(check(new Y.Doc(), updateOf((d) => d.getArray("e2e").push([{ ...envelope(), iv: new Uint8Array(8) }])))).toBe("not-envelope");
    expect(check(new Y.Doc(), updateOf((d) => d.getArray("e2e").push([{ ...envelope(), text: "leak" }])))).toBe("not-envelope");
    expect(check(new Y.Doc(), new Uint8Array([1, 2, 3, 250]))).toBe("malformed");
  });

  it("checks an update against what the room already has, without changing it", () => {
    const room = new Y.Doc();
    Y.applyUpdate(room, updateOf((d) => d.getArray("e2e").push([envelope()])));
    const before = Y.encodeStateAsUpdate(room);
    expect(check(room, updateOf((d) => d.getArray("e2e").delete(0, 1), room))).toBeNull();
    expect(check(room, updateOf((d) => d.getText("t").insert(0, "x"), room))).toBe("plaintext");
    expect(Y.encodeStateAsUpdate(room)).toEqual(before);
  });

  it("finds the Yjs update inside a Hocuspocus message", () => {
    const u = updateOf((d) => d.getArray("e2e").push([envelope()]));
    // [address "r"][Sync 0][update 2][bytes]
    const msg = new Uint8Array([1, 114, 0, 2, u.byteLength, ...u]);
    expect(updateInMessage(msg)).toEqual(u);
    expect(updateInMessage(new Uint8Array([1, 114, 1, 0]))).toBeNull();
  });
});

interface Client {
  plain: Y.Doc;
  provider: HocuspocusProvider;
  synced: () => boolean;
}

function connect(url: string, room: string, password: string | null, token: () => Promise<string>): Client {
  const plain = new Y.Doc();
  const transport = password ? new Y.Doc() : plain;
  const channel = password ? wireE2E(plain, transport, { password, room }) : null;
  let synced = false;
  const provider = new HocuspocusProvider({ url: roomSocketUrl(url, room), name: room, document: transport, token });
  provider.on("synced", () => (synced = true));
  cleanups.push(() => {
    provider.destroy();
    channel?.destroy();
  });
  return { plain, provider, synced: () => synced };
}

interface Relay {
  join(socket: { send(b: Uint8Array): void; close(code: number, reason: string): void }): { receive(b: Uint8Array): Promise<void>; leave(): void };
  state(): Uint8Array;
  peerCount: number;
}

describe("the relay room, with the real provider and the app's encryption", () => {
  async function serve(): Promise<{ url: string; rooms: Map<string, Relay>; closes: number[] }> {
    const rooms = new Map<string, Relay>();
    const closes: number[] = [];
    const wss = await listen();
    wss.on("connection", (ws, req) => {
      const room = new URL(req.url ?? "/", "http://x").searchParams.get("room") ?? "";
      let r = rooms.get(room);
      if (!r) {
        r = createRelayRoom({ name: room, authorize: async (t: string) => t === "ok" }) as Relay;
        rooms.set(room, r);
      }
      const peer = r.join({
        send: (b) => ws.readyState === ws.OPEN && ws.send(b),
        close: (code, reason) => {
          closes.push(code);
          ws.close(code, reason);
        },
      });
      ws.on("message", (d: Buffer) => void peer.receive(new Uint8Array(d)));
      ws.on("close", () => peer.leave());
    });
    return { url: `ws://127.0.0.1:${wss.address().port}`, rooms, closes };
  }

  it("two people edit an encrypted room together; the server holds only envelopes", async () => {
    const { url, rooms, closes } = await serve();
    const room = `r${Date.now().toString(36)}`;
    const a = connect(url, room, "correct horse", async () => "ok");
    const b = connect(url, room, "correct horse", async () => "ok");
    expect(await until(() => a.synced() && b.synced())).toBe(true);
    a.plain.getText("codemirror").insert(0, "שלום, a secret note");
    expect(await until(() => b.plain.getText("codemirror").toString() === "שלום, a secret note")).toBe(true);
    b.plain.getText("codemirror").insert(0, "B: ");
    expect(await until(() => a.plain.getText("codemirror").toString().startsWith("B: "))).toBe(true);
    const stored = rooms.get(room)!.state();
    expect(containsText(stored, "secret note") || containsText(stored, "שלום")).toBe(false);
    expect(check(new Y.Doc(), stored)).toBeNull();
    expect(closes).toEqual([]);

    // Someone joining later gets everything from the relay alone.
    a.provider.destroy();
    b.provider.destroy();
    const c = connect(url, room, "correct horse", async () => "ok");
    expect(await until(() => c.plain.getText("codemirror").toString() === "B: שלום, a secret note")).toBe(true);
  }, 30_000);

  it("refuses a plaintext room (4403) and keeps nothing of it; a wrong token is refused", async () => {
    const { url, rooms, closes } = await serve();
    const room = `p${Date.now().toString(36)}`;
    const p = connect(url, room, null, async () => "ok");
    expect(await until(() => p.synced())).toBe(true);
    p.plain.getText("codemirror").insert(0, "plain words");
    expect(await until(() => closes.includes(4403))).toBe(true);
    expect(containsText(rooms.get(room)!.state(), "plain words")).toBe(false);

    let denied = false;
    const w = new HocuspocusProvider({ url: roomSocketUrl(url, "w1"), name: "w1", document: new Y.Doc(), token: async () => "bad" });
    w.on("authenticationFailed", () => (denied = true));
    cleanups.push(() => w.destroy());
    expect(await until(() => denied)).toBe(true);
  }, 30_000);
});

/* ─── The Cloudflare Worker, in a small simulation of its runtime ─────── */

type Listener = (ev: { data: unknown }) => void;

/** The server half of a WebSocketPair, bridged to a real Node socket. */
class SimSocket {
  listeners: Listener[] = [];
  attachment: unknown = null;
  accepted = false;
  closed: number | null = null;
  peer: NodeSocket | null = null;
  owner: SimObject | null = null;
  accept() {
    this.accepted = true;
  }
  addEventListener(_type: string, fn: Listener) {
    this.listeners.push(fn);
  }
  send(data: string | Uint8Array) {
    if (this.peer && this.peer.readyState === this.peer.OPEN) this.peer.send(data);
  }
  close(code = 1000, reason = "") {
    this.closed = code;
    this.peer?.close(code, reason);
  }
  serializeAttachment(a: unknown) {
    this.attachment = structuredClone(a);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
}

interface DurableClass {
  new (state: SimState, env: SimEnv): {
    fetch(req: unknown): Promise<SimResponse>;
    webSocketMessage(ws: SimSocket, m: string | ArrayBuffer): Promise<void>;
    webSocketClose(ws: SimSocket): Promise<void>;
    alarm?(): Promise<void>;
  };
}
interface SimState {
  storage: {
    get(k: string | string[]): Promise<unknown>;
    put(o: Record<string, unknown>): Promise<void>;
    delete(k: string | string[]): Promise<void>;
    deleteAll(): Promise<void>;
    setAlarm(t: number): Promise<void>;
  };
  acceptWebSocket(ws: SimSocket): void;
  getWebSockets(): SimSocket[];
}
interface SimObject {
  state: SimState;
  data: Map<string, unknown>;
  alarm: number | null;
  sockets: Set<SimSocket>;
  inst: InstanceType<DurableClass>;
}
interface SimEnv {
  [k: string]: unknown;
}
interface SimResponse {
  status: number;
  body: string | null;
  webSocket?: { server: SimSocket };
}

function namespace(Cls: DurableClass, env: SimEnv) {
  const objs = new Map<string, SimObject>();
  return {
    objs,
    idFromName: (n: string) => n,
    get(id: string) {
      let o = objs.get(id);
      if (!o) {
        const data = new Map<string, unknown>();
        const sockets = new Set<SimSocket>();
        const holder: { o?: SimObject } = {};
        const state: SimState = {
          storage: {
            async get(k) {
              if (Array.isArray(k)) return new Map(k.filter((x) => data.has(x)).map((x) => [x, data.get(x)]));
              return data.get(k);
            },
            async put(obj) {
              for (const [k, v] of Object.entries(obj)) data.set(k, v instanceof Uint8Array ? v.slice() : v);
            },
            async delete(k) {
              for (const x of ([] as string[]).concat(k)) data.delete(x);
            },
            async deleteAll() {
              data.clear();
            },
            async setAlarm(t) {
              holder.o!.alarm = t;
            },
          },
          acceptWebSocket(ws) {
            sockets.add(ws);
            ws.owner = holder.o!;
          },
          getWebSockets: () => [...sockets].filter((s) => s.closed === null),
        };
        o = { state, data, alarm: null, sockets, inst: new Cls(state, env) };
        holder.o = o;
        objs.set(id, o);
      }
      const obj = o;
      return { fetch: (req: unknown) => obj.inst.fetch(req) };
    },
    /** The object is evicted from memory; its sockets and storage stay. */
    hibernate(id: string) {
      const o = objs.get(id)!;
      o.inst = new Cls(o.state, env);
    },
  };
}

describe("edge-workers/collab: the public server on Cloudflare (simulated runtime)", () => {
  async function serveWorker() {
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { Response: g.Response, WebSocketPair: g.WebSocketPair };
    g.Response = class {
      status: number;
      body: string | null;
      webSocket?: { server: SimSocket };
      constructor(body: string | null, init: { status?: number; webSocket?: { server: SimSocket } } = {}) {
        this.body = body;
        this.status = init.status ?? 200;
        this.webSocket = init.webSocket;
      }
    };
    g.WebSocketPair = class {
      0: { server: SimSocket };
      1: SimSocket;
      constructor() {
        const s = new SimSocket();
        this[0] = { server: s };
        this[1] = s;
      }
    };
    cleanups.push(() => Object.assign(g, saved));
    const env: SimEnv = { COLLAB_TOKEN_SECRET: "s".repeat(40), RETENTION_DAYS: "90" };
    const rooms = namespace(CollabRoom as DurableClass, env);
    env.ROOMS = rooms;
    env.SIGNAL = namespace(Signal as DurableClass, env);
    const fetchWorker = (worker as { fetch(req: unknown, env: SimEnv): Promise<SimResponse> }).fetch;

    const wss = await listen();
    wss.on("connection", async (ws, req) => {
      const request = { url: `https://collab.test${req.url}`, headers: { get: (h: string) => (h.toLowerCase() === "upgrade" ? "websocket" : null) } };
      const queue: Array<string | Uint8Array> = [];
      let srv: SimSocket | null = null;
      const deliver = (m: string | Uint8Array) => {
        const s = srv!;
        if (s.accepted) for (const f of s.listeners) f({ data: m });
        else void s.owner!.inst.webSocketMessage(s, typeof m === "string" ? m : m.slice().buffer);
      };
      ws.on("message", (d: Buffer, binary: boolean) => {
        const m = binary ? new Uint8Array(d) : d.toString();
        if (srv) deliver(m);
        else queue.push(m);
      });
      const res = await fetchWorker(request, env);
      if (res.status !== 101 || !res.webSocket) return ws.close(1011, String(res.status));
      srv = res.webSocket.server;
      srv.peer = ws;
      const s = srv;
      ws.on("close", () => {
        s.closed ??= 1000;
        if (!s.accepted) void s.owner!.inst.webSocketClose(s);
      });
      for (const m of queue.splice(0)) deliver(m);
    });
    return { url: `ws://127.0.0.1:${wss.address().port}`, rooms, fetchWorker, env };
  }

  it("two people edit, the object hibernates, the room is stored as ciphertext and deleted after 90 days", async () => {
    const { url, rooms } = await serveWorker();
    const room = `room-${Date.now().toString(36)}`;
    const token = async () => (await requestRoomToken(url, room, null, { password: "pw" })).token;
    const a = connect(url, room, "pw", token);
    const b = connect(url, room, "pw", token);
    expect(await until(() => a.synced() && b.synced())).toBe(true);
    a.plain.getText("t").insert(0, "סוד: the plan");
    expect(await until(() => b.plain.getText("t").toString() === "סוד: the plan")).toBe(true);
    rooms.hibernate(room);
    b.plain.getText("t").insert(0, "after sleep. ");
    expect(await until(() => a.plain.getText("t").toString() === "after sleep. סוד: the plan")).toBe(true);
    a.provider.destroy();
    b.provider.destroy();
    const o = rooms.objs.get(room)!;
    expect(await until(() => o.data.has("s0") && o.state.getWebSockets().length === 0)).toBe(true);
    const stored = new Uint8Array(Buffer.concat([...o.data.entries()].filter(([k]) => /^s\d+$/.test(k)).map(([, v]) => Buffer.from(v as Uint8Array))));
    for (const t of ["the plan", "סוד", "after sleep"]) expect(containsText(stored, t)).toBe(false);
    expect(Math.abs((o.alarm ?? 0) - (Date.now() + 90 * 864e5))).toBeLessThan(60_000);

    rooms.hibernate(room);
    const c = connect(url, room, "pw", token);
    expect(await until(() => c.plain.getText("t").toString() === "after sleep. סוד: the plan")).toBe(true);
    c.provider.destroy();
    expect(await until(() => o.state.getWebSockets().length === 0)).toBe(true);

    await o.state.storage.put({ lastWrite: Date.now() - 91 * 864e5 });
    await o.inst.alarm!();
    expect(o.data.size).toBe(0);
  }, 30_000);

  it("only an authenticated change writes storage: no token, a wrong token, or a reader write nothing (review 12.11)", async () => {
    const { url, rooms } = await serveWorker();
    const room = `quiet-${Date.now().toString(36)}`;
    // No valid token: denied, closed, and nothing stored, no alarm armed.
    const intruder = connect(url, room, "pw", async () => "not-a-token");
    expect(await until(() => rooms.objs.has(room))).toBe(true);
    const o = rooms.objs.get(room)!;
    intruder.plain.getText("t").insert(0, "x");
    intruder.provider.destroy();
    expect(await until(() => o.state.getWebSockets().length === 0)).toBe(true);
    expect(o.data.size).toBe(0);
    expect(o.alarm).toBeNull();

    // A real change is stored; then a reader comes and goes: the retention clock doesn't move.
    const token = async () => (await requestRoomToken(url, room, null, { password: "pw" })).token;
    const a = connect(url, room, "pw", token);
    expect(await until(() => a.synced())).toBe(true);
    a.plain.getText("t").insert(0, "kept");
    a.provider.destroy();
    expect(await until(() => o.data.has("lastWrite") && o.state.getWebSockets().length === 0)).toBe(true);
    const lastWrite = o.data.get("lastWrite");
    const alarm = o.alarm;
    const reader = connect(url, room, "pw", token);
    expect(await until(() => reader.synced() && reader.plain.getText("t").toString() === "kept")).toBe(true);
    reader.provider.destroy();
    expect(await until(() => o.state.getWebSockets().length === 0)).toBe(true);
    expect(o.data.get("lastWrite")).toBe(lastWrite);
    expect(o.alarm).toBe(alarm);
  }, 30_000);

  it("a committed name lets in only its own proof, even first; new rooms stop at the address limit (review 4, review 2)", async () => {
    const { url, rooms, env } = await serveWorker();
    const qs = new Map<string, unknown>();
    const qstate = {
      storage: {
        list: async () => new Map(qs),
        put: async (o: Record<string, unknown>) => void Object.entries(o).forEach(([k, v]) => qs.set(k, v)),
        delete: async (k: string | string[]) => void ([] as string[]).concat(k).forEach((x) => qs.delete(x)),
        deleteAll: async () => qs.clear(),
      },
    };
    const quota = new Quota(qstate, env);
    env.QUOTA = { idFromName: (n: string) => n, get: () => quota };
    env.COLLAB_NEW_ROOMS_PER_ADDRESS = "1";
    const base = `team-${Date.now().toString(36)}`;
    const room = await committedRoomName(base, "the room password");
    // A stranger who knows the name but not the password: no token, and the room stays unbound.
    await expect(requestRoomToken(url, room, null, { password: "a guess" })).rejects.toThrow(/commitment/);
    const owner = connect(url, room, "the room password", async () => (await requestRoomToken(url, room, null, { password: "the room password" })).token);
    expect(await until(() => owner.synced())).toBe(true);
    owner.plain.getText("t").insert(0, "kept");
    expect(await until(() => rooms.objs.get(room)?.data.has("s0") === true)).toBe(true);
    expect(await until(() => qs.get("stored") === 1)).toBe(true);
    // A second new room from the same address the same day is refused.
    const other = `${base}-2`;
    let denied = false;
    const p = new HocuspocusProvider({ url: roomSocketUrl(url, other), name: other, document: new Y.Doc(), token: async () => (await requestRoomToken(url, other, null, { password: "pw" })).token });
    p.on("authenticationFailed", () => (denied = true));
    cleanups.push(() => p.destroy());
    expect(await until(() => denied)).toBe(true);
    // The room that exists is not affected.
    const again = connect(url, room, "the room password", async () => (await requestRoomToken(url, room, null, { password: "the room password" })).token);
    expect(await until(() => again.synced() && again.plain.getText("t").toString() === "kept")).toBe(true);
  }, 30_000);

  it("refuses a plaintext room and stores nothing of it; answers /healthz; relays signaling", async () => {
    const { url, rooms, fetchWorker, env } = await serveWorker();
    const room = `plain-${Date.now().toString(36)}`;
    // A client that holds the room proof, and sends plaintext anyway.
    const p = connect(url, room, null, async () => (await requestRoomToken(url, room, null, { password: "pw" })).token);
    expect(await until(() => p.synced())).toBe(true);
    p.plain.getText("t").insert(0, "visible words");
    const o = rooms.objs.get(room)!;
    expect(await until(() => [...o.sockets].some((s) => s.closed === 4403))).toBe(true);
    p.provider.destroy();
    for (const v of o.data.values()) if (v instanceof Uint8Array) expect(containsText(v, "visible words")).toBe(false);

    const health = await fetchWorker({ url: "https://collab.test/healthz", headers: { get: () => null } }, env);
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body ?? "{}")).toMatchObject({ ok: true, e2eeOnly: true });

    const s1 = new WebSocket(`${url}/signal`);
    const s2 = new WebSocket(`${url}/signal`);
    cleanups.push(() => {
      s1.close();
      s2.close();
    });
    await Promise.all([s1, s2].map((s) => new Promise((r) => s.addEventListener("open", r, { once: true }))));
    const got: Array<{ type?: string; data?: string; clients?: number }> = [];
    s2.addEventListener("message", (ev) => got.push(JSON.parse(String(ev.data))));
    s1.send(JSON.stringify({ type: "subscribe", topics: ["t1"] }));
    s2.send(JSON.stringify({ type: "subscribe", topics: ["t1"] }));
    s2.send(JSON.stringify({ type: "ping" }));
    expect(await until(() => got.some((m) => m.type === "pong"))).toBe(true);
    s1.send(JSON.stringify({ type: "publish", topic: "t1", data: "offer" }));
    expect(await until(() => got.some((m) => m.data === "offer" && m.clients === 2))).toBe(true);
  }, 30_000);
});

describe("sync-server/collab-server.mjs: E2EE only and retention", () => {
  interface App {
    listen(): Promise<number>;
    close(): Promise<void>;
    sweep(nowMs?: number): number;
  }
  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), "lumen-relay-"));
    cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    return d;
  }

  it("COLLAB_E2EE_ONLY refuses a plaintext edit before it is stored, and lets an encrypted room work", async () => {
    const dataDir = tempDir();
    const app = createCollabServer({ port: 0, host: "127.0.0.1", dataDir, tokenSecret: "x".repeat(40), debounceMs: 20, maxDebounceMs: 50, backupIntervalMs: 0, e2eeOnly: true }) as App;
    const url = `ws://127.0.0.1:${await app.listen()}`;
    cleanups.push(() => app.close());
    const room = `n${Date.now().toString(36)}`;
    const token = async () => (await requestRoomToken(url, room, null)).token;
    const a = connect(url, room, "pw", token);
    const b = connect(url, room, "pw", token);
    expect(await until(() => a.synced() && b.synced())).toBe(true);
    a.plain.getText("t").insert(0, "hidden");
    expect(await until(() => b.plain.getText("t").toString() === "hidden")).toBe(true);

    const proom = `np${Date.now().toString(36)}`;
    let closedWith = "";
    const p = connect(url, proom, null, async () => (await requestRoomToken(url, proom, null)).token);
    // Hocuspocus closes the document with a CLOSE message carrying the reason.
    p.provider.on("close", (e: { event?: { reason?: string } }) => (closedWith = e.event?.reason ?? closedWith));
    expect(await until(() => p.synced())).toBe(true);
    p.plain.getText("t").insert(0, "plain words");
    expect(await until(() => closedWith.startsWith("e2ee-only"))).toBe(true);
    for (const pr of [a, b, p]) pr.provider.destroy();
    await app.close();
    const store = openStore(dataDir);
    try {
      const plainState: Uint8Array | null = store.load(proom);
      expect(plainState === null || !containsText(plainState, "plain words")).toBe(true);
      const encState: Uint8Array | null = store.load(room);
      expect(encState).not.toBeNull();
      expect(containsText(encState!, "hidden")).toBe(false);
    } finally {
      store.close();
    }
  }, 30_000);

  it("deletes rooms nobody changed for COLLAB_RETENTION_DAYS", () => {
    const dataDir = tempDir();
    const store = openStore(dataDir);
    try {
      const now = Date.UTC(2026, 10, 12);
      store.save("old", new Uint8Array([0, 0]), now - 91 * 864e5);
      store.save("fresh", new Uint8Array([0, 0]), now - 89 * 864e5);
      expect(store.sweep(now - 90 * 864e5)).toBe(1);
      expect(store.load("old")).toBeNull();
      expect(store.load("fresh")).not.toBeNull();
    } finally {
      store.close();
    }
  });
});
