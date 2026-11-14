/**
 * The persistent collab provider (plan 3.6): a Hocuspocus connection to
 * `sync-server/collab-server.mjs`, adapted to the small `sync` /
 * `connection-error` surface that `connectCollab` waits on.
 *
 * Every (re)connect asks the server for a fresh short-lived room token
 * (`requestRoomToken`); nothing secret is built into the app.
 */
import type * as Y from "yjs";
import { requestRoomToken } from "./roomToken";

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
  /** The room's password: the public server's token needs the room proof derived from it. */
  password: string | null = null,
): Promise<PersistentProvider> {
  const mod = (await import("@hocuspocus/provider")) as unknown as {
    HocuspocusProvider: new (cfg: Record<string, unknown>) => HocuspocusLike;
  };
  // Review 4 (RR4-469-1): with the room's password, the server-side name commits to the
  // room proof, so nobody who lacks the password can bind the room before its owners.
  const serverRoom = password ? await (await import("./roomProof")).committedRoomName(roomName, password) : roomName;
  const listeners = { sync: new Set<SyncListener>(), "connection-error": new Set<SyncListener>() };
  const emit = (event: keyof typeof listeners, v: boolean) => {
    for (const fn of [...listeners[event]]) fn(v);
  };
  const provider = new mod.HocuspocusProvider({
    url: roomSocketUrl(url, serverRoom),
    name: serverRoom,
    document: doc,
    // Called on every connect, so a reconnect after expiry gets a new token.
    token: async () => (await requestRoomToken(url, serverRoom, accessKey, { password })).token,
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
