/**
 * Short-lived, per-room access tokens for the Hocuspocus collab server
 * (plan 3.6.2). The server signs them with an HMAC key that never leaves
 * the server; the client only ever holds a token for one room, valid for a
 * few minutes, and asks for a fresh one on every (re)connect.
 *
 * Format: base64url(JSON {r: room, e: expiry in unix seconds}) "." base64url(HMAC-SHA256)
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// The new-room limits' pure part (review 2 RR2-469-1), for the Worker through this one module.
export { addressParts, admit, charge, cleanIds, cleanOwner, dayBuckets, dayOf, evictionOrder, evictionPlan, needed, ownerOf, prefixOwnerOf, quotaBuckets, quotaIds, quotaLimits, storeFull } from "./roomQuota.mjs";

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

/**
 * Issue a token for `room`, valid for `ttlS` seconds from `nowMs`. With
 * `verifier` (review 2, 12.11) the token also names the room secret it was
 * issued for: the hash of the client's room proof (`proofVerifier`).
 */
export function issueRoomToken(key, room, { ttlS = DEFAULT_TOKEN_TTL_S, nowMs = Date.now(), verifier } = {}) {
  const exp = Math.floor(nowMs / 1000) + ttlS;
  const payload = b64url(JSON.stringify(verifier ? { r: room, e: exp, v: verifier } : { r: room, e: exp }));
  return { token: `${payload}.${b64url(mac(key, payload))}`, expiresAt: exp * 1000 };
}

/**
 * Check `token` for `room`. Returns null when valid, otherwise the reason
 * ("malformed" | "signature" | "room" | "expired").
 */
export function verifyRoomToken(key, token, room, { nowMs = Date.now() } = {}) {
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
  return null;
}

/** Constant-time check of the operator's access key (empty `expected` = open server). */
export function accessKeyOk(given, expected) {
  if (!expected) return true;
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The room proof (review 2, 12.11): the app derives it from the room's
 * password in the share link, HMAC-SHA256(PBKDF2-SHA256(password,
 * "lumen.collab.proof.v1|<room>", 200,000), "lumen-collab room v1|<room>"),
 * as 43 base64url characters (src/collab/roomProof.ts). The server keeps
 * only its SHA-256, the verifier, so it learns nothing it could open the
 * room with, and guessing a password from it costs the same PBKDF2 as
 * guessing it from the room's ciphertext.
 */
export const ROOM_PROOF = /^[A-Za-z0-9_-]{43}$/;

/** The verifier of a room proof (hex SHA-256), or null for a malformed one. */
export function proofVerifier(proof) {
  if (typeof proof !== "string" || !ROOM_PROOF.test(proof)) return null;
  return createHash("sha256").update(proof).digest("hex");
}

/** The verifier a (signature-checked) token was issued for, or null when it names none. */
export function tokenVerifier(token) {
  try {
    const claims = JSON.parse(Buffer.from(String(token).split(".")[0], "base64url").toString("utf8"));
    return typeof claims?.v === "string" ? claims.v : null;
  } catch {
    return null;
  }
}

/** The most proof-of-work bits the app solves (src/collab/roomProof.ts MAX_ROOM_POW_BITS). */
export const MAX_ROOM_POW_BITS = 24;

/** Does `nonce` prove `bits` of work for `room` under `verifier`? SHA-256("lumen-collab pow v1|<room>|<verifier>|<nonce>"). */
export function roomPowOk(room, verifier, nonce, bits) {
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(nonce)) return false;
  const d = createHash("sha256").update(`lumen-collab pow v1|${room}|${verifier}|${nonce}`).digest();
  let n = 0;
  for (const b of d) {
    if (b === 0) {
      n += 8;
      continue;
    }
    n += Math.clz32(b) - 24;
    break;
  }
  return n >= bits;
}

/**
 * Review 4 (RR4-469-1): a room's name can carry a commitment to its proof,
 * `<base>_k<32 hex>`, where the 32 hex are the first 128 bits of
 * SHA-256("lumen-collab commit v1|<base>|<verifier>"). The app derives it
 * from the room's password (src/collab/roomProof.ts `committedRoomName`), so
 * the first binding is not "whoever connects first": only a proof whose
 * verifier matches the name gets a token for it, or is let into it.
 */
export const COMMITTED_ROOM = /^([\w-]{1,128})_k([0-9a-f]{32})$/;
/** The names the app made before commitments: `lumen-` + 128 random bits (src/collab/yjs.ts makeRoomName). */
export const APP_ROOM = /^lumen-[0-9a-f]{32}$/;

/** The commitment (32 hex) to `verifier` for the room name `base`. */
export function roomCommitment(base, verifier) {
  return createHash("sha256").update(`lumen-collab commit v1|${base}|${verifier}`).digest("hex").slice(0, 32);
}

/** `<base>_k<commit>` → {base, commit}, or null for a name without a commitment. */
export function splitCommittedRoom(name) {
  const m = typeof name === "string" ? COMMITTED_ROOM.exec(name) : null;
  return m ? { base: m[1], commit: m[2] } : null;
}

/** Does `verifier` match the commitment in the committed room name `name`? */
export function commitmentOk(name, verifier) {
  const c = splitCommittedRoom(name);
  if (!c || typeof verifier !== "string") return false;
  const a = Buffer.from(roomCommitment(c.base, verifier));
  const b = Buffer.from(c.commit);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * How a room binds its proof:
 *   "committed"  the name commits to the proof: only the matching one is let in;
 *   "app"        an app-made name from before commitments (128 random bits, and the
 *                creator connects first): the first proof binds it;
 *   "open"       any other name (typed, known in advance): it binds nothing, so whoever
 *                connects first can't lock its owners out (the app never uses such a
 *                name on the public server: it commits it first).
 */
export function roomKind(name) {
  if (splitCommittedRoom(name)) return "committed";
  return APP_ROOM.test(String(name)) ? "app" : "open";
}
