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
 *     in rooms per address and per IPv6 /48 (review 6, review 8). When the
 *     store is full, a new room may replace one stored room that nobody
 *     came back to and nobody is connected to, the smallest that frees one
 *     room's share (sync-server/collab/roomQuota.mjs, the Quota object below). A new proof also costs a
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
  charge,
  cleanIds,
  cleanOwner,
  dayBuckets,
  dayOf,
  BUSY_MS,
  evictionOrder,
  evictionPlan,
  needed,
  ownerOf,
  prefixOwnerOf,
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
/** At most this many room RPCs for the rooms that make way for one new room (review 8, RR8-469-2). */
const MAX_EVICT_CALLS = 64;
/** And at most this many "can you make way?" asks, on a budget of their own (review 11, RR11-469-2; every ask counts, review 14 RR14-469-2). */
const MAX_ASKS = 256;

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
    /** The admitted creator's owner values ({o, p}, 20-bit hashes, no address), stored with the first write (review 8, RR8-469-3). */
    this.owner = null;
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
      const ok = (await stub.admit(ids, this.rid(a.room ?? "").rid)) === null;
      // Who created it, kept with the room's first write: a Quota that restarts before then still counts it (RR8-469-3).
      if (ok) this.owner = { o: ownerOf(this.env.COLLAB_TOKEN_SECRET, ids), p: prefixOwnerOf(this.env.COLLAB_TOKEN_SECRET, ids) };
      return ok;
    })().catch(() => false);
    const ok = await this.admitting;
    if (!ok) this.admitting = null; // why: refused today: a later try asks again
    return ok;
  }

  async loadRoom(name) {
    if (this.room) return this.room;
    const stored = await this.state.storage.get(["name", "chunks", "verifier", "owner"]);
    const chunks = stored.get("chunks") ?? 0;
    this.stored = chunks > 0;
    this.verifier = typeof stored.get("verifier") === "string" ? stored.get("verifier") : null;
    const o = stored.get("owner");
    if (o && typeof o === "object") this.owner = { o: cleanOwner(o.o), p: cleanOwner(o.p) };
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
        const before = socket.ws.deserializeAttachment?.() ?? {};
        // The owner rides with the socket until the first write, so the room's hibernation doesn't lose it either.
        socket.ws.serializeAttachment({ ready: true, address, room: name, ...(this.owner && !this.stored ? { owner: this.owner } : {}) });
        // Someone else came back to a stored room: the quota never evicts it while that is recent. The creator's
        // own return doesn't count, or anyone could protect every room they make (review 11, RR11-469-1).
        // "Someone other" (review 14, RR14-469-1b): another owner value, and not the creator's IPv6 /48 either.
        const ids = Array.isArray(before.q?.ids) ? before.q.ids : null;
        const secret = this.env.COLLAB_TOKEN_SECRET;
        const joiner = ids ? { o: ownerOf(secret, ids), p: prefixOwnerOf(secret, ids) } : null;
        const creator = joiner !== null && (joiner.o === this.owner?.o || (joiner.p !== null && joiner.p === this.owner?.p));
        if (this.stored && this.env.QUOTA && joiner?.o != null && !creator && Date.now() - this.joinedAt > 3_600_000) {
          this.joinedAt = Date.now();
          void this.quotaStub()?.joined(this.rid(name).rid, joiner).catch(() => {});
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
      if (!this.owner && a.owner && typeof a.owner === "object") this.owner = { o: cleanOwner(a.owner.o), p: cleanOwner(a.owner.p) };
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
    const entries = { name, chunks, lastWrite: Date.now(), ...(this.verifier ? { verifier: this.verifier } : {}), ...(this.owner ? { owner: this.owner } : {}) };
    for (let i = 0; i < chunks; i++) entries[`s${i}`] = state.slice(i * CHUNK, (i + 1) * CHUNK);
    try {
      const old = (await this.state.storage.get("chunks")) ?? 0;
      await this.state.storage.put(entries);
      if (old > chunks) await this.state.storage.delete(Array.from({ length: old - chunks }, (_, i) => `s${chunks + i}`));
      await this.state.storage.setAlarm(Date.now() + num(this.env.RETENTION_DAYS, 90) * DAY_MS);
      this.stored = true;
      // Size and time, every save: the quota caps bytes too (review 6, RR6-469-2).
      const { rid, did } = this.rid(name);
      await this.quotaStub()?.saved(rid, state.byteLength, did, this.owner).catch(() => {}); // why: a count that drifts is not a reason to lose the room
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
    // For a stored room too: who rejoins decides whether that protects it (RR11-469-1).
    const q = this.env.QUOTA ? { ids: quotaIds(this.env.COLLAB_TOKEN_SECRET, request.headers?.get?.("cf-connecting-ip")) } : undefined;
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

  /** Sockets that sent the room token: only they keep a room in use (review 8, RR8-469-2). */
  inUse() {
    return this.state.getWebSockets().some((ws) => {
      try {
        return ws.deserializeAttachment()?.ready === true;
      } catch {
        return true; // why: unsure: count it
      }
    });
  }

  /** RPC from the quota: could this room give up its storage now? (The first of two phases, so a plan that can't succeed evicts nothing.) */
  async canEvict() {
    return !this.inUse();
  }

  /**
   * RPC from the quota (review 6, RR6-469-2): give up this room's storage for
   * a new room. Refused (false) while anyone who sent the room token is
   * connected; the quota then tries the next room. A socket that never
   * authenticated doesn't hold the room (review 8, RR8-469-2): it is closed.
   */
  async evict() {
    if (this.inUse()) return false;
    for (const ws of this.state.getWebSockets()) {
      this.peers.get(ws)?.leave();
      this.peers.delete(ws);
      try {
        ws.close(1013, "room evicted");
      } catch {
        /* already closed */
      }
    }
    await this.state.storage.deleteAll();
    this.room?.destroy();
    this.room = null;
    this.stored = false;
    this.verifier = null;
    this.owner = null;
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
 * bucket of the day and one `r:` key per stored room ({o, p, b, w, a, u, d}).
 */
export class Quota {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.counts = null;
    /** Admitted rooms not saved yet: room id → {o, p} (memory only; the room brings the same with its first write, RR8-469-3). */
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
    this.counts = { day: all.get("day") ?? "", rooms: all.get("rooms") ?? 0, stored: 0, bytes: 0, buckets, owners: new Map(), owners48: new Map(), registry: rooms };
    this.recount();
    return this.counts;
  }

  /** stored, bytes and the rooms per owner, from the room records. */
  recount() {
    const c = this.counts;
    c.stored = c.registry.size;
    c.bytes = 0;
    c.owners = new Map();
    c.owners48 = new Map();
    c.ownerBytes = new Map();
    c.owner48Bytes = new Map();
    for (const r of c.registry.values()) {
      c.bytes += r.b ?? 0;
      if (typeof r.o === "number") {
        c.owners.set(r.o, (c.owners.get(r.o) ?? 0) + 1);
        c.ownerBytes.set(r.o, (c.ownerBytes.get(r.o) ?? 0) + (r.b ?? 0));
      }
      if (typeof r.p === "number") {
        c.owners48.set(r.p, (c.owners48.get(r.p) ?? 0) + 1);
        c.owner48Bytes.set(r.p, (c.owner48Bytes.get(r.p) ?? 0) + (r.b ?? 0));
      }
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
    const owner48 = prefixOwnerOf(secret, cleanIds(ids));
    if (day > c.day) {
      // A new day: yesterday's buckets go (the rooms' records stay).
      const old = [...c.buckets.keys()].map((k) => `b:${k}`);
      for (let i = 0; i < old.length; i += 128) await this.state.storage.delete(old.slice(i, i + 128));
      c.day = day;
      c.rooms = 0;
      c.buckets = new Map();
    }
    // First every limit but the store's: a client refused by those never costs a stored room (RR6-469-2).
    let why = admit({ ...c, buckets: new Map(c.buckets) }, keys, day, { ...limits, maxRooms: Infinity, maxBytes: Infinity }, owner, owner48);
    if (why === null) {
      // A full store: one stored room nobody came back to may make way, but only for an attempt that passes
      // everything else, and only when it is enough (review 8, RR8-469-1).
      const full = storeFull(c, limits);
      if (full && !(await this.makeWay(limits))) {
        why = "rooms-full";
        charge(c, keys); // why: refused, the attempt still counts for this client
      } else why = admit(c, keys, day, full ? { ...limits, maxRooms: Infinity, maxBytes: Infinity } : limits, owner, owner48);
    }
    const put = { day: c.day, rooms: c.rooms };
    if (why === null || why === "rooms-full") for (const k of keys) put[`b:${k}`] = c.buckets.get(k);
    if (why === null && typeof rid === "string" && rid && rid.length <= 128) {
      this.pending.set(rid, { o: owner, p: owner48 });
      if (this.pending.size > 5000) this.pending.delete(this.pending.keys().next().value);
    }
    await this.state.storage.put(put);
    return why;
  }

  /** One room's RPC (`canEvict` or `evict`): true when it agrees. A record with no Durable Object id has no room to ask. */
  async askRoom(rid, method) {
    const r = this.counts.registry.get(rid);
    if (!r?.d || !this.env.ROOMS?.idFromString) return true;
    try {
      return (await this.env.ROOMS.get(this.env.ROOMS.idFromString(r.d))[method]()) === true;
    } catch {
      return false; // why: not reachable now: keep its record and try another room
    }
  }

  /**
   * Make way for one new room (review 8, RR8-469-1 and -2; review 11,
   * RR11-469-1 and -2): the rooms `evictionPlan` picks, each asked first, then
   * evicted. A room in use is left out, and for an hour it isn't asked again
   * (it is not a candidate); the search goes on with the next. Every ask
   * (canEvict) costs one RPC out of a budget of its own (MAX_ASKS), and a
   * plan stops at its first refusal, so rooms held open can't use up the
   * budget the rooms that can go need (MAX_EVICT_CALLS). True when the need was freed; when it can't be,
   * nothing is evicted (a room can only be lost in a race, to a reader who
   * joined between the two phases).
   */
  async makeWay(limits) {
    const c = this.counts;
    const now = Date.now();
    const want = needed(c, limits);
    const left = new Set();
    let asks = 0;
    let calls = 0;
    let freedBytes = 0;
    let freedRooms = 0;
    const busy = async (rid) => {
      left.add(rid);
      const r = c.registry.get(rid);
      if (!r) return;
      r.u = now;
      await this.state.storage.put({ [`r:${rid}`]: r });
    };
    const recent = (rid) => {
      const u = c.registry.get(rid)?.u;
      return Boolean(u && now - u < BUSY_MS);
    };
    while (asks < MAX_ASKS) {
      const need = { rooms: Math.max(0, want.rooms - freedRooms), bytes: Math.max(0, want.bytes - freedBytes) };
      if (need.rooms === 0 && need.bytes === 0 && (freedRooms > 0 || freedBytes > 0)) return true;
      const order = evictionOrder(c.registry, now, limits).filter((rid) => !left.has(rid) && !recent(rid));
      const plan = evictionPlan(c.registry, order, need);
      if (!plan || calls + plan.length > MAX_EVICT_CALLS || asks + plan.length > MAX_ASKS) return false;
      // Phase one: every room in the plan agrees before anything is deleted. Every ask counts (review 14,
      // RR14-469-2), and the first refusal ends the plan.
      let agreed = true;
      for (const rid of plan) {
        asks++;
        if (!(await this.askRoom(rid, "canEvict"))) {
          agreed = false;
          await busy(rid);
          break;
        }
      }
      if (!agreed) continue;
      for (const rid of plan) {
        calls++;
        const bytes = c.registry.get(rid)?.b ?? 0;
        // One that someone joined since refuses the second phase: the next plan does without it.
        if (!(await this.askRoom(rid, "evict"))) {
          await busy(rid);
          continue;
        }
        c.registry.delete(rid);
        await this.state.storage.delete(`r:${rid}`);
        freedBytes += bytes;
        freedRooms++;
      }
      this.recount();
      await this.state.storage.put({ stored: c.stored, bytes: c.bytes });
    }
    return false;
  }

  /** RPC: a room was stored (first time) or stored again: its size and time. */
  async saved(rid, bytes, did = "", owner = null) {
    if (typeof rid !== "string" || !rid || rid.length > 128) return null;
    const c = await this.load();
    const old = c.registry.get(rid);
    // The owner from this object's memory, else the one the room stored with its first write (RR8-469-3).
    const mine = this.pending.get(rid);
    const o = old?.o ?? mine?.o ?? cleanOwner(owner?.o);
    const p = old?.p ?? mine?.p ?? cleanOwner(owner?.p);
    const r = { o, p, b: Math.max(0, Math.floor(Number(bytes) || 0)), w: Date.now(), a: old?.a ?? 0, u: old?.u ?? 0, d: typeof did === "string" ? did.slice(0, 128) : "" };
    this.pending.delete(rid);
    c.registry.set(rid, r);
    this.recount();
    await this.state.storage.put({ [`r:${rid}`]: r, stored: c.stored, bytes: c.bytes });
    return c.stored;
  }

  /**
   * RPC: someone joined the stored room again: it is not evicted for COLLAB_PROTECT_DAYS. Only a joiner that is
   * not the creator protects it (review 11, RR11-469-1): another owner value, and, when both are on IPv6, not
   * the creator's /48 (review 14, RR14-469-1b). `joiner` is {o, p} (a bare number is an `o`). Another IPv4
   * address counts as another person: the Quota keeps no address to tell two of one person's apart, and an
   * owner's rooms past its byte cap lose their protection anyway (RR14-469-1a).
   */
  async joined(rid, joiner = null) {
    const c = await this.load();
    const r = c.registry.get(rid);
    const who = typeof joiner === "object" && joiner !== null ? { o: cleanOwner(joiner.o), p: cleanOwner(joiner.p) } : { o: cleanOwner(joiner), p: null };
    if (!r || who.o === null) return false;
    if (typeof r.o === "number" && who.o === r.o) return false;
    if (typeof r.p === "number" && who.p === r.p) return false;
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
