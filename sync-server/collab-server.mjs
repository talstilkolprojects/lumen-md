/**
 * Lumen persistent collab server on Hocuspocus (MIT) — plan 3.6.
 *
 * Replaces `persistent-server.js` (y-websocket + LevelDB). A room survives
 * every peer leaving: its Yjs state is stored in SQLite and loaded again
 * when someone rejoins. In end-to-end encrypted rooms (every new room) the
 * synced document is ciphertext, so that is all the server ever stores.
 *
 * ── Auth ──────────────────────────────────────────────────────────────────
 *   1. The client opens  ws(s)://<host>/token  and sends {room, key}.
 *      `key` is the operator's access key (COLLAB_ACCESS_KEY; the "Server
 *      access token" field in Collab settings). The server answers
 *      {token, expiresAt}: an HMAC-signed token for that one room, valid
 *      for COLLAB_TOKEN_TTL_S seconds (default 600). WebSocket, not HTTP,
 *      because the app's CSP allows ws:/wss: to any host but not https:.
 *   2. The Hocuspocus connection presents that token; `onAuthenticate`
 *      rejects a bad signature, another room's token or an expired one.
 *   The signing key (COLLAB_TOKEN_SECRET, ≥ 32 chars; random per process
 *   when unset) and the access key stay on the server. Nothing secret is
 *   built into the web app.
 *   Without COLLAB_ACCESS_KEY anyone who knows a room name gets a token —
 *   room names are 128-bit random, so the room name is then the capability.
 *
 * ── Storage ───────────────────────────────────────────────────────────────
 *   COLLAB_DATA_DIR (default ./.collab-data): collab.sqlite plus backups/.
 *   A backup is taken every COLLAB_BACKUP_INTERVAL_MS (default 1 h) and on
 *   shutdown; the newest COLLAB_BACKUP_KEEP (default 24) are kept.
 *   Upgrading from persistent-server.js: rooms in the LevelDB directory
 *   COLLAB_LEGACY_LEVELDB_DIR (the Docker image sets /data/yjs) are imported
 *   once at start, never overwriting a room SQLite already has.
 *
 * ── Health ────────────────────────────────────────────────────────────────
 *   GET /healthz → 200 {"ok":true,"service":"lumen-collab","persistence":"sqlite"}
 *
 *   node sync-server/collab-server.mjs        # PORT=4445 by default
 *   docker compose -f docker/collab.yml up
 */
import { Server } from "@hocuspocus/server";
import { WebSocketServer } from "ws";
import * as Y from "yjs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { openStore } from "./collab/sqliteStore.mjs";
import { importLegacyDir } from "./collab/legacyImport.mjs";
import { DEFAULT_TOKEN_TTL_S, accessKeyOk, issueRoomToken, signingKey, verifyRoomToken } from "./collab/roomToken.mjs";

const ROOM_NAME = /^[\w-]{1,128}$/;

/**
 * Build (not start) a collab server. `listen()` resolves with the bound
 * port; `close()` stores pending documents, takes a backup and closes the
 * database.
 */
export function createCollabServer(opts = {}) {
  const {
    port = 4445,
    host,
    dataDir = resolve(".collab-data"),
    legacyLeveldbDir = "",
    accessKey = "",
    tokenSecret = "",
    tokenTtlS = DEFAULT_TOKEN_TTL_S,
    debounceMs = 2000,
    maxDebounceMs = 10_000,
    backupIntervalMs = 60 * 60 * 1000,
    keepBackups = 24,
    quiet = true,
    log = () => {},
  } = opts;
  const key = signingKey(tokenSecret);
  const store = openStore(dataDir, { keepBackups });
  const tokenWss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  tokenWss.on("connection", (ws) => {
    const done = (msg) => {
      try {
        ws.send(JSON.stringify(msg));
      } finally {
        ws.close(1000);
      }
    };
    const timer = setTimeout(() => ws.terminate(), 5000);
    ws.once("message", (raw) => {
      clearTimeout(timer);
      let req;
      try {
        req = JSON.parse(String(raw));
      } catch {
        return done({ error: "bad-request" });
      }
      if (!req || typeof req.room !== "string" || !ROOM_NAME.test(req.room)) return done({ error: "bad-room" });
      if (!accessKeyOk(req.key, accessKey)) return done({ error: "unauthorized" });
      done(issueRoomToken(key, req.room, { ttlS: tokenTtlS }));
    });
  });

  const server = new Server({
    port,
    ...(host ? { address: host } : {}),
    quiet,
    stopOnSignals: false,
    debounce: debounceMs,
    maxDebounce: maxDebounceMs,
    async onUpgrade({ request, socket, head }) {
      const pathname = (request.url || "/").split("?")[0];
      if (!pathname.endsWith("/token")) return; // also behind a path prefix (wss://host/collab/token)
      tokenWss.handleUpgrade(request, socket, head, (ws) => tokenWss.emit("connection", ws, request));
      // A falsy rejection stops Hocuspocus from handling this upgrade too.
      throw null;
    },
    async onRequest({ request, response }) {
      const pathname = (request.url || "/").split("?")[0];
      // Also behind a path prefix (wss://host/collab → /collab/healthz), like /token.
      if (!/\/health(z)?$/.test(pathname)) return;
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ ok: true, status: "ok", service: "lumen-collab", persistence: "sqlite" }));
      throw null;
    },
    async onAuthenticate({ token, documentName }) {
      if (!ROOM_NAME.test(documentName)) throw new Error("bad-room");
      const why = verifyRoomToken(key, token, documentName);
      if (why) {
        log(`auth rejected (${why})`);
        throw new Error("unauthorized");
      }
    },
    async onLoadDocument({ document, documentName }) {
      const state = store.load(documentName);
      if (state) Y.applyUpdate(document, state);
    },
    async onStoreDocument({ document, documentName }) {
      store.save(documentName, Y.encodeStateAsUpdate(document));
    },
  });

  const backup = () => {
    try {
      const file = store.backup();
      log(`backup ${file}`);
      return file;
    } catch (e) {
      log(`backup failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
  const backupTimer = backupIntervalMs > 0 ? setInterval(backup, backupIntervalMs) : null;
  backupTimer?.unref?.();

  let closing = null;
  return {
    server,
    store,
    backup,
    async listen() {
      // Before accepting connections, so nobody opens an "empty" legacy room.
      if (legacyLeveldbDir) await importLegacyDir(store, legacyLeveldbDir, { log });
      await server.listen();
      return server.address.port;
    },
    close() {
      closing ??= (async () => {
        if (backupTimer) clearInterval(backupTimer);
        for (const c of tokenWss.clients) c.terminate();
        tokenWss.close();
        await server.destroy();
        backup();
        store.close();
      })();
      return closing;
    },
  };
}

function fromEnv(env) {
  const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
  return {
    port: num(env.PORT, 4445),
    host: env.HOST || undefined,
    dataDir: resolve(env.COLLAB_DATA_DIR || ".collab-data"),
    // persistent-server.js used YJS_STORAGE_DIR / LEVELDB_PATH.
    legacyLeveldbDir: env.COLLAB_LEGACY_LEVELDB_DIR || env.YJS_STORAGE_DIR || env.LEVELDB_PATH || "",
    // COLLAB_TOKEN is the access key's older name (T49, persistent-server.js).
    accessKey: env.COLLAB_ACCESS_KEY || env.COLLAB_TOKEN || "",
    tokenSecret: env.COLLAB_TOKEN_SECRET || "",
    tokenTtlS: num(env.COLLAB_TOKEN_TTL_S, DEFAULT_TOKEN_TTL_S),
    debounceMs: num(env.COLLAB_DEBOUNCE_MS, 2000),
    backupIntervalMs: num(env.COLLAB_BACKUP_INTERVAL_MS, 60 * 60 * 1000),
    keepBackups: num(env.COLLAB_BACKUP_KEEP, 24),
    log: (m) => console.log(`[collab] ${m}`),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = fromEnv(process.env);
  const app = createCollabServer(opts);
  const port = await app.listen();
  console.log(`Lumen collab (Hocuspocus) listening on :${port}, data in ${opts.dataDir}`);
  if (!opts.accessKey) console.warn("COLLAB_ACCESS_KEY is not set: anyone who knows a room name can get a token for it.");
  if (!opts.tokenSecret) console.warn("COLLAB_TOKEN_SECRET is not set: a random key is used; tokens end with this process.");
  const stop = (signal) => {
    console.log(`${signal}: storing documents and taking a backup…`);
    app.close().then(
      () => process.exit(0),
      (e) => {
        console.error(e);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}
