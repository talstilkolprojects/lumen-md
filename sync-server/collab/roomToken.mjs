/**
 * Short-lived, per-room access tokens for the Hocuspocus collab server
 * (plan 3.6.2). The server signs them with an HMAC key that never leaves
 * the server; the client only ever holds a token for one room, valid for a
 * few minutes, and asks for a fresh one on every (re)connect.
 *
 * Format: base64url(JSON {r: room, e: expiry in unix seconds, o?: role, s?: share id}) "." base64url(HMAC-SHA256)
 *
 * Plan W1.19: a token carries the holder's role — "edit", "comment" or
 * "view" (no `o` = "edit", the owner's and every token issued before
 * roles) — and, when it was bought with a share link, that link's id, so
 * the server can drop the connection the moment the link is revoked.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DEFAULT_TOKEN_TTL_S = 10 * 60;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** A signing key: the configured one, or a random one for this process (tokens then die with it, which is fine — clients refetch). */
export function signingKey(configured) {
  if (configured && configured.length < 32) throw new Error("COLLAB_TOKEN_SECRET must be at least 32 characters");
  return configured ? Buffer.from(configured) : randomBytes(32);
}

function mac(key, payload) {
  return createHmac("sha256", key).update(payload).digest();
}

export const ROLES = ["view", "comment", "edit"];

/**
 * Issue a token for `room`, valid for `ttlS` seconds from `nowMs` (never
 * past `notAfterMs`, a share link's expiry), for `role`, bought with `share`.
 */
export function issueRoomToken(key, room, { ttlS = DEFAULT_TOKEN_TTL_S, nowMs = Date.now(), role = "edit", share = null, notAfterMs = null } = {}) {
  if (!ROLES.includes(role)) throw new Error(`unknown role ${role}`);
  let exp = Math.floor(nowMs / 1000) + ttlS;
  if (notAfterMs !== null) exp = Math.min(exp, Math.floor(notAfterMs / 1000));
  const claims = { r: room, e: exp, ...(role !== "edit" ? { o: role } : {}), ...(share ? { s: share } : {}) };
  const payload = b64url(JSON.stringify(claims));
  return { token: `${payload}.${b64url(mac(key, payload))}`, expiresAt: exp * 1000, role };
}

/**
 * Check `token` for `room`. Returns null when valid, otherwise the reason
 * ("malformed" | "signature" | "room" | "expired").
 */
export function verifyRoomToken(key, token, room, { nowMs = Date.now() } = {}) {
  const r = readRoomToken(key, token, room, { nowMs });
  return r.ok ? null : r.reason;
}

/** Like `verifyRoomToken`, with the claims: {ok: true, role, share, expiresAt} or {ok: false, reason}. */
export function readRoomToken(key, token, room, { nowMs = Date.now() } = {}) {
  const why = checkToken(key, token, room, nowMs);
  if (typeof why === "string") return { ok: false, reason: why };
  return { ok: true, role: why.o ?? "edit", share: why.s ?? null, expiresAt: why.e * 1000 };
}

function checkToken(key, token, room, nowMs) {
  if (typeof token !== "string") return "malformed";
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return "malformed";
  const payload = token.slice(0, dot);
  let given;
  try {
    given = Buffer.from(token.slice(dot + 1), "base64url");
  } catch {
    return "malformed";
  }
  const expected = mac(key, payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "signature";
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return "malformed";
  }
  if (!claims || typeof claims.r !== "string" || typeof claims.e !== "number") return "malformed";
  if (claims.r !== room) return "room";
  if (claims.e * 1000 <= nowMs) return "expired";
  if (claims.o !== undefined && (claims.o === "edit" || !ROLES.includes(claims.o))) return "malformed";
  if (claims.s !== undefined && (typeof claims.s !== "string" || !claims.s)) return "malformed";
  return claims;
}

/** Constant-time check of the operator's access key (empty `expected` = open server). */
export function accessKeyOk(given, expected) {
  if (!expected) return true;
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
