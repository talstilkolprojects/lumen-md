/**
 * Ask the persistent collab server for a short-lived token for one room
 * (plan 3.6.2). The server signs it; the app holds no signing key, only the
 * optional operator access key the user typed into Collab settings.
 *
 * Over a WebSocket to `<server>/token`, not fetch: the CSP's connect-src
 * allows ws:/wss: to any host but not https:.
 */

export const ROOM_TOKEN_TIMEOUT_MS = 8000;

/** `wss://host/prefix` → `wss://host/prefix/token`. */
export function roomTokenUrl(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/token`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

export class RoomTokenError extends Error {
  constructor(readonly reason: string) {
    super(`Collab server refused a room token: ${reason}`);
    this.name = "RoomTokenError";
  }
}

export function requestRoomToken(
  serverUrl: string,
  room: string,
  accessKey: string | null,
  timeoutMs = ROOM_TOKEN_TIMEOUT_MS,
): Promise<{ token: string; expiresAt: number }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(roomTokenUrl(serverUrl));
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new RoomTokenError("timeout"))), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ room, ...(accessKey ? { key: accessKey } : {}) }));
    ws.onmessage = (ev: MessageEvent) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return finish(() => reject(new RoomTokenError("bad-response")));
      }
      const m = msg as { token?: unknown; expiresAt?: unknown; error?: unknown };
      if (typeof m.token === "string" && typeof m.expiresAt === "number") {
        const ok = { token: m.token, expiresAt: m.expiresAt };
        return finish(() => resolve(ok));
      }
      finish(() => reject(new RoomTokenError(typeof m.error === "string" ? m.error : "bad-response")));
    };
    ws.onerror = () => finish(() => reject(new RoomTokenError("unreachable")));
    ws.onclose = () => finish(() => reject(new RoomTokenError("closed")));
  });
}
