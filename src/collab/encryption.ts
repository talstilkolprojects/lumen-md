/**
 * AES-GCM primitives for Yjs collab payloads (P3-13).
 *
 * Y-WebRTC + y-websocket transmit Y.Doc updates as binary `Uint8Array`s.
 * By default these are unencrypted — the signaling server (and anyone on
 * the LAN, or any compromised relay) sees the plaintext document. The
 * end-to-end transport that keeps plaintext off the wire lives in
 * `./e2e.ts`; this module only provides the cipher.
 *
 * Ops are wrapped in AES-GCM using a key derived from a
 * shared room password via PBKDF2-SHA-256. The same room password on
 * every client → identical key → ops decrypt cleanly. A wrong password
 * → AES-GCM auth tag fails and the op is dropped (which Yjs handles —
 * the doc just stays out of sync until the user fixes the password).
 *
 * Format on the wire:
 *
 *     [12-byte IV][N-byte ciphertext + 16-byte tag]
 *
 * The IV is fresh per op (`crypto.getRandomValues`) so identical updates
 * encrypt to different ciphertexts. We don't ship the salt over the wire
 * — both peers derive the same key from the same password + a salt that
 * both know: the fixed application salt (`lumen.collab.v1`) by default,
 * or a room-scoped salt passed via `CryptoContext.salt` (the E2E
 * transport uses `lumen.collab.v2|<room>`).
 */

const SALT_TEXT = "lumen.collab.v1";

/** The room-scoped salt of the E2E transport (`./e2e.ts`) and of encrypted presence (`./e2eAwareness.ts`). */
export function roomSalt(room: string): string {
  return `lumen.collab.v2|${room}`;
}

/**
 * Optional per-call context. `salt` replaces the fixed application salt —
 * the E2E transport (`./e2e.ts`) passes a room-scoped salt so the same
 * password in two different rooms yields two unrelated keys. `aad` is
 * authenticated-but-not-encrypted data bound into the GCM tag (used to
 * bind envelope metadata such as the format version and snapshot flag).
 */
export interface CryptoContext {
  salt?: string;
  aad?: Uint8Array;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function deriveKey(password: string, saltText: string = SALT_TEXT): Promise<CryptoKey> {
  const cacheKey = `${saltText}\u0000${password}`;
  const hit = keyCache.get(cacheKey);
  if (hit) return hit;
  const promise = (async () => {
    const salt = new TextEncoder().encode(saltText);
    const baseKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations: 200_000,
        hash: "SHA-256",
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  })();
  // Bound the cache — a session only ever needs one or two keys.
  if (keyCache.size >= 8) keyCache.clear();
  keyCache.set(cacheKey, promise);
  promise.catch(() => keyCache.delete(cacheKey));
  return promise;
}

function gcmParams(iv: Uint8Array, aad?: Uint8Array): AesGcmParams {
  const params: AesGcmParams = { name: "AES-GCM", iv: new Uint8Array(iv) };
  if (aad) params.additionalData = new Uint8Array(aad);
  return params;
}

/** Encrypt a Yjs update under the room password. */
export async function encryptOp(
  password: string,
  plaintext: Uint8Array,
  ctx: CryptoContext = {},
): Promise<Uint8Array> {
  const key = await deriveKey(password, ctx.salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // Copy plaintext into a fresh ArrayBuffer-backed view — same reason
  // as decryptOp: WebCrypto's TS types reject ArrayBufferLike views.
  const ptCopy = new Uint8Array(plaintext);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(gcmParams(iv, ctx.aad), key, ptCopy),
  );
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv, 0);
  out.set(cipher, iv.length);
  return out;
}

/**
 * Decrypt a wire payload. Returns null when the auth tag fails — caller
 * should drop the op so a wrong-password peer can't poison the doc.
 */
export async function decryptOp(
  password: string,
  payload: Uint8Array,
  ctx: CryptoContext = {},
): Promise<Uint8Array | null> {
  if (payload.length < 28) return null;
  const key = await deriveKey(password, ctx.salt);
  // `subarray` views share the underlying ArrayBufferLike, which TS's
  // BufferSource types reject under stricter lib targets. Materialize
  // both halves into fresh, owned Uint8Arrays so the WebCrypto API is
  // happy.
  const iv = new Uint8Array(payload.slice(0, 12));
  const cipher = new Uint8Array(payload.slice(12));
  try {
    const plain = await crypto.subtle.decrypt(gcmParams(iv, ctx.aad), key, cipher);
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}

/** Drop the cached keys (e.g. when leaving a room). */
export function resetCollabKey(): void {
  keyCache.clear();
}
