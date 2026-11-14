/**
 * LEGACY — superseded by collab-server.mjs (Hocuspocus + SQLite, plan 3.6).
 * The app no longer speaks this server's y-websocket protocol; it is kept
 * only so an existing LevelDB store can still be read out.
 *
 * Lumen persistent collab server (P2-03).
 *
 * Drop-in y-websocket signalling + storage backend. Each room becomes a Y.Doc
 * persisted to disk with `y-leveldb`, so a tab can re-join an empty room and
 * still recover the latest state — solving the "WebRTC room evaporates when
 * the last peer leaves" limitation.
 *
 * The server is intentionally tiny: it relies on the upstream
 * `y-websocket/utils` wiring for awareness, sync, and persistence callbacks.
 *
 * ── Local dev ─────────────────────────────────────────────────────────────
 *   cd sync-server
 *   npm install @y/websocket-server y-leveldb    # one-time
 *   PORT=4444 node persistent-server.js        # serves ws://localhost:4444
 *
 * ── Client wiring ─────────────────────────────────────────────────────────
 * Set `VITE_YJS_WEBSOCKET_URL=ws://localhost:4444` in `.env.local`. The
 * client (`src/collab/yjs.ts`) will attach a `WebsocketProvider` alongside
 * the WebRTC peer mesh, so docs survive across full sign-outs.
 *
 * ── Storage ───────────────────────────────────────────────────────────────
 *   YJS_STORAGE_DIR (preferred) or LEVELDB_PATH (legacy alias) selects the
 *   LevelDB directory; defaults to `./.yjs-persistence`. Point it at a
 *   mounted volume in production (docker-compose uses /data/yjs).
 *   LevelDB is the ONLY storage backend — there is no Postgres archive;
 *   DATABASE_URL is not read by this server.
 *
 * ── Access token (T49) ─────────────────────────────────────────────────────
 *   COLLAB_TOKEN=<long random string> makes the server accept only clients
 *   that connect with ?token=<the same string> (Lumen sends it from
 *   Collab settings → "Server access token"). Without it, anyone who knows
 *   a room name can read the room's (encrypted) updates and add their own.
 *   Room names are 128-bit random and new rooms are end-to-end encrypted,
 *   so the token is a second gate, not the only one.
 *
 * ── Health ────────────────────────────────────────────────────────────────
 *   GET /healthz and GET /health → 200 {"ok":true}
 *
 * ── Deployment ────────────────────────────────────────────────────────────
 *   • Fly.io: `fly launch && fly deploy` — mount a volume at /data and set
 *     YJS_STORAGE_DIR=/data/yjs.
 *   • Render / Railway: same, using a persistent disk.
 *   • Always front with TLS (wss://) before exposing publicly.
 */

const WebSocket = require("ws");
const http = require("http");
const path = require("path");

// utils is exported by @y/websocket-server (moved out of y-websocket in v3) and wires up doc lifecycle, awareness,
// and persistence. We require it lazily so this file still parses if the
// dependency is missing (the operator gets a helpful error on startup).
let setupWSConnection;
let LeveldbPersistence;
try {
  ({ setupWSConnection } = require("@y/websocket-server/utils"));
  ({ LeveldbPersistence } = require("y-leveldb"));
} catch (err) {
  console.error(
    "Missing dependency. Run `npm install @y/websocket-server y-leveldb` first.",
    err.message,
  );
  process.exit(1);
}

const PORT = Number(process.env.PORT || 4444);
// YJS_STORAGE_DIR wins; LEVELDB_PATH is accepted for older Docker images /
// compose files that set it.
const STORAGE_DIR =
  process.env.YJS_STORAGE_DIR ||
  process.env.LEVELDB_PATH ||
  path.join(__dirname, ".yjs-persistence");

// ── Persistence ──────────────────────────────────────────────────────────────
const persistence = new LeveldbPersistence(STORAGE_DIR);

// @y/websocket-server calls these hooks on each document open/update/close.
const yWebsocketUtils = require("@y/websocket-server/utils");
yWebsocketUtils.setPersistence({
  bindState: async (docName, ydoc) => {
    const persistedYdoc = await persistence.getYDoc(docName);
    const newUpdates = require("yjs").encodeStateAsUpdate(ydoc);
    persistence.storeUpdate(docName, newUpdates);
    require("yjs").applyUpdate(ydoc, require("yjs").encodeStateAsUpdate(persistedYdoc));
    ydoc.on("update", (update) => persistence.storeUpdate(docName, update));
  },
  writeState: () => Promise.resolve(),
});

// ── HTTP + WebSocket ─────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const pathname = (req.url || "/").split("?")[0];
  if (pathname === "/healthz" || pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "ok", service: "lumen-collab" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Lumen persistent collab server\n");
});

const { tokenOk: checkToken } = require("./token");
const COLLAB_TOKEN = process.env.COLLAB_TOKEN || "";
const tokenOk = (url) => checkToken(url, COLLAB_TOKEN);

const wss = new WebSocket.Server({ server });
wss.on("connection", (conn, req) => {
  if (!tokenOk(req.url || "/")) {
    conn.close(4401, "unauthorized");
    return;
  }
  // The room name comes from the URL path: ws://host/room-name
  setupWSConnection(conn, req, {
    docName: req.url.slice(1).split("?")[0] || "default",
    gc: true,
  });
});

server.listen(PORT, () => {
  console.log(`Lumen persistent collab listening on :${PORT}`);
  if (!COLLAB_TOKEN) console.warn("COLLAB_TOKEN is not set — any client that knows a room name can connect.");
  console.log(`Storage at ${STORAGE_DIR}`);
});

// Graceful shutdown so LevelDB closes its files cleanly.
function shutdown(signal) {
  console.log(`Received ${signal}, closing…`);
  wss.close();
  server.close(() => {
    persistence.destroy().finally(() => process.exit(0));
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
