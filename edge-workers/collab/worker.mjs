/**
 * The public live-share server (plan W4.8) on Cloudflare Workers + Durable
 * Objects, on the Workers Free plan.
 *
 *   wss://<host>/?room=<name>   a room (Hocuspocus protocol, the app's
 *                               HocuspocusProvider). One Durable Object per
 *                               room, created near the first person in it.
 *   wss://<host>/token          a short-lived token for one room
 *                               (sync-server/collab/roomToken.mjs).
 *   wss://<host>/signal         WebRTC signaling (the y-webrtc protocol of
 *                               sync-server/server.js), for peer-to-peer.
 *   GET /healthz                {"ok":true}
 *
 * What the server keeps (PRIVACY.he.md, "הערכת השפעה"):
 *   - Encrypted rooms only. Every update is checked before it is applied
 *     (sync-server/collab/relay.mjs, checkE2eeUpdate): anything but
 *     envelopes of src/collab/e2e.ts closes the connection (4403) and is
 *     not stored. So a room is ciphertext the server cannot read.
 *   - Retention: a room nobody changed for RETENTION_DAYS (default 90) is
 *     deleted by its Durable Object's alarm. Only a change writes storage
 *     (review 12.11): a connection that never authenticated with the room
 *     token, or one that only read, writes nothing and doesn't refresh the
 *     retention clock. (The relay applies no update before the token is
 *     checked, so a change always comes from an authenticated peer.)
 *   - A token is not free (review 2, 12.11). Without COLLAB_ACCESS_KEY (the
 *     public server), /token answers only a request that carries the room
 *     proof, which the app derives from the room's password in the share
 *     link (sync-server/collab/roomToken.mjs). The token names the proof's
 *     hash. The app's room names commit to that hash (`<name>_k<32 hex>`,
 *     review 4): /token and the room accept only the matching proof, so not
 *     even the first to connect can bind a room without its password. A name
 *     the app made before commitments binds the first proof; any other name
 *     binds none. So knowing a room's name is not enough to join it, write to
 *     it, keep it alive or lock its owners out.
 *   - New rooms are limited (review 2): per day on the whole server, per
 *     address and per IPv6 /48; and what is stored, in rooms, in bytes and
 *     in rooms per address (review 6). When the store is full, a new room
 *     may replace the smallest stored room that nobody came back to
 *     (sync-server/collab/roomQuota.mjs, the Quota object below). A new proof also costs a
 *     proof of work of COLLAB_POW_BITS (wrangler.toml sets 18), bound to the
 *     room and the proof, which the app solves once per room and session.
 *     With COLLAB_ACCESS_KEY (a private server), the key is enough.
 *   - No IP addresses in logs: this code logs nothing about connections,
 *     and Workers Logs are off in wrangler.toml. Cloudflare's own edge
 *     sees addresses, as any host does.
 *   - Awareness (cursors, the random display name) is relayed in memory and
 *     never stored.
 *
 * Deploy: `npm run collab:deploy` (docs: collab/public-server).
 */
import { createHmac } from "node:crypto";
import { createRelayRoom } from "../../sync-server/collab/relay.mjs";
import {
  accessKeyOk,
  commitmentOk,
  issueRoomToken,
  proofVerifier,
  roomKind,
  roomPowOk,
  signingKey,
  splitCommittedRoom,
  tokenVerifier,
  admit,
  cleanIds,
  dayBuckets,
  dayOf,
  evictionOrder,
  ownerOf,
  quotaIds,
  quotaLimits,
  storeFull,
  verifyRoomToken,
  DEFAULT_TOKEN_TTL_S,
  MAX_ROOM_POW_BITS,
} from "../../sync-server/collab/roomToken.mjs";

// A name, or a name with its commitment (`<name>_k<32 hex>`, roomToken.mjs).
const ROOM_NAME = /^[\w-]{1,162}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK = 1_000_000; // a Durable Object value holds at most 2 MB
const SAVE_DEBOUNCE_MS = 2000;
const MAX_PEERS = 50;

const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

let keyCache = null;
function tokenKey(env) {
  // Required in production: with a random key, tokens issued by one isolate
  // fail in another.
  keyCache ??= signingKey(env.COLLAB_TOKEN_SECRET || "");
  return keyCache;
}

function upgrade() {
  const pair = new WebSocketPair();
  return { client: pair[0], server: pair[1], response: new Response(null, { status: 101, webSocket: pair[0] }) };
}

/** /token: one JSON request {room, key}, one JSON answer, then close. */
function tokenSocket(env) {
  const { server, response } = upgrade();
  server.accept();
  const timer = setTimeout(() => server.close(1008, "timeout"), 5000);
  server.addEventListener("message", (ev) => {
    clearTimeout(timer);
    let req = null;
    try {
      req = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data));
    } catch {
      /* answered below */
    }
    let answer;
    const keyed = Boolean(env.COLLAB_ACCESS_KEY);
    const verifier = req ? proofVerifier(req.proof) : null;
    const bits = Math.min(MAX_ROOM_POW_BITS, Math.max(0, Math.floor(num(env.COLLAB_POW_BITS, 0))));
    const ttlS = num(env.COLLAB_TOKEN_TTL_S, DEFAULT_TOKEN_TTL_S);
    if (!req || typeof req.room !== "string" || !ROOM_NAME.test(req.room)) answer = { error: "bad-room" };
    else if (keyed && !accessKeyOk(req.key, env.COLLAB_ACCESS_KEY)) answer = { error: "unauthorized" };
    // The public server: no token without the room proof, and a proof of work for it.
    else if (!keyed && !verifier) answer = { error: "proof" };
    // Review 4 (RR4-469-1): a name that commits to its proof gets a token only for that proof.
    else if (verifier && splitCommittedRoom(req.room) && !commitmentOk(req.room, verifier)) answer = { error: "commitment" };
    else if (!keyed && bits > 0 && !roomPowOk(req.room, verifier, req.pow, bits)) answer = { error: "pow", bits };
    else answer = issueRoomToken(tokenKey(env), req.room, { ttlS, ...(verifier ? { verifier } : {}) });
    server.send(JSON.stringify(answer));
    server.close(1000, "done");
  });
  return response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    if (/\/health(z)?$/.test(path)) return json({ ok: true, status: "ok", service: "lumen-collab", persistence: "durable-objects", e2eeOnly: true });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "websocket only" }, 426);
    if (path.endsWith("/token")) return tokenSocket(env);
    if (path.endsWith("/signal")) return env.SIGNAL.get(env.SIGNAL.idFromName("signal")).fetch(request);
    const room = url.searchParams.get("room") ?? "";
    if (!ROOM_NAME.test(room)) return json({ error: "bad-room" }, 400);
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  },
};

/** One room. Sockets hibernate; the document is loaded again on wake. */
export class CollabRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;
    this.peers = new Map(); // WebSocket → relay peer
    this.saveTimer = null;
    /** An authenticated peer changed the room since the last save. */
    this.dirty = false;
    /** The hash of the room proof this room is bound to (stored with the room), or null before the first. */
    this.verifier = null;
    /** Something of the room is stored (so it is not a new room for the quota). */
    this.stored = false;
    /** The quota's answer for this new room, asked once (review 2 RR2-469-1). */
    this.admitting = null;
    /** When this wake last told the quota that someone joined the stored room again. */
    this.joinedAt = 0;
  }

  /** This room's id at the quota: its Durable Object id (no name), or a keyed hash of the name. */
  rid(name) {
    const id = this.state.id?.toString?.();
    if (typeof id === "string" && id) return { rid: id, did: id };
    return { rid: `n:${createHmac("sha256", String(this.env.COLLAB_TOKEN_SECRET || "")).update(`lumen-collab room id|${name}`).digest("base64url").slice(0, 22)}`, did: "" };
  }

  /**
   * A new room (nothing stored) opens only within the server's limits
   * (quota.mjs): asked once, when its first peer authenticates. Without a
   * QUOTA binding (tests, a private server) there are no limits;
   * wrangler.toml binds it on the public server.
   */
  async admitNew(socket) {
    if (this.stored || !this.env.QUOTA) return true;
    this.admitting ??= (async () => {
      const a = socket?.ws?.deserializeAttachment?.() ?? {};
      // The client's ids, not the day: the Quota decides the day (review 6, RR6-469-1).
      const ids = Array.isArray(a.q?.ids) ? a.q.ids : quotaIds(this.env.COLLAB_TOKEN_SECRET, "?");
      const stub = this.env.QUOTA.get(this.env.QUOTA.idFromName("quota"));
      return (await stub.admit(ids, this.rid(a.room ?? "").rid)) === null;
    })().catch(() => false);
    const ok = await this.admitting;
    if (!ok) this.admitting = null; // why: refused today: a later try asks again
    return ok;
  }

  async loadRoom(name) {
    if (this.room) return this.room;
    const stored = await this.state.storage.get(["name", "chunks", "verifier"]);
    const chunks = stored.get("chunks") ?? 0;
    this.stored = chunks > 0;
    this.verifier = typeof stored.get("verifier") === "string" ? stored.get("verifier") : null;
    let state = null;
    if (chunks > 0) {
      const parts = await this.state.storage.get(Array.from({ length: chunks }, (_, i) => `s${i}`));
      const list = Array.from({ length: chunks }, (_, i) => parts.get(`s${i}`));
      if (list.every((p) => p instanceof Uint8Array || p instanceof ArrayBuffer)) {
        const bytes = list.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
        state = new Uint8Array(bytes.reduce((n, b) => n + b.byteLength, 0));
        let off = 0;
        for (const b of bytes) {
          state.set(b, off);
          off += b.byteLength;
        }
      }
    }
    const key = tokenKey(this.env);
    this.room = createRelayRoom({
      name,
      state,
      e2eeOnly: true,
      maxBytes: num(this.env.MAX_ROOM_BYTES, 4_000_000),
      authorize: async (token, room, socket) => {
        if (verifyRoomToken(key, token, room) !== null) return false;
        const v = tokenVerifier(token);
        // A token with no verifier comes only from a server with an access key.
        if (v === null) return Boolean(this.env.COLLAB_ACCESS_KEY) && (await this.admitNew(socket));
        const kind = roomKind(name);
        // Review 4 (RR4-469-1): a committed name lets in only the proof it commits to.
        if (kind === "committed" && !commitmentOk(name, v)) return false;
        // A bound room (kept with its first save) refuses any other proof.
        if (this.verifier !== null && v !== this.verifier) return false;
        if (!(await this.admitNew(socket))) return false;
        // The first proof binds a committed or app-made room. An "open" name (typed, so
        // known in advance) binds nothing: a stranger connecting first can't lock out
        // its owners. The app commits every name it uses here.
        if (this.verifier === null && kind !== "open") this.verifier = v;
        return this.verifier === null || v === this.verifier;
      },
      onAuthenticated: (socket, address) => {
        socket.ws.serializeAttachment({ ready: true, address, room: name });
        // Someone came back to a stored room: the quota never evicts it while that is recent.
        if (this.stored && this.env.QUOTA && Date.now() - this.joinedAt > 3_600_000) {
          this.joinedAt = Date.now();
          void this.quotaStub()?.joined(this.rid(name).rid).catch(() => {});
        }
      },
      onChange: () => {
        this.dirty = true;
        this.scheduleSave(name);
      },
    });
    // Sockets that were already in the room before the object hibernated.
    for (const ws of this.state.getWebSockets()) {
      if (this.peers.has(ws)) continue;
      const a = ws.deserializeAttachment() ?? {};
      this.peers.set(ws, this.room.join(this.socketFor(ws), a.ready ? { ready: true, address: a.address } : null));
    }
    return this.room;
  }

  socketFor(ws) {
    return {
      ws,
      send: (bytes) => {
        try {
          ws.send(bytes);
        } catch {
          /* closed meanwhile */
        }
      },
      close: (code, reason) => {
        try {
          ws.close(code, reason);
        } catch {
          /* already closed */
        }
      },
    };
  }

  scheduleSave(name) {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save(name);
    }, SAVE_DEBOUNCE_MS);
  }

  /** Store the room, only when it changed: nothing else writes storage or moves the alarm. */
  async save(name) {
    if (!this.room || !this.dirty) return;
    this.dirty = false;
    const state = this.room.state();
    const chunks = Math.max(1, Math.ceil(state.byteLength / CHUNK));
    const entries = { name, chunks, lastWrite: Date.now(), ...(this.verifier ? { verifier: this.verifier } : {}) };
    for (let i = 0; i < chunks; i++) entries[`s${i}`] = state.slice(i * CHUNK, (i + 1) * CHUNK);
    try {
      const old = (await this.state.storage.get("chunks")) ?? 0;
      await this.state.storage.put(entries);
      if (old > chunks) await this.state.storage.delete(Array.from({ length: old - chunks }, (_, i) => `s${chunks + i}`));
      await this.state.storage.setAlarm(Date.now() + num(this.env.RETENTION_DAYS, 90) * DAY_MS);
      this.stored = true;
      // Size and time, every save: the quota caps bytes too (review 6, RR6-469-2).
      const { rid, did } = this.rid(name);
      await this.quotaStub()?.saved(rid, state.byteLength, did).catch(() => {}); // why: a count that drifts is not a reason to lose the room
    } catch (e) {
      this.dirty = true; // why: not stored: the next save tries again
      throw e;
    }
  }

  quotaStub() {
    return this.env.QUOTA ? this.env.QUOTA.get(this.env.QUOTA.idFromName("quota")) : null;
  }

  async fetch(request) {
    const name = new URL(request.url).searchParams.get("room") ?? "";
    if (!ROOM_NAME.test(name)) return json({ error: "bad-room" }, 400);
    if (this.state.getWebSockets().length >= MAX_PEERS) return json({ error: "room full" }, 429);
    const room = await this.loadRoom(name);
    const { server, response } = upgrade();
    this.state.acceptWebSocket(server);
    // The quota's buckets for this client (HMACs under the day's key, no address), for a new room.
    const q = this.env.QUOTA && !this.stored ? { ids: quotaIds(this.env.COLLAB_TOKEN_SECRET, request.headers?.get?.("cf-connecting-ip")) } : undefined;
    server.serializeAttachment({ ready: false, address: name, room: name, ...(q ? { q } : {}) });
    this.peers.set(server, room.join(this.socketFor(server)));
    return response;
  }

  async webSocketMessage(ws, message) {
    if (typeof message === "string") return ws.close(1003, "binary only");
    const a = ws.deserializeAttachment() ?? {};
    await this.loadRoom(a.room);
    const peer = this.peers.get(ws);
    if (peer) await peer.receive(new Uint8Array(message));
  }

  async webSocketClose(ws) {
    await this.leave(ws);
  }

  async webSocketError(ws) {
    await this.leave(ws);
  }

  async leave(ws) {
    const peer = this.peers.get(ws);
    this.peers.delete(ws);
    peer?.leave();
    if (this.peers.size === 0 && this.room) {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      const a = ws.deserializeAttachment() ?? {};
      // Only a pending change is stored: a socket that never sent the room token, or only read, writes nothing.
      if (a.room && this.dirty) await this.save(a.room);
    }
  }

  /**
   * RPC from the quota (review 6, RR6-469-2): give up this room's storage for
   * a new room. Refused (false) while anyone is connected; the quota then
   * tries the next room.
   */
  async evict() {
    if (this.state.getWebSockets().length > 0) return false;
    await this.state.storage.deleteAll();
    this.room?.destroy();
    this.room = null;
    this.stored = false;
    this.verifier = null;
    this.dirty = false;
    return true;
  }

  /** Retention: delete a room nobody changed for RETENTION_DAYS. */
  async alarm() {
    const lastWrite = (await this.state.storage.get("lastWrite")) ?? 0;
    const keep = num(this.env.RETENTION_DAYS, 90) * DAY_MS;
    if (this.state.getWebSockets().length === 0 && Date.now() - lastWrite >= keep) {
      const had = this.stored || ((await this.state.storage.get("chunks")) ?? 0) > 0;
      const name = (await this.state.storage.get("name")) ?? "";
      await this.state.storage.deleteAll();
      this.room?.destroy();
      this.room = null;
      this.stored = false;
      this.verifier = null;
      if (had) await this.quotaStub()?.forget(this.rid(name).rid).catch(() => {});
    } else {
      await this.state.storage.setAlarm(lastWrite + keep);
    }
  }
}

/**
 * WebRTC signaling, the protocol of sync-server/server.js: subscribe /
 * unsubscribe / publish / ping. y-webrtc encrypts what it publishes when
 * the room has a password. Topics live in each socket's attachment, so
 * they survive hibernation; nothing is stored.
 */
export class Signal {
  constructor(state) {
    this.state = state;
  }

  async fetch() {
    const { server, response } = upgrade();
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ topics: [] });
    return response;
  }

  async webSocketMessage(ws, message) {
    let msg = null;
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;
    const a = ws.deserializeAttachment() ?? { topics: [] };
    const topics = new Set(a.topics);
    switch (msg.type) {
      case "subscribe":
        for (const t of msg.topics ?? []) if (typeof t === "string" && t.length <= 256 && topics.size < 64) topics.add(t);
        ws.serializeAttachment({ topics: [...topics] });
        return;
      case "unsubscribe":
        for (const t of msg.topics ?? []) topics.delete(t);
        ws.serializeAttachment({ topics: [...topics] });
        return;
      case "publish": {
        // To every subscriber of the topic, the sender too, with the count
        // in `clients` (as sync-server/server.js does).
        if (typeof msg.topic !== "string") return;
        const receivers = this.state.getWebSockets().filter((other) => (other.deserializeAttachment()?.topics ?? []).includes(msg.topic));
        const out = JSON.stringify({ ...msg, clients: receivers.length });
        for (const other of receivers) {
          try {
            other.send(out);
          } catch {
            /* closed meanwhile */
          }
        }
        return;
      }
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      default:
        return;
    }
  }

  async webSocketClose() {}

  async webSocketError() {}
}

/**
 * The one counter for new rooms (review 2 RR2-469-1, review 6; the rules
 * are in sync-server/collab/roomQuota.mjs).
 * Its storage: day, rooms (today's new ones), stored, bytes, one `b:` key per
 * bucket of the day and one `r:` key per stored room ({o, b, w, a, d}).
 */
export class Quota {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.counts = null;
    /** Admitted rooms not saved yet: room id → owner (memory only; lost with the object, which only loses an owner). */
    this.pending = new Map();
  }

  async load() {
    if (this.counts) return this.counts;
    const all = await this.state.storage.list();
    const buckets = new Map();
    const rooms = new Map();
    for (const [k, v] of all) {
      if (k.startsWith("b:")) buckets.set(k.slice(2), v);
      else if (k.startsWith("r:") && v && typeof v === "object") rooms.set(k.slice(2), v);
    }
    this.counts = { day: all.get("day") ?? "", rooms: all.get("rooms") ?? 0, stored: 0, bytes: 0, buckets, owners: new Map(), registry: rooms };
    this.recount();
    return this.counts;
  }

  /** stored, bytes and the rooms per owner, from the room records. */
  recount() {
    const c = this.counts;
    c.stored = c.registry.size;
    c.bytes = 0;
    c.owners = new Map();
    for (const r of c.registry.values()) {
      c.bytes += r.b ?? 0;
      if (typeof r.o === "number") c.owners.set(r.o, (c.owners.get(r.o) ?? 0) + 1);
    }
  }

  /** The day by this object's clock, never earlier than the day it counted last (review 6, RR6-469-1). */
  today() {
    const d = dayOf(Date.now());
    return this.counts && this.counts.day > d ? this.counts.day : d;
  }

  /**
   * RPC: may a new room open for a client with these ids? null = yes
   * (counted), else the reason. The caller passes no day: the bucket names
   * are made here, under today's key.
   */
  async admit(ids, rid) {
    const c = await this.load();
    const day = this.today();
    const secret = this.env.COLLAB_TOKEN_SECRET;
    const limits = quotaLimits(this.env);
    const keys = dayBuckets(secret, cleanIds(ids), day);
    const owner = ownerOf(secret, cleanIds(ids));
    if (day > c.day) {
      // A new day: yesterday's buckets go (the rooms' records stay).
      const old = [...c.buckets.keys()].map((k) => `b:${k}`);
      for (let i = 0; i < old.length; i += 128) await this.state.storage.delete(old.slice(i, i + 128));
    }
    // A full store: a stored room nobody came back to may make way (RR6-469-2).
    // Only for a client the other limits would let in: a refused one never costs a stored room.
    if (storeFull(c, limits) && admit({ ...c, buckets: new Map(c.buckets) }, keys, day, { ...limits, maxRooms: Infinity, maxBytes: Infinity }, owner) === null) {
      await this.evictFor(limits);
    }
    const why = admit(c, keys, day, limits, owner);
    const put = { day: c.day, rooms: c.rooms };
    if (why === null) {
      for (const k of keys) put[`b:${k}`] = c.buckets.get(k);
      if (typeof rid === "string" && rid && rid.length <= 128) {
        this.pending.set(rid, owner);
        if (this.pending.size > 5000) this.pending.delete(this.pending.keys().next().value);
      }
    }
    await this.state.storage.put(put);
    return why;
  }

  /** Make room: evict stored rooms in `evictionOrder` until the store is not full (a few tries at most). */
  async evictFor(limits) {
    const c = this.counts;
    let tries = 0;
    for (const rid of evictionOrder(c.registry, Date.now(), limits)) {
      if (!storeFull(c, limits) || tries++ >= 8) break;
      const r = c.registry.get(rid);
      let ok = true;
      if (r?.d && this.env.ROOMS?.idFromString) {
        try {
          ok = (await this.env.ROOMS.get(this.env.ROOMS.idFromString(r.d)).evict()) === true;
        } catch {
          ok = false; // why: not reachable now: keep its record and try the next room
        }
      }
      if (!ok) continue;
      c.registry.delete(rid);
      await this.state.storage.delete(`r:${rid}`);
      this.recount();
    }
    await this.state.storage.put({ stored: c.stored, bytes: c.bytes });
  }

  /** RPC: a room was stored (first time) or stored again: its size and time. */
  async saved(rid, bytes, did = "") {
    if (typeof rid !== "string" || !rid || rid.length > 128) return null;
    const c = await this.load();
    const old = c.registry.get(rid);
    const r = { o: old ? old.o : (this.pending.get(rid) ?? null), b: Math.max(0, Math.floor(Number(bytes) || 0)), w: Date.now(), a: old?.a ?? 0, d: typeof did === "string" ? did.slice(0, 128) : "" };
    this.pending.delete(rid);
    c.registry.set(rid, r);
    this.recount();
    await this.state.storage.put({ [`r:${rid}`]: r, stored: c.stored, bytes: c.bytes });
    return c.stored;
  }

  /** RPC: someone joined the stored room again: it is not evicted for COLLAB_PROTECT_DAYS. */
  async joined(rid) {
    const c = await this.load();
    const r = c.registry.get(rid);
    if (!r) return false;
    r.a = Date.now();
    await this.state.storage.put({ [`r:${rid}`]: r });
    return true;
  }

  /** RPC: a room was deleted (retention). */
  async forget(rid) {
    const c = await this.load();
    if (!c.registry.delete(rid)) return c.stored;
    this.recount();
    await this.state.storage.delete(`r:${rid}`);
    await this.state.storage.put({ stored: c.stored, bytes: c.bytes });
    return c.stored;
  }
}
