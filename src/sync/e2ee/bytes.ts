/**
 * Byte helpers for the end-to-end encrypted sync (plan 3.4). Pure, no
 * dependencies: WebCrypto (`crypto.subtle`) does the cryptography, these only
 * move bytes between strings, base64url and buffers.
 */

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

/** UTF-8 bytes of `s`. */
export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return enc.encode(s);
}

/** Decode UTF-8; throws on invalid bytes (a tampered or wrong-key payload must not decode silently). */
export function fromUtf8(b: Uint8Array): string {
  return dec.decode(b);
}

/** `u` as a WebCrypto BufferSource (TS types Uint8Array<ArrayBufferLike> too wide for it). */
export function bs(u: Uint8Array): BufferSource {
  return u as BufferSource;
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Equality without an early exit on the first differing byte. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_INDEX = new Map<string, number>([...B64].map((c, i) => [c, i]));

/** base64url without padding (RFC 4648 §5). */
export function toB64u(b: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < b.length) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63];
    if (i + 1 < b.length) out += B64[(n >> 6) & 63];
  }
  return out;
}

/** Inverse of `toB64u`; throws on characters outside the alphabet or an impossible length. */
export function fromB64u(s: string): Uint8Array<ArrayBuffer> {
  if (s.length % 4 === 1) throw new Error("invalid base64url length");
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (const c of s) {
    const v = B64_INDEX.get(c);
    if (v === undefined) throw new Error("invalid base64url character");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** SHA-256 of `data`, lowercase hex. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bs(data))));
}
