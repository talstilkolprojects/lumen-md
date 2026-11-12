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
 *     hash, and the room binds the first one it stores: a token for any
 *     other proof is refused there. So knowing a room's name is not enough
 *     to join it, write to it or keep it alive. A new proof also costs a
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
import { createRelayRoom } from "../../sync-server/collab/relay.mjs";
import {
  accessKeyOk,
  issueRoomToken,
  proofVerifier,
  roomPowOk,
  signingKey,
  tokenVerifier,
  verifyRoomToken,
  DEFAULT_TOKEN_TTL_S,
  MAX_ROOM_POW_BITS,
} from "../../sync-server/collab/roomToken.mjs";

const ROOM_NAME = /^[\w-]{1,128}$/;
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
  }

  async loadRoom(name) {
    if (this.room) return this.room;
    const stored = await this.state.storage.get(["name", "chunks", "verifier"]);
    const chunks = stored.get("chunks") ?? 0;
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
      authorize: async (token, room) => {
        if (verifyRoomToken(key, token, room) !== null) return false;
        const v = tokenVerifier(token);
        // A token with no verifier comes only from a server with an access key.
        if (v === null) return Boolean(this.env.COLLAB_ACCESS_KEY);
        // The first proof binds the room (kept with its first save); any other is refused.
        this.verifier ??= v;
        return v === this.verifier;
      },
      onAuthenticated: (socket, address) => socket.ws.serializeAttachment({ ready: true, address, room: name }),
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
    } catch (e) {
      this.dirty = true; // why: not stored: the next save tries again
      throw e;
    }
  }

  async fetch(request) {
    const name = new URL(request.url).searchParams.get("room") ?? "";
    if (!ROOM_NAME.test(name)) return json({ error: "bad-room" }, 400);
    if (this.state.getWebSockets().length >= MAX_PEERS) return json({ error: "room full" }, 429);
    const room = await this.loadRoom(name);
    const { server, response } = upgrade();
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ ready: false, address: name, room: name });
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

  /** Retention: delete a room nobody changed for RETENTION_DAYS. */
  async alarm() {
    const lastWrite = (await this.state.storage.get("lastWrite")) ?? 0;
    const keep = num(this.env.RETENTION_DAYS, 90) * DAY_MS;
    if (this.state.getWebSockets().length === 0 && Date.now() - lastWrite >= keep) {
      await this.state.storage.deleteAll();
      this.room?.destroy();
      this.room = null;
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
