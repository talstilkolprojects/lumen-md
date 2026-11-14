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

export async function createPersistentProvider(
  url: string,
  roomName: string,
  doc: Y.Doc,
  accessKey: string | null,
): Promise<PersistentProvider> {
  const mod = (await import("@hocuspocus/provider")) as unknown as {
    HocuspocusProvider: new (cfg: Record<string, unknown>) => HocuspocusLike;
  };
  const listeners = { sync: new Set<SyncListener>(), "connection-error": new Set<SyncListener>() };
  const emit = (event: keyof typeof listeners, v: boolean) => {
    for (const fn of [...listeners[event]]) fn(v);
  };
  const provider = new mod.HocuspocusProvider({
    url,
    name: roomName,
    document: doc,
    // Called on every connect, so a reconnect after expiry gets a new token.
    token: async () => (await requestRoomToken(url, roomName, accessKey)).token,
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
