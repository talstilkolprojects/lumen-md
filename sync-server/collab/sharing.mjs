/**
 * Real sharing for the collab server (plan W1.19): roles, share links that
 * expire or are revoked, and the room's owner.
 *
 * ── Owner ─────────────────────────────────────────────────────────────────
 * The first device to manage a room's sharing claims it with an owner
 * secret (random, ≥ 22 chars, kept in that device's secret store; the
 * server stores only its SHA-256). From then on the room is "claimed":
 *   • an editor token without a share needs the owner secret;
 *   • creating, listing and revoking share links needs it too;
 *   • everyone else gets in only with a share link, at that link's role.
 * A room nobody claimed works as before plan W1.19 (the room name, plus the
 * operator's access key when one is set, buys an editor token), so existing
 * rooms keep working.
 *
 * ── Share links ───────────────────────────────────────────────────────────
 * {id, room, role: "view" | "comment" | "edit", expiresAt, revokedAt}. The
 * id is 128 random bits: holding it is the capability. A token bought with
 * a link never outlives the link, and the server drops live connections
 * of a revoked or expired link (collab-server.mjs, within a second).
 *
 * ── Roles on the server ───────────────────────────────────────────────────
 * Every room has two documents: `<room>` (the text) and `<room>~comments`
 * (comment threads). "view" may write neither, "comment" may write only the
 * comments document, "edit" may write both. This holds in end-to-end
 * encrypted rooms too: the server can't read either document, but it
 * knows which one an update is for.
 *
 * ── Sealed rooms (plan W2.20, collab/sealed.mjs) ─────────────────────────
 * Any token request (and a share) may carry `e2ee: true`: the client syncs
 * the room end-to-end encrypted, so the server seals it and from then on
 * holds every connection to ciphertext only. `sealable(room)` (from the
 * server) says no when the room already stores readable content; the answer
 * says whether the room is sealed.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { accessKeyOk, issueRoomToken, ROLES, splitCommittedRoom } from "./roomToken.mjs";

export const COMMENTS_SUFFIX = "~comments";
export const ROOM_NAME = /^[\w-]{1,128}$/;
/** Share links last at most this long. */
export const MAX_SHARE_TTL_S = 365 * 24 * 3600;
export const DEFAULT_SHARE_TTL_S = 7 * 24 * 3600;
const MIN_OWNER_SECRET = 22;

/**
 * The room a name means on this server. The app names a password room
 * `<room>_k<32 hex>` (a commitment to its proof, for the public server:
 * roomToken.mjs `COMMITTED_ROOM`, review 4 of #469). This server ignores the
 * proof (access key, owner secret, share links), so the committed name is the
 * same room as its plain name: its shares, owner and seal stay where they were.
 */
export const roomOf = (name) => splitCommittedRoom(name)?.base ?? name;

/** `<room>` or `<room>~comments` (either with a commitment) → {room, kind}, or null for any other name. */
export function parseDocumentName(name) {
  if (typeof name !== "string") return null;
  const comments = name.endsWith(COMMENTS_SUFFIX);
  const room = roomOf(comments ? name.slice(0, -COMMENTS_SUFFIX.length) : name);
  return ROOM_NAME.test(room) ? { room, kind: comments ? "comments" : "text" } : null;
}

/** May `role` change a document of `kind`? */
export function canWrite(role, kind) {
  return role === "edit" || (role === "comment" && kind === "comments");
}

export const hashOwner = (secret) => createHash("sha256").update(String(secret)).digest("hex");

function sameHash(a, b) {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** "active" | "expired" | "revoked" for a share, at `nowMs`. */
export function shareState(share, nowMs = Date.now()) {
  if (share.revokedAt !== null) return "revoked";
  if (share.expiresAt !== null && share.expiresAt <= nowMs) return "expired";
  return "active";
}

const publicShare = (s, nowMs) => ({ id: s.id, role: s.role, label: s.label, createdAt: s.createdAt, expiresAt: s.expiresAt, revokedAt: s.revokedAt, state: shareState(s, nowMs) });

/**
 * Answer one message on the `/token` socket. `req` is the parsed JSON;
 * the answer is sent back as JSON. Never throws for bad input.
 *
 *   {room, key?, owner?}                         → an editor token (owner secret needed once the room is claimed)
 *   {room, share}                                → a token at the share's role
 *   {action: "share",  room, key?, owner, role, ttlS?, label?} → {share}
 *   {action: "shares", room, key?, owner}        → {shares}
 *   {action: "revoke", room, key?, owner, share} → {ok: true}
 *   {action: "status", room, share}              → {role, expiresAt, state}
 */
export function handleTokenRequest(req, { store, key, accessKey = "", tokenTtlS, nowMs = Date.now(), requireE2ee = false, sealable = () => true }) {
  if (!req || typeof req !== "object" || typeof req.room !== "string" || !ROOM_NAME.test(roomOf(req.room))) return { error: "bad-room" };
  const room = roomOf(req.room);
  const action = req.action ?? "token";
  /** Seal the room when an end-to-end client asks (only once it holds no readable content). */
  const seal = () => {
    if (requireE2ee) return true;
    if (store.isSealed?.(room)) return true;
    if (req.e2ee !== true || !store.sealRoom || !sealable(room)) return false;
    store.sealRoom(room);
    return true;
  };
  const issue = (opts) => {
    const t = issueRoomToken(key, room, opts);
    return t && typeof t === "object" && !t.error ? { ...t, sealed: seal() } : t;
  };

  // A share link's own status, for "Shared with me" (the id is the capability).
  if (action === "status") {
    const s = typeof req.share === "string" ? store.getShare(req.share) : null;
    if (!s || s.room !== room) return { error: "no-share" };
    return { role: s.role, expiresAt: s.expiresAt, state: shareState(s, nowMs) };
  }

  // A token bought with a share link: no access key needed, the link is the grant.
  if (action === "token" && typeof req.share === "string") {
    const s = store.getShare(req.share);
    if (!s || s.room !== room) return { error: "no-share" };
    const state = shareState(s, nowMs);
    if (state !== "active") return { error: state };
    return issue({ ttlS: tokenTtlS, nowMs, role: s.role, share: s.id, notAfterMs: s.expiresAt });
  }

  if (!accessKeyOk(req.key, accessKey)) return { error: "unauthorized" };
  const owner = store.roomOwner(room);
  const ownerOk = typeof req.owner === "string" && req.owner.length >= MIN_OWNER_SECRET && owner !== null && sameHash(owner, hashOwner(req.owner));

  if (action === "token") {
    // An unclaimed room: as before roles existed.
    if (owner === null || ownerOk) return issue({ ttlS: tokenTtlS, nowMs });
    return { error: "owner-required" };
  }

  if (action === "share" || action === "shares" || action === "revoke") {
    if (owner === null) {
      // The first device to share the room claims it.
      if (action !== "share" || typeof req.owner !== "string" || req.owner.length < MIN_OWNER_SECRET) return { error: "owner-required" };
      if (!store.claimRoom(room, hashOwner(req.owner), nowMs)) return { error: "owner-required" };
    } else if (!ownerOk) return { error: "owner-required" };

    if (action === "shares") return { shares: store.listShares(room).map((s) => publicShare(s, nowMs)) };
    if (action === "revoke") {
      if (typeof req.share !== "string") return { error: "no-share" };
      return store.revokeShare(room, req.share, nowMs) ? { ok: true } : { error: "no-share" };
    }
    const role = req.role;
    if (!ROLES.includes(role)) return { error: "bad-role" };
    const ttlS = req.ttlS === undefined ? DEFAULT_SHARE_TTL_S : Number(req.ttlS);
    if (!Number.isFinite(ttlS) || ttlS < 60 || ttlS > MAX_SHARE_TTL_S) return { error: "bad-ttl" };
    const label = typeof req.label === "string" ? req.label.slice(0, 80) : "";
    const share = store.addShare({ id: randomBytes(16).toString("base64url"), room, role, label, createdAt: nowMs, expiresAt: nowMs + Math.round(ttlS) * 1000 });
    return { share: publicShare(share, nowMs), sealed: seal() };
  }
  return { error: "bad-request" };
}

/**
 * Is this Hocuspocus message a write to the document? Message layout:
 * varString document name, varUint type (0 = sync; 4 = sync reply, which
 * Hocuspocus handles the same way, plan W2.20), varUint sync step
 * (0 = step 1, a request; 1 = step 2 and 2 = update, both carry changes).
 * Used as a second guard after the read-only connection flag.
 */
export function isDocumentWrite(bytes) {
  let i = 0;
  const varUint = () => {
    let n = 0;
    let shift = 0;
    for (;;) {
      if (i >= bytes.length) throw new Error("short");
      const b = bytes[i++];
      n += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return n;
      shift += 7;
      if (shift > 49) throw new Error("long");
    }
  };
  try {
    const len = varUint();
    i += len;
    if (i > bytes.length) return false;
    const type = varUint();
    if (type !== 0 && type !== 4) return false;
    const step = varUint();
    return step === 1 || step === 2;
  } catch {
    return false;
  }
}
