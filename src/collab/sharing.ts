/**
 * Real sharing (plan W1.19), the client side: roles, share links with an
 * expiry, revocation, and the "Shared with me" list. The server enforces
 * all of it (sync-server/collab/sharing.mjs); this module asks it, builds
 * and reads the links, and keeps the device's own records.
 *
 *   view     read the note, see comments
 *   comment  also write comments (the room's `~comments` document)
 *   edit     also change the note
 *
 * A share link is the room link plus `share=<id>`:
 *   https://lumen-md.vercel.app/#room=<room>&password=<room key>&share=<id>
 * The room key decrypts the end-to-end encrypted room; the share id is what
 * the server checks, so revoking the link locks its holder out (their copy
 * of the key opens nothing without the server). A room with share links is
 * synced through the server only — no WebRTC mesh, which the server could
 * not hold to the roles.
 *
 * Kept free of yjs: the share dialog and "Shared with me" load it alone.
 */

import { roomTokenUrl, RoomTokenError, ROOM_TOKEN_TIMEOUT_MS } from "./roomToken";
import { getSecret, setSecret } from "../lib/secretStore";

export type Role = "view" | "comment" | "edit";
export const ROLES: readonly Role[] = ["view", "comment", "edit"];

export const canEdit = (r: Role) => r === "edit";
export const canComment = (r: Role) => r === "edit" || r === "comment";

export const isRole = (x: unknown): x is Role => x === "view" || x === "comment" || x === "edit";

/** The server document that holds a room's comment threads. */
export const commentsDocName = (room: string) => `${room}~comments`;

export interface ShareInfo {
  id: string;
  role: Role;
  label: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  state: "active" | "expired" | "revoked";
}

/** One JSON request on the server's `/token` socket; resolves with the answer, rejects with `RoomTokenError` on `{error}`. */
export function tokenRequest<T>(serverUrl: string, payload: Record<string, unknown>, timeoutMs = ROOM_TOKEN_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // privacy-ledger: not tracked — the live-share server the user set up (collaboration, not AI traffic: docs/ai/privacy lists what the ledger covers); the same socket as roomToken.ts. Airplane mode blocks and lists it.
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
    ws.onopen = () => ws.send(JSON.stringify(payload));
    ws.onmessage = (ev: MessageEvent) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return finish(() => reject(new RoomTokenError("bad-response")));
      }
      const m = msg as { error?: unknown };
      if (m && typeof m === "object" && typeof m.error !== "string") return finish(() => resolve(msg as T));
      // With {error: "pow", bits} (review 2, #469) the caller solves the work and asks again.
      const bits = (msg as { bits?: unknown } | null)?.bits;
      finish(() => reject(new RoomTokenError(typeof m?.error === "string" ? m.error : "bad-response", typeof bits === "number" ? bits : undefined)));
    };
    ws.onerror = () => finish(() => reject(new RoomTokenError("unreachable")));
    ws.onclose = () => finish(() => reject(new RoomTokenError("closed")));
  });
}

/* ─── The owner secret ─────────────────────────────────────────────────── */

const ownerName = (room: string) => `lumen.collab.owner.${room}`;

/** This device's owner secret for `room` (kept in the encrypted secret store), if it owns the room. */
export function ownerSecret(room: string): string | null {
  return getSecret(ownerName(room));
}

/** The owner secret for `room`, made (and stored) the first time this device shares it. */
export async function ensureOwnerSecret(room: string): Promise<string> {
  const have = ownerSecret(room);
  if (have) return have;
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const secret = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  // Stored before the server learns it: a secret that can't be kept must not claim the room.
  await setSecret(ownerName(room), secret);
  return secret;
}

/* ─── Managing share links (owner) ─────────────────────────────────────── */

export const SHARE_TTLS = { hour: 3600, day: 86_400, week: 7 * 86_400, month: 30 * 86_400 } as const;
export type ShareTtl = keyof typeof SHARE_TTLS;

/**
 * Make a share link. `e2ee` (plan W2.20): the room is end-to-end encrypted,
 * so the server seals it, holding everyone to ciphertext from then on.
 */
export async function createShare(serverUrl: string, room: string, opts: { role: Role; ttl: ShareTtl; label?: string; accessKey?: string | null; e2ee?: boolean }): Promise<ShareInfo> {
  const owner = await ensureOwnerSecret(room);
  const r = await tokenRequest<{ share: ShareInfo }>(serverUrl, { action: "share", room, owner, role: opts.role, ttlS: SHARE_TTLS[opts.ttl], ...(opts.label ? { label: opts.label } : {}), ...(opts.accessKey ? { key: opts.accessKey } : {}), ...(opts.e2ee ? { e2ee: true } : {}) });
  markServerOnly(room);
  return r.share;
}

export async function listShares(serverUrl: string, room: string, accessKey?: string | null): Promise<ShareInfo[]> {
  const owner = ownerSecret(room);
  if (!owner) return [];
  return (await tokenRequest<{ shares: ShareInfo[] }>(serverUrl, { action: "shares", room, owner, ...(accessKey ? { key: accessKey } : {}) })).shares;
}

export async function revokeShare(serverUrl: string, room: string, share: string, accessKey?: string | null): Promise<void> {
  const owner = ownerSecret(room);
  if (!owner) throw new RoomTokenError("owner-required");
  await tokenRequest<{ ok: true }>(serverUrl, { action: "revoke", room, owner, share, ...(accessKey ? { key: accessKey } : {}) });
}

/** A link's current state, for "Shared with me" (no credentials: the id is the capability). */
export function shareStatus(serverUrl: string, room: string, share: string): Promise<{ role: Role; expiresAt: number | null; state: ShareInfo["state"] }> {
  return tokenRequest(serverUrl, { action: "status", room, share });
}

/**
 * What to send for a room token: the share link's id when the session was
 * opened from one, else the owner secret (needed once the room is claimed)
 * and the operator's access key. `e2ee` (plan W2.20) asks the server to seal
 * the room: this session syncs it end-to-end encrypted. The room key itself
 * is never part of a request: it stays in the link's fragment.
 */
export function tokenPayload(room: string, opts: { share?: string | null; accessKey?: string | null; e2ee?: boolean }): Record<string, unknown> {
  const sealed = opts.e2ee ? { e2ee: true } : {};
  if (opts.share) return { room, share: opts.share, ...sealed };
  const owner = ownerSecret(room);
  return { room, ...(opts.accessKey ? { key: opts.accessKey } : {}), ...(owner ? { owner } : {}), ...sealed };
}

/* ─── Server-only rooms ────────────────────────────────────────────────── */

const SERVER_ONLY_KEY = "lumen.collab.serverOnly.v1";

/** A room this device shared: sync it through the server only (roles can't be held on a WebRTC mesh). */
export function markServerOnly(room: string): void {
  try {
    const list = new Set(JSON.parse(localStorage.getItem(SERVER_ONLY_KEY) ?? "[]") as string[]);
    list.add(room);
    localStorage.setItem(SERVER_ONLY_KEY, JSON.stringify([...list]));
  } catch {
    /* the share link itself also makes its sessions server-only */
  }
}

export function isServerOnly(room: string, share?: string | null): boolean {
  if (share) return true;
  try {
    return (JSON.parse(localStorage.getItem(SERVER_ONLY_KEY) ?? "[]") as unknown[]).includes(room);
  } catch {
    // Unknown: the safe side for a room that may have shares.
    return true;
  }
}

/* ─── Links ────────────────────────────────────────────────────────────── */

/** `<origin><path>#room=…&password=…&share=…`. */
export function shareLink(room: string, password: string | null, share: string, base = typeof location !== "undefined" ? `${location.origin}${location.pathname}` : ""): string {
  return `${base}#room=${room}${password ? `&password=${encodeURIComponent(password)}` : ""}&share=${encodeURIComponent(share)}`;
}

/** The share id in a link's hash (`#…&share=…`), or null. */
export function readShareFromHash(hash = typeof location !== "undefined" ? location.hash : ""): string | null {
  const m = /[#&]share=([\w-]{8,64})(?:&|$)/.exec(hash);
  return m?.[1] ?? null;
}

/* ─── Shared with me ───────────────────────────────────────────────────── */

export interface SharedWithMe {
  room: string;
  share: string;
  role: Role;
  expiresAt: number | null;
  /** The link as opened (it carries the room key). */
  link: string;
  title: string;
  openedAt: number;
  state: ShareInfo["state"] | "unknown";
}

const SHARED_KEY = "lumen.collab.sharedWithMe.v1";

export function listSharedWithMe(): SharedWithMe[] {
  try {
    const v = JSON.parse(localStorage.getItem(SHARED_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as SharedWithMe[]).filter((x) => x && typeof x.room === "string" && typeof x.share === "string" && isRole(x.role)).sort((a, b) => b.openedAt - a.openedAt) : [];
  } catch {
    return [];
  }
}

function saveShared(list: SharedWithMe[]): void {
  try {
    localStorage.setItem(SHARED_KEY, JSON.stringify(list.slice(0, 200)));
  } catch {
    /* a convenience list */
  }
}

/** Remember a link this device opened (one entry per link, newest first). */
export function rememberShared(entry: Omit<SharedWithMe, "openedAt" | "state"> & { openedAt?: number; state?: SharedWithMe["state"] }): void {
  const rest = listSharedWithMe().filter((x) => x.share !== entry.share);
  saveShared([{ ...entry, openedAt: entry.openedAt ?? Date.now(), state: entry.state ?? "active" }, ...rest]);
}

export function forgetShared(share: string): void {
  saveShared(listSharedWithMe().filter((x) => x.share !== share));
}

/** Ask the server for each link's state (revoked / expired show as such); unreachable leaves "unknown". */
export async function refreshSharedWithMe(serverUrl: string): Promise<SharedWithMe[]> {
  const list = listSharedWithMe();
  const out = await Promise.all(
    list.map(async (x) => {
      try {
        const st = await shareStatus(serverUrl, x.room, x.share);
        return { ...x, role: st.role, expiresAt: st.expiresAt, state: st.state };
      } catch (e) {
        return { ...x, state: e instanceof RoomTokenError && e.reason === "no-share" ? ("revoked" as const) : ("unknown" as const) };
      }
    }),
  );
  saveShared(out);
  return out;
}

/** The persistent collab server, as Collab settings or the build configure it (same rule as `connectCollab`). */
export function collabServerUrl(): string | null {
  try {
    const stored = localStorage.getItem("lumen.collab.ws");
    if (stored) return stored;
  } catch {
    /* no storage */
  }
  const env = (import.meta as ImportMeta & { env?: { VITE_YJS_WEBSOCKET_URL?: string } }).env?.VITE_YJS_WEBSOCKET_URL;
  return env?.trim() || null;
}

/** The operator's access key (Collab settings → "Server access token"), if any. */
export const collabAccessKey = (): string | null => getSecret("lumen.collab.wsToken");
