/**
 * Lumen y-webrtc signaling server.
 *
 * Speaks the y-webrtc signaling protocol (mirrors the reference
 * implementation in `y-webrtc/bin/server.js`):
 *
 *   client → server  {type:'subscribe',   topics:[...]}
 *   client → server  {type:'unsubscribe', topics:[...]}
 *   client → server  {type:'publish',     topic, ...}   → forwarded to every
 *                    subscriber of `topic` (INCLUDING the sender), with a
 *                    `clients` field set to the subscriber count.
 *   client → server  {type:'ping'}  → server replies {type:'pong'}
 *
 * Legacy protocol (kept because it is cheap): `{type:'join', room}` subscribes
 * the socket to `room` and replies `{type:'joined', room, peers}`; any other
 * message from a joined socket is relayed to the other members of that room.
 *
 * Usage:
 *   node server.js                      # listens on $PORT (default 4444)
 *   require('./server').createServer({ port: 0, heartbeatMs: 100 })
 */

const WebSocket = require("ws");
const http = require("http");

const log = (...args) => {
  if (process.env.SIGNAL_QUIET) return;
  console.log(new Date().toISOString(), ...args);
};

const DEFAULT_PORT = 4444;
const DEFAULT_HEARTBEAT_MS = 30_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 120; // messages per minute per IP (SIGNAL_RATE_LIMIT_MAX)
// Resource caps — an unauthenticated client must not be able to make the
// server retain unbounded state. y-webrtc subscribes one topic per room and
// its signalling payloads (SDP offers/answers, ICE) are a few KB.
const DEFAULT_MAX_TOPICS_PER_CONN = 64; // SIGNAL_MAX_TOPICS_PER_CONN
const DEFAULT_MAX_TOPIC_LENGTH = 256; // SIGNAL_MAX_TOPIC_LENGTH (chars)
const DEFAULT_MAX_PAYLOAD = 256 * 1024; // SIGNAL_MAX_PAYLOAD (bytes per message)
const DEFAULT_MAX_CONNS_PER_IP = 64; // SIGNAL_MAX_CONNS_PER_IP (offices share one NAT IP)

/**
 * @param {{ port?: number, heartbeatMs?: number, rateLimitMax?: number, maxTopicsPerConn?: number, maxTopicLength?: number, maxPayload?: number, maxConnsPerIp?: number, trustProxy?: boolean }} [opts]
 * @returns {Promise<{ server: http.Server, wss: WebSocket.Server, port: number, topics: Map<string, Set<WebSocket>>, close: () => Promise<void> }>}
 */
function createServer(opts = {}) {
  const port = opts.port ?? Number(process.env.PORT || DEFAULT_PORT);
  const heartbeatMs =
    opts.heartbeatMs ?? Number(process.env.SIGNAL_HEARTBEAT_MS || DEFAULT_HEARTBEAT_MS);
  const rateLimitMax =
    opts.rateLimitMax ?? Number(process.env.SIGNAL_RATE_LIMIT_MAX || DEFAULT_RATE_LIMIT_MAX);
  const maxTopicsPerConn =
    opts.maxTopicsPerConn ?? Number(process.env.SIGNAL_MAX_TOPICS_PER_CONN || DEFAULT_MAX_TOPICS_PER_CONN);
  const maxTopicLength =
    opts.maxTopicLength ?? Number(process.env.SIGNAL_MAX_TOPIC_LENGTH || DEFAULT_MAX_TOPIC_LENGTH);
  const maxPayload = opts.maxPayload ?? Number(process.env.SIGNAL_MAX_PAYLOAD || DEFAULT_MAX_PAYLOAD);
  const maxConnsPerIp =
    opts.maxConnsPerIp ?? Number(process.env.SIGNAL_MAX_CONNS_PER_IP || DEFAULT_MAX_CONNS_PER_IP);
  // Behind a reverse proxy (Fly.io, nginx) every socket comes from the
  // proxy's address, which would make the per-IP limits global. Only trust
  // forwarding headers when told the proxy sets them (SIGNAL_TRUST_PROXY=1).
  const trustProxy = opts.trustProxy ?? process.env.SIGNAL_TRUST_PROXY === "1";
  function clientIp(req) {
    if (trustProxy && req && req.headers) {
      const fly = req.headers["fly-client-ip"];
      if (typeof fly === "string" && fly) return fly.trim();
      const xff = req.headers["x-forwarded-for"];
      if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
    }
    return (req && req.socket && req.socket.remoteAddress) || "unknown";
  }
  /** ip -> open connection count */
  const connsPerIp = new Map();

  /** topic -> Set<ws> */
  const topics = new Map();
  /** ip -> { count, resetAt } */
  const ipMap = new Map();

  function checkRateLimit(ip) {
    const now = Date.now();
    const entry = ipMap.get(ip);
    if (!entry || now > entry.resetAt) {
      ipMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return true;
    }
    entry.count++;
    return entry.count <= rateLimitMax;
  }

  function send(conn, message) {
    if (conn.readyState !== WebSocket.CONNECTING && conn.readyState !== WebSocket.OPEN) {
      conn.close();
      return;
    }
    try {
      conn.send(JSON.stringify(message));
    } catch {
      conn.close();
    }
  }

  /** Returns false (and subscribes nothing) when a cap would be exceeded. */
  function subscribe(conn, topicName) {
    if (typeof topicName !== "string" || topicName.length === 0 || topicName.length > maxTopicLength) {
      return false;
    }
    if (!conn.subscribedTopics.has(topicName) && conn.subscribedTopics.size >= maxTopicsPerConn) {
      return false;
    }
    let subs = topics.get(topicName);
    if (!subs) {
      subs = new Set();
      topics.set(topicName, subs);
    }
    subs.add(conn);
    conn.subscribedTopics.add(topicName);
    return true;
  }

  function unsubscribe(conn, topicName) {
    const subs = topics.get(topicName);
    if (subs) {
      subs.delete(conn);
      if (subs.size === 0) topics.delete(topicName);
    }
    conn.subscribedTopics.delete(topicName);
  }

  const startedAt = Date.now();
  const health = () => ({
    ok: true,
    status: "ok",
    service: "lumen-signal",
    topics: topics.size,
    // Backwards-compatible alias for the old `rooms` field.
    rooms: topics.size,
    clients: wss.clients.size,
    uptime: (Date.now() - startedAt) / 1000,
  });

  // Plan W4.19: the encrypted vault relay, when this server is asked to keep it.
  const vaultRelay = opts.vaultRelay ?? (process.env.VAULT_RELAY === "1" || process.env.VAULT_RELAY_DIR ? require("./vault-relay").createVaultRelay() : null);

  const server = http.createServer((req, res) => {
    if (vaultRelay && vaultRelay.handle(req, res)) return;
    const pathname = (req.url || "/").split("?")[0];
    if (pathname === "/healthz" || pathname === "/health" || pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health()));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });

  const wss = new WebSocket.Server({ server, maxPayload });

  wss.on("connection", (ws, req) => {
    const ip = clientIp(req);
    const open = (connsPerIp.get(ip) || 0) + 1;
    if (open > maxConnsPerIp) {
      ws.close(1008, "Too many connections");
      return;
    }
    connsPerIp.set(ip, open);
    ws.isAlive = true;
    ws.subscribedTopics = new Set();
    /** Legacy `join` room, if any. */
    let legacyRoom = null;
    let closed = false;

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    // Protocol errors (oversized frame, bad UTF-8, …) must not become an
    // unhandled 'error' event — that would crash the whole process. `ws`
    // closes the socket itself (1009 / 1007); just log it.
    ws.on("error", (err) => {
      // No IP address in the log (plan W4.8, PRIVACY.he.md): the per-IP
      // limits keep addresses in memory only.
      log(`socket error: ${err && err.message}`);
    });

    ws.on("message", (raw) => {
      if (closed) return;
      // Any traffic proves liveness.
      ws.isAlive = true;
      if (!checkRateLimit(ip)) {
        send(ws, { type: "error", error: "Rate limit exceeded" });
        ws.close(1008, "Rate limit exceeded");
        return;
      }

      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch (e) {
        log("Parse error", e.message);
        send(ws, { type: "error", error: "Invalid JSON" });
        return;
      }
      if (!message || typeof message.type !== "string") return;

      switch (message.type) {
        case "subscribe": {
          const requested = Array.isArray(message.topics) ? message.topics : [];
          // Look at no more than the cap allows; anything beyond is refused.
          let refused = requested.length > maxTopicsPerConn;
          for (const t of requested.slice(0, maxTopicsPerConn)) {
            if (!subscribe(ws, t)) refused = true;
          }
          if (refused) send(ws, { type: "error", error: "Topic limit exceeded" });
          return;
        }
        case "unsubscribe":
          (Array.isArray(message.topics) ? message.topics : []).forEach((t) => {
            if (typeof t === "string") unsubscribe(ws, t);
          });
          return;
        case "publish": {
          if (!message.topic) return;
          const receivers = topics.get(message.topic);
          if (receivers) {
            message.clients = receivers.size;
            receivers.forEach((receiver) => send(receiver, message));
          }
          return;
        }
        case "ping":
          send(ws, { type: "pong" });
          return;
        case "join": {
          // Legacy protocol.
          if (typeof message.room !== "string" || message.room.length > maxTopicLength) return;
          if (legacyRoom) unsubscribe(ws, legacyRoom);
          legacyRoom = message.room;
          if (!subscribe(ws, legacyRoom)) {
            legacyRoom = null;
            send(ws, { type: "error", error: "Topic limit exceeded" });
            return;
          }
          log(`[${legacyRoom}] Peer joined`);
          send(ws, { type: "joined", room: legacyRoom, peers: topics.get(legacyRoom).size });
          return;
        }
        default: {
          // Legacy relay: forward to the other members of the joined room.
          if (!legacyRoom) return;
          const clients = topics.get(legacyRoom);
          if (!clients) return;
          clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) send(client, message);
          });
        }
      }
    });

    ws.on("close", () => {
      closed = true;
      const left = (connsPerIp.get(ip) || 1) - 1;
      if (left > 0) connsPerIp.set(ip, left);
      else connsPerIp.delete(ip);
      Array.from(ws.subscribedTopics).forEach((t) => unsubscribe(ws, t));
    });
  });

  // ── Heartbeat ──────────────────────────────────────────────────────────
  // Each tick: sockets that haven't answered the previous ping (or sent any
  // message) since the last tick are terminated; the rest get a fresh ping.
  const heartbeat = setInterval(() => {
    // Drop expired rate-limit windows so ipMap can't grow without bound.
    const now = Date.now();
    ipMap.forEach((entry, ip) => {
      if (now > entry.resetAt) ipMap.delete(ip);
    });
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    });
  }, heartbeatMs);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  const close = () =>
    new Promise((resolve) => {
      clearInterval(heartbeat);
      wss.clients.forEach((ws) => ws.terminate());
      wss.close(() => server.close(() => resolve()));
    });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const actualPort = server.address().port;
      resolve({ server, wss, port: actualPort, topics, close });
    });
  });
}

module.exports = { createServer, DEFAULT_PORT, DEFAULT_HEARTBEAT_MS };

if (require.main === module) {
  createServer().then(({ port, close }) => {
    log(`y-webrtc signaling server running on ws://localhost:${port}`);
    log(`Health check: http://localhost:${port}/healthz`);
    const shutdown = (sig) => {
      log(`Received ${sig}, closing…`);
      close().then(() => process.exit(0));
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  });
}
