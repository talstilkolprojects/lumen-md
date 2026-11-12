/**
 * The room proof for the public collab server (review 2, 12.11).
 *
 * The public server gives a room token only to someone who holds the room's
 * password from the share link: the app sends a proof derived from it,
 *
 *   HMAC-SHA256(PBKDF2-SHA256(password, "lumen.collab.proof.v1|<room>", 200,000),
 *               "lumen-collab room v1|<room>")
 *
 * and the room binds the hash of the first proof it stores. The proof is not
 * the encryption key (another salt), and the server keeps only its hash.
 * The server may also ask for a proof of work bound to the room and the
 * proof; it is solved once per room and session.
 * Server side: sync-server/collab/roomToken.mjs.
 *
 * Review 4 (RR4-469-1): on the public server the app uses the room's name
 * with a commitment to its proof, `<name>_k<32 hex>` (`committedRoomName`),
 * so the room accepts its first binding only from a proof that matches: a
 * stranger who knows the name (a typed `#room=` link) but not the password
 * can't bind it first and lock its owners out. The proof itself is derived
 * over the plain name, which is what the share link carries.
 */

export const ROOM_PROOF_ITERATIONS = 200_000;
/** The most proof-of-work bits the app solves; the server clamps to the same. */
export const MAX_ROOM_POW_BITS = 24;

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `<name>_k<32 hex>`: a name that carries a commitment (as the server's COMMITTED_ROOM). */
const COMMITTED = /^([\w-]{1,128})_k([0-9a-f]{32})$/;

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const proofs = new Map<string, Promise<string>>();

/** The room proof for `room` under `password` (43 base64url characters). */
export function roomProof(password: string, room: string): Promise<string> {
  const id = `${room}\u0000${password}`;
  const hit = proofs.get(id);
  if (hit) return hit;
  const p = (async () => {
    const base = await crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: enc.encode(`lumen.collab.proof.v1|${room}`), iterations: ROOM_PROOF_ITERATIONS, hash: "SHA-256" },
      base,
      256,
    );
    const mac = await crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", mac, enc.encode(`lumen-collab room v1|${room}`))));
  })();
  // A session needs one or two rooms.
  if (proofs.size >= 8) proofs.delete(proofs.keys().next().value as string);
  proofs.set(id, p);
  p.catch(() => proofs.delete(id));
  return p;
}

/** What the server keeps of a proof: its SHA-256, in hex. */
export async function proofVerifier(proof: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(proof))));
}

function zeroBits(d: Uint8Array): number {
  let n = 0;
  for (const b of d) {
    if (b === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

const solved = new Map<string, Promise<string>>();

/** A nonce with `bits` leading zero bits in SHA-256("lumen-collab pow v1|<room>|<verifier>|<nonce>"). */
export function solveRoomPow(room: string, verifier: string, bits: number): Promise<string> {
  if (!Number.isInteger(bits) || bits < 1 || bits > MAX_ROOM_POW_BITS) {
    return Promise.reject(new Error(`collab: proof of work of ${bits} bits refused (at most ${MAX_ROOM_POW_BITS})`));
  }
  const id = `${room}|${verifier}|${bits}`;
  const hit = solved.get(id);
  if (hit) return hit;
  const p = (async () => {
    const BATCH = 256;
    for (let start = 0; ; start += BATCH) {
      const nonces = Array.from({ length: BATCH }, (_, i) => (start + i).toString(36));
      const digests = await Promise.all(nonces.map((n) => crypto.subtle.digest("SHA-256", enc.encode(`lumen-collab pow v1|${room}|${verifier}|${n}`))));
      const i = digests.findIndex((d) => zeroBits(new Uint8Array(d)) >= bits);
      if (i >= 0) return nonces[i];
    }
  })();
  if (solved.size >= 8) solved.delete(solved.keys().next().value as string);
  solved.set(id, p);
  p.catch(() => solved.delete(id));
  return p;
}

/** The plain room name a server-side name was made from (`<name>_k<commit>` → `<name>`). */
export function roomBaseName(serverRoom: string): string {
  return COMMITTED.exec(serverRoom)?.[1] ?? serverRoom;
}

/**
 * The room's name on the public server: `<room>_k` + the first 128 bits of
 * SHA-256("lumen-collab commit v1|<room>|<verifier>"), where the verifier is
 * the hash of the room proof under `password`.
 */
export async function committedRoomName(room: string, password: string): Promise<string> {
  const v = await proofVerifier(await roomProof(password, room));
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`lumen-collab commit v1|${room}|${v}`)));
  return `${room}_k${hex(d).slice(0, 32)}`;
}
