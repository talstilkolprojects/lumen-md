import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import type { Awareness } from "y-protocols/awareness";
import { randomChoice, randomId, randomInt } from "../lib/cryptoRandom";
import { log } from "../lib/logger";
import { effectiveCapabilities, entitlementResolved, waitForEntitlement } from "../billing/gates";
import { wireE2E, type E2EChannel, type E2EErrorReason } from "./e2e";
import { getSecret } from "../lib/secretStore";

export interface CollabUser {
  name: string;
  color: string;
  colorLight: string;
}

/**
 * Lightweight `WebsocketProvider`-shaped contract — we declare this locally so
 * the optional `y-websocket` package doesn't have to be bundled for users on
 * the WebRTC-only path.
 */
/**
 * How long join-time seeding waits for a configured persistent server to
 * deliver the room's history before falling back to WebRTC-only seeding
 * (server offline / unreachable).
 */
export const PERSISTENT_SYNC_TIMEOUT_MS = 8000;

interface WebsocketLike {
  destroy(): void;
  /** y-websocket: true once the server's state has been applied. */
  synced?: boolean;
  on?(event: "sync", fn: (isSynced: boolean) => void): void;
  off?(event: "sync", fn: (isSynced: boolean) => void): void;
}

export interface CollabSession {
  /**
   * The document the editor binds to. In password-protected rooms this doc
   * is local-only — providers sync `transportDoc` (ciphertext) instead.
   */
  doc: Y.Doc;
  /**
   * The doc attached to the network providers when the room is end-to-end
   * encrypted; null for plain (non-password) rooms, where `doc` itself is
   * what the providers sync.
   */
  transportDoc: Y.Doc | null;
  /** True when the room password is set and the E2E transport is active. */
  encrypted: boolean;
  ytext: Y.Text;
  awareness: Awareness;
  provider: WebrtcProvider;
  /** Optional persistent provider (y-websocket) — null on WebRTC-only sessions. */
  websocketProvider: WebsocketLike | null;
  roomName: string;
  /**
   * The room-specific password a share link carries (the one generated for
   * a new room, or the one from the join link) — never a stored default
   * password. null when the room has none.
   */
  sharePassword: string | null;
  user: CollabUser;
  /** Tear down providers + free Yjs structures. */
  destroy: () => void;
}

/**
 * Default signaling-server endpoints. Order matters — the first entry is
 * tried first; the rest are used only if it fails. `signal.lumen.md` is
 * Lumen's own deployed service (`sync-server/`); the public yjs.dev
 * endpoints are kept as last-resort fallbacks for users running off-cluster.
 *
 * Override at runtime via `localStorage["lumen.collab.signaling"]` or the
 * `VITE_WEBRTC_SIGNALING_URL` env var (single URL or comma-separated list).
 */
const PUBLIC_SIGNALING_FALLBACK = [
  "wss://signal.lumen.md",
  "wss://signaling.yjs.dev",
  "wss://y-webrtc-signaling-eu.herokuapp.com",
];

const getSignalingUrls = (): string[] => {
  const custom = typeof localStorage !== "undefined"
    ? localStorage.getItem("lumen.collab.signaling")
    : null;
  const envUrl = typeof import.meta !== "undefined"
    ? (import.meta as ImportMeta & { env?: { VITE_WEBRTC_SIGNALING_URL?: string } }).env?.VITE_WEBRTC_SIGNALING_URL
    : undefined;
  const configured = (custom || envUrl || "").split(",").map((s) => s.trim()).filter(Boolean);
  // T49: by default only the configured / the project's own signaling
  // server. The public third-party servers (yjs.dev, heroku) see who meets
  // whom, so they are used only when the user opts in (Collab settings) —
  // then also as a fallback behind a custom server.
  const primary = configured.length ? configured : PUBLIC_SIGNALING_FALLBACK.slice(0, 1);
  if (!publicSignalingAllowed()) return primary;
  return [...new Set([...primary, ...PUBLIC_SIGNALING_FALLBACK.slice(1)])];
};

export const PUBLIC_SIGNALING_KEY = "lumen.collab.publicSignaling";

function publicSignalingAllowed(): boolean {
  try {
    return localStorage.getItem(PUBLIC_SIGNALING_KEY) === "1";
  } catch {
    return false;
  }
}

/** Exported for tests: the signaling list the next session will use. */
export function signalingUrls(): string[] {
  return getSignalingUrls();
}

const NAMES = [
  "Aurora",
  "Blaze",
  "Cascade",
  "Cinder",
  "Comet",
  "Echo",
  "Ember",
  "Glacier",
  "Halcyon",
  "Indigo",
  "Lumen",
  "Marble",
  "Nimbus",
  "Onyx",
  "Pegasus",
  "Quartz",
  "Rune",
  "Saffron",
  "Tempest",
  "Vesper",
  "Willow",
  "Zephyr",
];

function randomUser(): CollabUser {
  const name = randomChoice(NAMES);
  const hue = randomInt(360);
  return {
    name,
    color: `hsl(${hue} 70% 55%)`,
    colorLight: `hsl(${hue} 70% 85%)`,
  };
}

/** Generate a fresh, friendly room name. */
/**
 * A new room's name: 128 random bits (T49). The name is the room's address
 * on the signaling and persistence servers, so it must not be guessable —
 * the old "lumen-calm-river-42" had about 13 bits.
 */
export function makeRoomName(): string {
  return `lumen-${randomId(16)}`;
}

/** A fresh room password: 128 random bits, URL-safe (T49). */
export function makeRoomPassword(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * How long a joining peer waits for y-webrtc's `synced` event before
 * deciding it is alone and seeding its local content.
 */
export const SEED_FALLBACK_MS = 1500;

/**
 * Optional persistent collab WebSocket URL (y-websocket compatible), as
 * configured — before the plan check (see `connectCollab`).
 */
function configuredWebsocketUrl(): string | null {
  const fromStorage =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("lumen.collab.ws")
      : null;
  if (fromStorage) return fromStorage;
  const envUrl =
    typeof import.meta !== "undefined"
      ? (import.meta as ImportMeta & { env?: { VITE_YJS_WEBSOCKET_URL?: string } })
          .env?.VITE_YJS_WEBSOCKET_URL
      : undefined;
  // An empty build arg (Docker compose with LUMEN_COLLAB_URL unset) means "none".
  return envUrl?.trim() || null;
}

function configuredWebsocketToken(): string {
  const env = typeof import.meta !== "undefined"
    // hygiene-allow: build-time collab token; #237 (plan 3.6) removes it with the room-token server
    ? (import.meta as ImportMeta & { env?: { VITE_YJS_WEBSOCKET_TOKEN?: string } }).env?.VITE_YJS_WEBSOCKET_TOKEN
    : undefined;
  return env?.trim() ?? "";
}

/**
 * Best-effort attach of a persistent y-websocket provider in the background.
 * The package is dynamically imported so a build without it never pays the
 * bundle cost. Failures are swallowed — the session still works over WebRTC.
 */
async function attachWebsocketProvider(
  url: string,
  roomName: string,
  doc: Y.Doc,
): Promise<WebsocketLike | null> {
  try {
    // Static-string dynamic import so vi.mock("y-websocket") resolves
    // here in tests. The previous indirection-via-variable defeated
    // the mock graph. Vite's import-analysis plugin would try to
    // resolve this at dev-server start, which crashes when the user
    // hasn't installed the package — so vite.config.ts adds a
    // resolve.alias mapping "y-websocket" → the test stub so the
    // analyzer always finds *something*. The try/catch handles any
    // runtime failure regardless.
    const mod = (await import("y-websocket")) as unknown as {
      WebsocketProvider: new (
        url: string,
        room: string,
        doc: Y.Doc,
        opts?: Record<string, unknown>,
      ) => WebsocketLike;
    };
    // A persistent server started with COLLAB_TOKEN only accepts clients
    // that present it (T49); the token is kept in the secret store.
    const token = getSecret("lumen.collab.wsToken") || configuredWebsocketToken();
    return new mod.WebsocketProvider(url, roomName, doc, { connect: true, ...(token ? { params: { token } } : {}) });
  } catch (err) {
    log.warn("y-websocket attach failed", err);
    return null;
  }
}

/**
 * Read the optional room password from `localStorage["lumen.collab.password"]`
 * or `?password=…` in the URL hash. When present, the editor's doc stays
 * local and only AES-GCM ciphertext envelopes are handed to the providers
 * (see `./e2e.ts`) — the WebRTC mesh, signaling servers and the optional
 * y-websocket server never see document content (P3-13).
 */
function hashRoomPassword(): string | null {
  if (typeof location === "undefined") return null;
  const m = location.hash.match(/[#&]password=([^&]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function getRoomPassword(): string | null {
  // The share link's password is specific to its room: it wins over a
  // stored default left from another session.
  const fromLink = hashRoomPassword();
  if (fromLink) return fromLink;
  if (typeof localStorage !== "undefined") {
    const stored = getSecret("lumen.collab.password");
    if (stored) return stored;
  }
  return null;
}

/**
 * Connect to (or create) a collaborative editing session over WebRTC.
 * When the local doc is empty and we are the first peer, the provided
 * `seedContent` is inserted so other peers can pick it up.
 */
export function connectCollab(
  roomName: string,
  seedContent: string,
  opts: {
    password?: string | null;
    isNewRoom?: boolean;
    /** Called once if an incoming encrypted update can't be decrypted. */
    onE2EError?: (reason: E2EErrorReason) => void;
    /**
     * Joining a password room and nobody answered. With encrypted signaling
     * a wrong password looks exactly like an empty room, so the local
     * document is NOT seeded automatically (that would fork the room under
     * its name). The callback gets `share()`, which seeds it on request.
     */
    onEncryptedRoomEmpty?: (share: () => void) => void;
  } = {},
): CollabSession {
  const doc = new Y.Doc();
  const ytext = doc.getText("lumen");

  const password = opts.password ?? getRoomPassword();
  const sharePassword = opts.password ?? hashRoomPassword();

  // E2E: with a room password, `doc` (plaintext) is never attached to a
  // provider. A separate transport doc carrying only ciphertext envelopes
  // is synced instead. Without a password, `doc` is synced directly.
  let transportDoc: Y.Doc | null = null;
  let e2e: E2EChannel | null = null;
  if (password) {
    transportDoc = new Y.Doc();
    // Share the client id so awareness (which borrows the synced doc's id)
    // and `snapshotPeers`' self-detection line up with the plaintext doc
    // the editor's relative cursor positions refer to.
    transportDoc.clientID = doc.clientID;
    e2e = wireE2E(doc, transportDoc, {
      password,
      room: roomName,
      onDecryptError: (reason) => {
        log.warn("collab e2e: could not decrypt incoming update", reason);
        opts.onE2EError?.(reason);
      },
    });
  }
  const syncedDoc = transportDoc ?? doc;

  // Public rooms only — obscure name suffices for casual pair editing. Users
  // wanting more privacy should set a room password and/or run their own
  // signaling server.
  // In password rooms the password is also handed to y-webrtc, which then
  // encrypts every signaling and BroadcastChannel message with a key derived
  // from it. A peer without the password can't complete the WebRTC
  // handshake, so presence (names, colours, cursors) only ever reaches
  // peers that hold the password; the signaling server sees ciphertext.
  const provider = new WebrtcProvider(roomName, syncedDoc, {
    signaling: getSignalingUrls(),
    maxConns: 20,
    ...(password ? { password } : {}),
  });

  // If a persistent server is configured, attach a WebsocketProvider in the
  // background. It syncs the same doc as WebRTC (the ciphertext transport
  // doc in password rooms, so the server only ever stores ciphertext) and
  // lets late joiners see history even when no other peer is online.
  // A persistent server is a plan capability, re-checked for every session
  // so a URL saved while entitled stops being used after a downgrade. While
  // the entitlement is still loading its placeholder is FREE_CAPS, so a
  // paid user's decision waits for the real plan (bounded) instead.
  const wsUrl = configuredWebsocketUrl();
  let websocketProvider: WebsocketLike | null = null;
  // While a persistent server is configured but hasn't delivered its state,
  // the room may hold history that no WebRTC peer has — seeding then would
  // merge the local document into it. Seeding waits for this to settle.
  let persistent: "none" | "pending" | "ready" = wsUrl ? "pending" : "none";
  let onPersistentSettled: (() => void) | null = null;
  const settlePersistent = (state: "none" | "ready") => {
    if (persistent !== "pending") return;
    persistent = state;
    onPersistentSettled?.();
  };
  const startPersistent = (url: string) => {
    void attachWebsocketProvider(url, roomName, syncedDoc).then((p) => {
      if (destroyed) {
        p?.destroy();
        return;
      }
      websocketProvider = p;
      if (!p) return settlePersistent("none"); // package missing / attach failed
      if (p.synced || typeof p.on !== "function") return settlePersistent("ready");
      // An unreachable server never emits `sync`: bound the wait, and give up
      // early on a connection error, then fall back to WebRTC-only seeding.
      let giveUp: ReturnType<typeof setTimeout> | null = null;
      const finish = (state: "none" | "ready") => {
        if (giveUp) clearTimeout(giveUp);
        giveUp = null;
        p.off?.("sync", onSync);
        p.off?.("connection-error" as "sync", onError);
        if (state === "none") {
          // Declared unavailable: tear it down. y-websocket reconnects on its
          // own, and a later reconnect would merge the server's history into
          // a document we may now seed — two independent docs, corrupted room.
          // This session continues WebRTC-only.
          try {
            p.destroy();
          } catch {
            /* already gone */
          }
          if (websocketProvider === p) websocketProvider = null;
        }
        settlePersistent(state);
      };
      const onSync = (isSynced: boolean) => {
        if (isSynced) finish("ready");
      };
      const onError = () => finish("none");
      p.on("sync", onSync);
      p.on("connection-error" as "sync", onError);
      giveUp = setTimeout(() => finish("none"), PERSISTENT_SYNC_TIMEOUT_MS);
    });
  };
  if (wsUrl) {
    if (entitlementResolved()) {
      if (effectiveCapabilities().persistentCollab) startPersistent(wsUrl);
      else persistent = "none";
    } else {
      void waitForEntitlement(PERSISTENT_SYNC_TIMEOUT_MS).then(() => {
        if (destroyed) return;
        if (effectiveCapabilities().persistentCollab) startPersistent(wsUrl);
        else settlePersistent("none");
      });
    }
  }

  // Seed initial content only when we know we're the only one in the room.
  let seedTimer: ReturnType<typeof setTimeout> | null = null;
  let onSynced: ((e: { synced: boolean }) => void) | null = null;
  let destroyed = false;
  const stopSeedWait = () => {
    if (seedTimer) {
      clearTimeout(seedTimer);
      seedTimer = null;
    }
    if (onSynced) {
      try {
        provider.off("synced", onSynced);
      } catch {
        /* */
      }
      onSynced = null;
    }
  };
  if (opts.isNewRoom && seedContent && ytext.length === 0) {
    // New room created by this peer: seed synchronously so the editor's
    // char-level Yjs binding (y-codemirror `ySync`) has content to bind to.
    // A delayed seed would let the binding momentarily clear the editor.
    ytext.insert(0, seedContent);
  } else if (seedContent) {
    // Joining (or unknown): never clobber an existing room. y-webrtc emits
    // `synced` once every connected peer has delivered its state; at that
    // point the doc reflects the room and we decide once. If no peer ever
    // shows up, `synced` never fires, so a fallback timer covers the
    // "first one here" case.
    const isAlone = () => {
      const room = (provider as unknown as {
        room?: { webrtcConns?: Map<unknown, unknown> } | null;
      }).room;
      const conns = room?.webrtcConns?.size ?? 0;
      return conns === 0 && provider.awareness.getStates().size <= 1;
    };
    const maybeSeed = () => {
      if (persistent === "pending") {
        // Decide once the persistent server has answered (its history may
        // be the room's only copy).
        onPersistentSettled = maybeSeed;
        return;
      }
      onPersistentSettled = null;
      // In E2E rooms ciphertext may have arrived but not finished
      // decrypting -- treat any envelope as "room has content".
      const envelopesPending = (e2e?.envelopeCount() ?? 0) > 0;
      const canSeed = () =>
        !destroyed && ytext.length === 0 && isAlone() && (e2e?.envelopeCount() ?? 0) === 0;
      if (!canSeed() || envelopesPending) return;
      if (e2e) {
        // Encrypted join: an empty room and a mistyped password can't be
        // told apart — ask instead of forking.
        opts.onEncryptedRoomEmpty?.(() => {
          if (canSeed()) ytext.insert(0, seedContent);
        });
        return;
      }
      ytext.insert(0, seedContent);
    };
    onSynced = ({ synced }) => {
      if (!synced) return;
      stopSeedWait();
      maybeSeed();
    };
    provider.on("synced", onSynced);
    seedTimer = setTimeout(() => {
      seedTimer = null;
      if (destroyed) return;
      if (isAlone()) {
        stopSeedWait();
        maybeSeed();
      }
      // Otherwise peers are connected but still syncing: keep waiting for
      // `synced`, which decides once their state has arrived.
    }, SEED_FALLBACK_MS);
  }

  const user = randomUser();
  provider.awareness.setLocalStateField("user", user);

  // Wire version-history snapshots (5-min interval during collab).
  let stopSnapshots: (() => void) | null = null;
  import("./versionHistory").then(({ startSnapshotInterval }) => {
    stopSnapshots = startSnapshotInterval(
      roomName,
      () => ytext.toString(),
      () => ({ name: user.name, clientId: doc.clientID }),
    );
  }).catch(() => {});

  return {
    doc,
    transportDoc,
    encrypted: transportDoc !== null,
    ytext,
    awareness: provider.awareness,
    provider,
    get websocketProvider() {
      return websocketProvider;
    },
    roomName,
    sharePassword,
    user,
    destroy() {
      destroyed = true;
      onPersistentSettled = null;
      stopSeedWait();
      if (stopSnapshots) {
        stopSnapshots();
        stopSnapshots = null;
      }
      e2e?.destroy();
      try {
        provider.destroy();
      } catch {
        /* */
      }
      try {
        websocketProvider?.destroy();
      } catch {
        /* */
      }
      try {
        doc.destroy();
        transportDoc?.destroy();
      } catch {
        /* */
      }
    },
  };
}

// URL-hash helpers live in ./roomUrl (yjs-free) so the boot path can read
// `#room=` without pulling this module's yjs/y-webrtc stack; re-exported here
// for existing importers.
export { readRoomFromHash, setRoomInHash } from "./roomUrl";

/** Pull a friendly snapshot of current peers from the awareness state. */
export interface CollabPeer {
  clientId: number;
  user: CollabUser;
  isSelf: boolean;
}

export function snapshotPeers(session: CollabSession): CollabPeer[] {
  const states = session.awareness.getStates();
  const out: CollabPeer[] = [];
  const selfId = session.doc.clientID;
  states.forEach((state, clientId) => {
    const user = state?.user as CollabUser | undefined;
    if (!user) return;
    out.push({ clientId, user, isSelf: clientId === selfId });
  });
  // self first, others after, stable order
  out.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.clientId - b.clientId);
  return out;
}
