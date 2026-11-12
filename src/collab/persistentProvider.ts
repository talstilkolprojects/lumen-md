/**
 * The persistent collab provider (plan 3.6): a Hocuspocus connection to
 * `sync-server/collab-server.mjs`, adapted to the small `sync` /
 * `connection-error` surface that `connectCollab` waits on.
 *
 * Every (re)connect asks the server for a fresh short-lived room token;
 * nothing secret is built into the app. Plan W1.19: the token is bought
 * with the session's share link when it has one (else the owner secret and
 * the operator's access key), the server answers with the role it granted
 * (`onRole`), and `docName` opens a room's comments document.
 */
import type * as Y from "yjs";
import { isRole, tokenPayload, tokenRequest, type Role } from "./sharing";
import { RoomTokenError } from "./roomToken";

type SyncListener = (isSynced: boolean) => void;

export interface PersistentProvider {
  destroy(): void;
  /** True once the server's state for the room has been applied. */
  readonly synced: boolean;
  on(event: "sync" | "connection-error", fn: SyncListener): void;
  off(event: "sync" | "connection-error", fn: SyncListener): void;
}

interface HocuspocusLike {
  readonly synced?: boolean;
  isSynced?: boolean;
  on(event: string, fn: (data: unknown) => void): unknown;
  off?(event: string, fn: (data: unknown) => void): unknown;
  destroy(): void;
}

export interface PersistentOptions {
  /** The share link's id when the session was opened from one. */
  share?: string | null;
  /** The server document (default: the room itself; `<room>~comments` for comments). */
  docName?: string;
  /** Share presence with another provider (server-only rooms have no WebRTC awareness of their own). */
  awareness?: unknown;
  /** The role the server granted with each token. */
  onRole?: (role: Role) => void;
  /** The session is end-to-end encrypted: ask the server to seal the room (plan W2.20). */
  e2ee?: boolean;
  /** The room's password (review 2, #469): the public server's token needs the room proof derived from it. */
  password?: string | null;
}

/**
 * The room's socket URL: the server URL with `?room=<name>` (plan W4.8).
 * The public server on Cloudflare starts one Durable Object per room and
 * needs the room before the first message; the Node server ignores it.
 */
export function roomSocketUrl(serverUrl: string, roomName: string): string {
  const u = new URL(serverUrl);
  u.searchParams.set("room", roomName);
  return u.toString();
}

export async function createPersistentProvider(
  url: string,
  roomName: string,
  doc: Y.Doc,
  accessKey: string | null,
  opts: PersistentOptions = {},
): Promise<PersistentProvider> {
  const mod = (await import("@hocuspocus/provider")) as unknown as {
    HocuspocusProvider: new (cfg: Record<string, unknown>) => HocuspocusLike;
  };
  const listeners = { sync: new Set<SyncListener>(), "connection-error": new Set<SyncListener>() };
  const emit = (event: keyof typeof listeners, v: boolean) => {
    for (const fn of [...listeners[event]]) fn(v);
  };
  const provider = new mod.HocuspocusProvider({
    url: roomSocketUrl(url, roomName),
    name: opts.docName ?? roomName,
    document: doc,
    ...(opts.awareness ? { awareness: opts.awareness } : {}),
    // Called on every connect, so a reconnect after expiry gets a new token
    // (and a revoked share link gets none).
    token: async () => {
      const payload = tokenPayload(roomName, { share: opts.share ?? null, accessKey, e2ee: opts.e2ee === true });
      // Review 2 (#469): the public server gives a token only with the room proof derived from the
      // room password, and may ask for a proof of work bound to the room and the proof.
      if (opts.password) payload.proof = await (await import("./roomProof")).roomProof(opts.password, roomName);
      type Answer = { token: string; expiresAt: number; role?: unknown };
      let r: Answer;
      try {
        r = await tokenRequest<Answer>(url, payload);
      } catch (e) {
        if (!(e instanceof RoomTokenError) || e.reason !== "pow" || typeof payload.proof !== "string" || typeof e.bits !== "number") throw e;
        const { proofVerifier, solveRoomPow } = await import("./roomProof");
        payload.pow = await solveRoomPow(roomName, await proofVerifier(payload.proof), e.bits);
        r = await tokenRequest<Answer>(url, payload);
      }
      opts.onRole?.(isRole(r.role) ? r.role : "edit");
      return r.token;
    },
  });
  provider.on("synced", (data) => emit("sync", (data as { state?: boolean } | undefined)?.state !== false));
  provider.on("authenticationFailed", () => emit("connection-error", false));
  // Closed before the first sync (unreachable, token refused): the caller
  // falls back to WebRTC-only instead of waiting out its timeout.
  provider.on("close", () => {
    if (!(provider.synced ?? provider.isSynced)) emit("connection-error", false);
  });
  return {
    get synced() {
      return provider.synced ?? provider.isSynced ?? false;
    },
    on(event, fn) {
      listeners[event].add(fn);
    },
    off(event, fn) {
      listeners[event].delete(fn);
    },
    destroy() {
      listeners.sync.clear();
      listeners["connection-error"].clear();
      provider.destroy();
    },
  };
}
