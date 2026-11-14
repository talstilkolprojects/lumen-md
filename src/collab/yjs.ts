import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import { Awareness } from "y-protocols/awareness";
import { randomChoice, randomId, randomInt } from "../lib/cryptoRandom";
import { log } from "../lib/logger";
import { effectiveCapabilities, entitlementResolved, waitForEntitlement } from "../billing/gates";
import { wireE2E, type E2EChannel, type E2EErrorReason } from "./e2e";
import { wireE2EAwareness, type AwarenessLike, type E2EAwarenessBridge } from "./e2eAwareness";
import { getSecret } from "../lib/secretStore";
import { connectAllowedByCsp, isIpv6LiteralUrl } from "../lib/cspConnect";
import { canComment, canEdit, commentsDocName, isServerOnly, readShareFromHash, type Role } from "./sharing";
import type { PersistentOptions } from "./persistentProvider";

export interface CollabUser {
  name: string;
  color: string;
  colorLight: string;
}

/**
 * The persistent provider's contract (see `persistentProvider.ts`), declared
 * here so this module does not import the provider package eagerly.
 */
/**
 * How long join-time seeding waits for a configured persistent server to
 * deliver the room's history before falling back to WebRTC-only seeding
 * (server offline / unreachable).
 */
export const PERSISTENT_SYNC_TIMEOUT_MS = 8000;

interface WebsocketLike {
  destroy(): void;
  /** True once the server's state has been applied. */
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
  /**
   * Presence (names, colours, cursors) as the editor sees it. In password
   * rooms this one is local too: the providers sync a transport awareness
   * whose states are sealed under the room key (plan W2.20, `./e2eAwareness.ts`).
   */
  awareness: Awareness;
  provider: WebrtcProvider;
  /** Optional persistent provider (Hocuspocus) — null on WebRTC-only sessions. */
  websocketProvider: WebsocketLike | null;
  roomName: string;
  /**
   * The room-specific password a share link carries (the one generated for
   * a new room, or the one from the join link) — never a stored default
   * password. null when the room has none.
   */
  sharePassword: string | null;
  user: CollabUser;
  /**
   * Plan W1.19: the room's comment threads, a document of their own
   * (`<room>~comments` on the server) so the server can let "comment"
   * participants write comments but not the note. Anchors still point into
   * `ytext`. Encrypted like the note in password rooms.
   */
  commentsDoc: Y.Doc;
  /** The share link this session was opened from, or null. */
  share: string | null;
  /** Synced through the server only (a room with share links): no WebRTC mesh. */
  serverOnly: boolean;
  /** This participant's role: "edit" until the server says otherwise; "view" until then for a share link. */
  role(): Role;
  canEdit(): boolean;
  canComment(): boolean;
  /** Called when the server grants a different role. Returns the unsubscribe function. */
  onRoleChange(fn: (role: Role) => void): () => void;
  /** Tear down providers + free Yjs structures. */
  destroy: () => void;
}

/**
 * Public signaling endpoints, used only when the user opts in (Collab
 * settings). There is no built-in default server: a deployment sets its own
 * (`sync-server/`) with `VITE_WEBRTC_SIGNALING_URL` at build time, and a user
 * can point at one in settings. A hard-coded host the project doesn't
 * control would see every room and peer, so none is shipped.
 *
 * Override at runtime via `localStorage["lumen.collab.signaling"]` or the
 * `VITE_WEBRTC_SIGNALING_URL` env var (single URL or comma-separated list).
 */
// Plan W4.15: the Heroku server (y-webrtc-signaling-eu.herokuapp.com) is
// gone — Heroku ended free dynos in November 2022, and y-webrtc itself (the
// 10.3.0 in package-lock.json) replaced it with y-webrtc-eu.fly.dev as its
// default `signaling`. That is the second public server now.
const PUBLIC_SIGNALING_FALLBACK = [
  "wss://signaling.yjs.dev",
  "wss://y-webrtc-eu.fly.dev",
];

const getSignalingUrls = (): string[] => {
  const custom = typeof localStorage !== "undefined"
    ? localStorage.getItem("lumen.collab.signaling")
    : null;
  const envUrl = typeof import.meta !== "undefined"
    ? (import.meta as ImportMeta & { env?: { VITE_WEBRTC_SIGNALING_URL?: string } }).env?.VITE_WEBRTC_SIGNALING_URL
    : undefined;
  const listed = (custom || envUrl || "").split(",").map((s) => s.trim()).filter(Boolean);
  // Plan 2.2: connect-src names its WebSocket hosts (no bare wss:). A server
  // set at runtime that this deployment's policy does not list would only
  // be blocked by the browser; skip it with a reason (Collab settings warns
  // when it is entered). Build-time URLs are in the policy already, except
  // IPv6 literals, which no CSP can name (the build warns about those).
  const configured = listed.filter((u) => connectAllowedByCsp(u));
  for (const u of listed.filter((x) => !configured.includes(x))) {
    log.warn(`Collab signaling ${u} skipped: ${cspAdvice(u, "VITE_WEBRTC_SIGNALING_URL")}`);
  }
  // T49: by default only the configured signaling server (none when the
  // build sets none). The public third-party servers (yjs.dev, fly.dev) see
  // who meets whom, so they are used only when the user opts in (Collab
  // settings) — then also as a fallback behind a custom server.
  if (!publicSignalingAllowed()) return configured;
  return [...new Set([...configured, ...PUBLIC_SIGNALING_FALLBACK])];
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
 * Optional persistent collab server URL (Hocuspocus, sync-server/collab-server.mjs), as
 * configured — before the plan check (see `connectCollab`).
 */
/** Why the page's CSP blocks a collab server URL, and what to do about it. */
function cspAdvice(url: string, envVar: string): string {
  if (isIpv6LiteralUrl(url)) return "a CSP can't name an IPv6 address, so the browser would block it. Give the server a hostname.";
  return `it isn't in this deployment's CSP connect-src. Add its origin with VITE_CSP_CONNECT_EXTRA (or ${envVar}) at build time.`;
}

function configuredWebsocketUrl(): string | null {
  const fromStorage =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("lumen.collab.ws")
      : null;
  if (fromStorage) {
    // As for signaling (plan 2.2): a runtime URL the policy blocks is skipped.
    if (connectAllowedByCsp(fromStorage)) return fromStorage;
    log.warn(`Persistent collab server ${fromStorage} not used: ${cspAdvice(fromStorage, "VITE_YJS_WEBSOCKET_URL")}`);
    return null;
  }
  const envUrl =
    typeof import.meta !== "undefined"
      ? (import.meta as ImportMeta & { env?: { VITE_YJS_WEBSOCKET_URL?: string } })
          .env?.VITE_YJS_WEBSOCKET_URL
      : undefined;
  // An empty build arg (Docker compose with LUMEN_COLLAB_URL unset) means "none".
  return envUrl?.trim() || null;
}

/**
 * Best-effort attach of the persistent collab provider (Hocuspocus, plan
 * 3.6) in the background. The provider package is dynamically imported so
 * a session without a server never pays its bundle cost. Failures are
 * swallowed — the session still works over WebRTC.
 */
async function attachWebsocketProvider(
  url: string,
  roomName: string,
  doc: Y.Doc,
  popts: PersistentOptions = {},
): Promise<WebsocketLike | null> {
  try {
    const { createPersistentProvider } = await import("./persistentProvider");
    // The server's optional access key (Collab settings → "Server access
    // token"), kept in the secret store. It only buys a short-lived token
    // for this room; there is no build-time token (no secret in the bundle).
    // The room password proves to the public server that this person holds the room (review 2).
    return await createPersistentProvider(url, roomName, doc, getSecret("lumen.collab.wsToken"), popts);
  } catch (err) {
    log.warn("persistent collab attach failed", err);
    return null;
  }
}

/**
 * Read the optional room password from `localStorage["lumen.collab.password"]`
 * or `?password=…` in the URL hash. When present, the editor's doc stays
 * local and only AES-GCM ciphertext envelopes are handed to the providers
 * (see `./e2e.ts`) — the WebRTC mesh, signaling servers and the optional
 * persistent server never see document content (P3-13).
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
    /** The share link's id (default: `share=` in the URL hash). */
    share?: string | null;
  } = {},
): CollabSession {
  const doc = new Y.Doc();
  const ytext = doc.getText("lumen");
  const share = opts.share === undefined ? readShareFromHash() : opts.share;
  // Plan W1.19: a share-link session sees the note read-only until the server grants more.
  let role: Role = share ? "view" : "edit";
  const roleListeners = new Set<(r: Role) => void>();
  const setRole = (r: Role) => {
    if (r === role) return;
    role = r;
    for (const l of [...roleListeners]) l(r);
  };

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

  // Plan W2.20: presence is end-to-end encrypted like the document. The
  // editor binds to `plainAwareness`; the providers only ever see
  // `transportAwareness`, whose states are `{ e2e: <sealed> }`.
  let plainAwareness: Awareness | null = null;
  let transportAwareness: Awareness | null = null;
  let awarenessBridge: E2EAwarenessBridge | null = null;
  if (password && transportDoc) {
    plainAwareness = new Awareness(doc);
    transportAwareness = new Awareness(transportDoc);
    awarenessBridge = wireE2EAwareness(plainAwareness as unknown as AwarenessLike, transportAwareness as unknown as AwarenessLike, {
      password,
      room: roomName,
      onDecryptError: (reason) => log.warn("collab e2e: could not open a participant's presence", reason),
    });
  }

  // A room with share links syncs through the server only: the server holds
  // every participant to their role, a WebRTC mesh could not (plan W1.19).
  const serverOnly = isServerOnly(roomName, share) && !!configuredWebsocketUrl();

  // There, comment threads live in a document of their own, encrypted the
  // same way, so "comment" participants can write comments but not the note.
  // Rooms without share links keep them in the note's document, as before.
  const commentsDoc = serverOnly ? new Y.Doc() : doc;
  if (serverOnly) commentsDoc.clientID = doc.clientID;
  let commentsTransport: Y.Doc | null = null;
  let commentsE2e: E2EChannel | null = null;
  if (password && serverOnly) {
    commentsTransport = new Y.Doc();
    commentsTransport.clientID = doc.clientID;
    commentsE2e = wireE2E(commentsDoc, commentsTransport, {
      password,
      room: commentsDocName(roomName),
      onDecryptError: (reason) => log.warn("collab e2e: could not decrypt a comments update", reason),
    });
  }
  const commentsSynced = commentsTransport ?? commentsDoc;

  // Public rooms only — obscure name suffices for casual pair editing. Users
  // wanting more privacy should set a room password and/or run their own
  // signaling server.
  // In password rooms the password is also handed to y-webrtc, which then
  // encrypts every signaling and BroadcastChannel message with a key derived
  // from it. A peer without the password can't complete the WebRTC
  // handshake, so presence (names, colours, cursors) only ever reaches
  // peers that hold the password; the signaling server sees ciphertext.
  const provider = new WebrtcProvider(roomName, syncedDoc, {
    signaling: serverOnly ? [] : getSignalingUrls(),
    maxConns: 20,
    ...(password ? { password } : {}),
    ...(transportAwareness ? { awareness: transportAwareness } : {}),
  });
  const awareness = plainAwareness ?? provider.awareness;
  let commentsWebsocket: WebsocketLike | null = null;

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
    if (serverOnly) {
      void attachWebsocketProvider(url, roomName, commentsSynced, { share, docName: commentsDocName(roomName), e2ee: !!password, password }).then((p) => {
        if (destroyed) p?.destroy();
        else commentsWebsocket = p;
      });
    }
    void attachWebsocketProvider(url, roomName, syncedDoc, { share, onRole: setRole, e2ee: !!password, password, ...(serverOnly ? { awareness: transportAwareness ?? provider.awareness } : transportAwareness ? { awareness: transportAwareness } : {}) }).then((p) => {
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
          // Declared unavailable: tear it down. The provider reconnects on its
          // own, and a later reconnect would merge the server's history into
          // a document we may now seed — two independent docs, corrupted room.
          // This session continues WebRTC-only.
          try {
            p.destroy();
          } catch {
            /* why: already gone */
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
        /* why: the provider may already have dropped its listeners on disconnect */
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
  awareness.setLocalStateField("user", user);

  // Comments made before the room had share links live in the note's
  // document: in a server-only room an editor moves them into the comments
  // document once (anchors point into the note, so they move as they are).
  const legacy = doc.getMap("lumen-comments");
  const migrateLegacyComments = () => {
    if (destroyed || commentsDoc === doc || !canEdit(role) || legacy.size === 0) return;
    const target = commentsDoc.getMap("lumen-comments");
    commentsDoc.transact(() => {
      legacy.forEach((v, k) => {
        if (!target.has(k)) target.set(k, v);
      });
    });
    doc.transact(() => {
      for (const k of [...legacy.keys()]) legacy.delete(k);
    });
  };
  legacy.observe(migrateLegacyComments);
  roleListeners.add(migrateLegacyComments);

  // Wire version-history snapshots (5-min interval during collab).
  let stopSnapshots: (() => void) | null = null;
  import("./versionHistory").then(({ startSnapshotInterval }) => {
    stopSnapshots = startSnapshotInterval(
      roomName,
      () => ytext.toString(),
      () => ({ name: user.name, clientId: doc.clientID }),
    );
  }).catch((e) => log.warn("collab: version-history snapshots could not start", e));

  return {
    doc,
    transportDoc,
    encrypted: transportDoc !== null,
    ytext,
    awareness,
    provider,
    get websocketProvider() {
      return websocketProvider;
    },
    roomName,
    sharePassword,
    user,
    commentsDoc,
    share,
    serverOnly,
    role: () => role,
    canEdit: () => canEdit(role),
    canComment: () => canComment(role),
    onRoleChange(fn) {
      roleListeners.add(fn);
      return () => roleListeners.delete(fn);
    },
    destroy() {
      destroyed = true;
      roleListeners.clear();
      legacy.unobserve(migrateLegacyComments);
      commentsE2e?.destroy();
      try {
        commentsWebsocket?.destroy();
        if (commentsDoc !== doc) commentsDoc.destroy();
        commentsTransport?.destroy();
      } catch {
        /* */
      }
      onPersistentSettled = null;
      stopSeedWait();
      if (stopSnapshots) {
        stopSnapshots();
        stopSnapshots = null;
      }
      e2e?.destroy();
      awarenessBridge?.destroy();
      try {
        provider.destroy();
      } catch {
        /* why: teardown is best effort; one failure must not keep the doc or socket open */
      }
      try {
        websocketProvider?.destroy();
      } catch {
        /* why: teardown is best effort; one failure must not keep the doc or socket open */
      }
      // After the providers, which still announce this participant's departure.
      try {
        plainAwareness?.destroy();
        transportAwareness?.destroy();
      } catch {
        /* */
      }
      try {
        doc.destroy();
        transportDoc?.destroy();
      } catch {
        /* why: teardown is best effort; one failure must not keep the doc or socket open */
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
