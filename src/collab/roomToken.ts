/**
 * Ask the persistent collab server for a short-lived token for one room
 * (plan 3.6.2). The server signs it; the app holds no signing key, only the
 * optional operator access key the user typed into Collab settings, and,
 * for the public server, the room proof derived from the room's password.
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
  /** With reason "pow": the bits of work the server asks for. */
  constructor(
    readonly reason: string,
    readonly bits?: number,
  ) {
    super(`Collab server refused a room token: ${reason}`);
    this.name = "RoomTokenError";
  }
}

export interface RoomTokenOptions {
  /**
   * The room's password (from the share link). The public server gives a
   * token only with the room proof derived from it (`roomProof.ts`, review 2).
   */
  password?: string | null;
  timeoutMs?: number;
}

/**
 * Ask for a token. With the room password, the request carries the room
 * proof; when the server asks for a proof of work ({error:"pow", bits}), it
 * is solved once and the request is sent again.
 */
export async function requestRoomToken(
  serverUrl: string,
  room: string,
  accessKey: string | null,
  options: RoomTokenOptions | number = {},
): Promise<{ token: string; expiresAt: number }> {
  const opts = typeof options === "number" ? { timeoutMs: options } : options;
  const timeoutMs = opts.timeoutMs ?? ROOM_TOKEN_TIMEOUT_MS;
  const extra: Record<string, string> = {};
  if (opts.password) {
    // The proof is over the plain name; `room` may carry its commitment (review 4).
    const { roomBaseName, roomProof } = await import("./roomProof");
    extra.proof = await roomProof(opts.password, roomBaseName(room));
  }
  try {
    return await askOnce(serverUrl, room, accessKey, extra, timeoutMs);
  } catch (e) {
    if (!(e instanceof RoomTokenError) || e.reason !== "pow" || !extra.proof || typeof e.bits !== "number") throw e;
    const { proofVerifier, solveRoomPow } = await import("./roomProof");
    extra.pow = await solveRoomPow(room, await proofVerifier(extra.proof), e.bits);
    return askOnce(serverUrl, room, accessKey, extra, timeoutMs);
  }
}

function askOnce(
  serverUrl: string,
  room: string,
  accessKey: string | null,
  extra: Record<string, string>,
  timeoutMs: number,
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
        /* why: already closed */
      }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new RoomTokenError("timeout"))), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ room, ...(accessKey ? { key: accessKey } : {}), ...extra }));
    ws.onmessage = (ev: MessageEvent) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return finish(() => reject(new RoomTokenError("bad-response")));
      }
      const m = msg as { token?: unknown; expiresAt?: unknown; error?: unknown; bits?: unknown };
      if (typeof m.token === "string" && typeof m.expiresAt === "number") {
        const ok = { token: m.token, expiresAt: m.expiresAt };
        return finish(() => resolve(ok));
      }
      finish(() => reject(new RoomTokenError(typeof m.error === "string" ? m.error : "bad-response", typeof m.bits === "number" ? m.bits : undefined)));
    };
    ws.onerror = () => finish(() => reject(new RoomTokenError("unreachable")));
    ws.onclose = () => finish(() => reject(new RoomTokenError("closed")));
  });
}
