/**
 * The age file format, v1 (https://age-encryption.org/v1), so a vault export
 * or a backup can be opened with the `age` tool, or with any other age
 * implementation, without Lumen (plan W1.7).
 *
 *   recipients  X25519 (`age1…`, identities `AGE-SECRET-KEY-1…`), and scrypt
 *               (a passphrase; then it is the only recipient, as the spec says)
 *   header      "age-encryption.org/v1", one stanza per recipient, then
 *               "--- " and an HMAC-SHA256 under HKDF(file key, "", "header")
 *   payload     a 16-byte nonce, then the STREAM construction: 64 KiB chunks
 *               sealed with ChaCha20-Poly1305 under HKDF(file key, nonce,
 *               "payload"), nonce = 11-byte big-endian counter ‖ last-chunk flag
 *
 * No package: ChaCha20-Poly1305 and scrypt are in ./primitives (WebCrypto has
 * neither); X25519, HKDF and HMAC come from WebCrypto. The format is checked
 * both ways against an independent Python implementation
 * (scripts/sync-protocol/check_vectors.py).
 */

import { chachaOpen, chachaSeal } from "./primitives/chacha20poly1305";
import { scrypt } from "./primitives/scrypt";

const enc = new TextEncoder();
const dec = new TextDecoder();
const VERSION_LINE = "age-encryption.org/v1";
const CHUNK = 64 * 1024;
/** The default scrypt work factor (age uses 18; a backup is opened rarely). */
export const DEFAULT_SCRYPT_LOG_N = 18;
/** The highest work factor accepted when decrypting (protects against a header that asks for gigabytes). */
export const MAX_SCRYPT_LOG_N = 20;

export class AgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgeError";
  }
}

/* ─── Encodings ────────────────────────────────────────────────────────── */

/** base64 without padding (age's "RawStdEncoding"). */
export function b64raw(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/=+$/, "");
}

export function fromB64raw(s: string): Uint8Array {
  if (/[^A-Za-z0-9+/]/.test(s) || s.length % 4 === 1) throw new AgeError("bad base64 in the header");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  // Canonical encoding only: re-encoding must give the same text.
  if (b64raw(out) !== s) throw new AgeError("non-canonical base64 in the header");
  return out;
}

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i];
  }
  return chk;
}
const hrpExpand = (hrp: string) => [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
function convertBits(data: Uint8Array | number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & max);
  else if (!pad && (bits >= from || ((acc << (to - bits)) & max))) throw new AgeError("bad bech32 padding");
  return out;
}

export function bech32Encode(hrp: string, data: Uint8Array): string {
  const words = convertBits(data, 8, 5, true);
  const chk = polymod(hrpExpand(hrp).concat(words, [0, 0, 0, 0, 0, 0])) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (chk >> (5 * (5 - i))) & 31);
  return `${hrp}1${words.concat(checksum).map((w) => CHARSET[w]).join("")}`;
}

export function bech32Decode(s: string): { hrp: string; data: Uint8Array } {
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new AgeError("mixed-case bech32");
  const str = s.toLowerCase();
  const pos = str.lastIndexOf("1");
  if (pos < 1 || pos + 7 > str.length) throw new AgeError("bad bech32");
  const hrp = str.slice(0, pos);
  const words = [...str.slice(pos + 1)].map((c) => {
    const v = CHARSET.indexOf(c);
    if (v < 0) throw new AgeError("bad bech32 character");
    return v;
  });
  if (polymod(hrpExpand(hrp).concat(words)) !== 1) throw new AgeError("bad bech32 checksum");
  return { hrp, data: new Uint8Array(convertBits(words.slice(0, -6), 5, 8, false)) };
}

/* ─── WebCrypto helpers ────────────────────────────────────────────────── */

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, length = 32): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", new Uint8Array(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(salt), info: enc.encode(info) }, k, length * 8));
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", new Uint8Array(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new Uint8Array(data)));
}

const PKCS8_X25519 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

async function x25519Private(raw: Uint8Array): Promise<CryptoKey> {
  const der = new Uint8Array(PKCS8_X25519.length + 32);
  der.set(PKCS8_X25519);
  der.set(raw, PKCS8_X25519.length);
  return crypto.subtle.importKey("pkcs8", der, { name: "X25519" }, true, ["deriveBits"]);
}

async function x25519Public(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "X25519" }, true, []);
}

async function x25519(priv: CryptoKey, pubRaw: Uint8Array): Promise<Uint8Array> {
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: await x25519Public(pubRaw) }, priv, 256));
  if (shared.every((b) => b === 0)) throw new AgeError("X25519: low-order point");
  return shared;
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/* ─── Keys ─────────────────────────────────────────────────────────────── */

export interface AgeIdentity {
  /** `AGE-SECRET-KEY-1…` */
  identity: string;
  /** `age1…` */
  recipient: string;
}

/** The public half of a raw X25519 private key, via a JWK export of the imported key. */
async function publicOf(rawPriv: Uint8Array): Promise<Uint8Array> {
  const jwk = await crypto.subtle.exportKey("jwk", await x25519Private(rawPriv));
  if (!jwk.x) throw new AgeError("X25519: no public key");
  return fromB64url(jwk.x);
}

export async function generateIdentity(): Promise<AgeIdentity> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return identityFromRaw(raw);
}

export async function identityFromRaw(raw: Uint8Array): Promise<AgeIdentity> {
  return { identity: bech32Encode("age-secret-key-", raw).toUpperCase(), recipient: bech32Encode("age", await publicOf(raw)) };
}

export function parseRecipient(r: string): Uint8Array {
  const { hrp, data } = bech32Decode(r.trim());
  if (hrp !== "age" || data.length !== 32) throw new AgeError("not an age X25519 recipient");
  return data;
}

export function parseIdentity(id: string): Uint8Array {
  const { hrp, data } = bech32Decode(id.trim());
  if (hrp !== "age-secret-key-" || data.length !== 32) throw new AgeError("not an age X25519 identity");
  return data;
}

/* ─── Header ───────────────────────────────────────────────────────────── */

interface Stanza {
  type: string;
  args: string[];
  body: Uint8Array;
}

function stanzaText(s: Stanza): string {
  const b = b64raw(s.body);
  const lines: string[] = [];
  for (let i = 0; i < b.length; i += 64) lines.push(b.slice(i, i + 64));
  // The body always ends with a line shorter than 64 columns (possibly empty).
  if (b.length % 64 === 0) lines.push("");
  return `-> ${[s.type, ...s.args].join(" ")}\n${lines.join("\n")}\n`;
}

const ZERO_NONCE = new Uint8Array(12);
const ARG = /^[\x21-\x7e]+$/;

/* ─── Payload (STREAM) ─────────────────────────────────────────────────── */

function chunkNonce(counter: number, last: boolean): Uint8Array {
  const n = new Uint8Array(12);
  let c = counter;
  for (let i = 10; i >= 0 && c > 0; i--) {
    n[i] = c & 255;
    c = Math.floor(c / 256);
  }
  n[11] = last ? 1 : 0;
  return n;
}

/* ─── Encrypt / decrypt ────────────────────────────────────────────────── */

export type AgeRecipient = { x25519: string } | { passphrase: string; logN?: number };

export async function ageEncrypt(plaintext: Uint8Array, recipients: AgeRecipient[]): Promise<Uint8Array> {
  if (recipients.length === 0) throw new AgeError("no recipients");
  const scryptCount = recipients.filter((r) => "passphrase" in r).length;
  if (scryptCount > 0 && recipients.length > 1) throw new AgeError("a passphrase must be the only recipient");
  const fileKey = crypto.getRandomValues(new Uint8Array(16));
  const stanzas: Stanza[] = [];
  for (const r of recipients) {
    if ("passphrase" in r) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const logN = r.logN ?? DEFAULT_SCRYPT_LOG_N;
      const label = enc.encode("age-encryption.org/v1/scrypt");
      const key = await scrypt(enc.encode(r.passphrase), new Uint8Array([...label, ...salt]), { logN, r: 8, p: 1, dkLen: 32 });
      stanzas.push({ type: "scrypt", args: [b64raw(salt), String(logN)], body: chachaSeal(key, ZERO_NONCE, fileKey) });
    } else {
      const recipient = parseRecipient(r.x25519);
      const eph = crypto.getRandomValues(new Uint8Array(32));
      const ephPriv = await x25519Private(eph);
      const ephPub = await publicOf(eph);
      const shared = await x25519(ephPriv, recipient);
      const wrap = await hkdf(shared, new Uint8Array([...ephPub, ...recipient]), "age-encryption.org/v1/X25519");
      stanzas.push({ type: "X25519", args: [b64raw(ephPub)], body: chachaSeal(wrap, ZERO_NONCE, fileKey) });
    }
  }
  const headerNoMac = `${VERSION_LINE}\n${stanzas.map(stanzaText).join("")}---`;
  const mac = await hmacSha256(await hkdf(fileKey, new Uint8Array(), "header"), enc.encode(headerNoMac));
  const header = enc.encode(`${headerNoMac} ${b64raw(mac)}\n`);
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const payloadKey = await hkdf(fileKey, nonce, "payload");
  const chunks: Uint8Array[] = [header, nonce];
  const count = Math.max(1, Math.ceil(plaintext.length / CHUNK));
  for (let i = 0; i < count; i++) chunks.push(chachaSeal(payloadKey, chunkNonce(i, i === count - 1), plaintext.subarray(i * CHUNK, (i + 1) * CHUNK)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export type AgeIdentityInput = { identity: string } | { passphrase: string };

/** Decrypt an age file with any one of `identities`; AgeError with the reason otherwise. */
export async function ageDecrypt(file: Uint8Array, identities: AgeIdentityInput[]): Promise<Uint8Array> {
  // Parse the header line by line.
  let pos = 0;
  const line = (): string => {
    const nl = file.indexOf(10, pos);
    if (nl < 0) throw new AgeError("truncated header");
    const s = dec.decode(file.subarray(pos, nl));
    pos = nl + 1;
    return s;
  };
  if (line() !== VERSION_LINE) throw new AgeError("not an age v1 file");
  const stanzas: Stanza[] = [];
  let macLine = "";
  let macStart = 0;
  for (;;) {
    const start = pos;
    const l = line();
    if (l.startsWith("--- ")) {
      macLine = l.slice(4);
      macStart = start;
      break;
    }
    if (!l.startsWith("-> ")) throw new AgeError("malformed header");
    const [type, ...args] = l.slice(3).split(" ");
    if (!type || ![type, ...args].every((a) => ARG.test(a))) throw new AgeError("malformed stanza");
    let body = "";
    for (;;) {
      const b = line();
      if (b.length > 64) throw new AgeError("stanza body line too long");
      body += b;
      if (b.length < 64) break;
    }
    stanzas.push({ type, args, body: fromB64raw(body) });
  }
  const mac = fromB64raw(macLine);
  const headerNoMac = file.subarray(0, macStart + 3);

  const scryptStanzas = stanzas.filter((s) => s.type === "scrypt");
  if (scryptStanzas.length > 0 && stanzas.length > 1) throw new AgeError("an scrypt stanza must be the only one");

  let fileKey: Uint8Array | null = null;
  for (const id of identities) {
    for (const s of stanzas) {
      if ("passphrase" in id && s.type === "scrypt") {
        if (s.args.length !== 2 || !/^[1-9][0-9]?$/.test(s.args[1])) throw new AgeError("bad scrypt stanza");
        const salt = fromB64raw(s.args[0]);
        const logN = Number(s.args[1]);
        if (salt.length !== 16) throw new AgeError("bad scrypt salt");
        if (logN > MAX_SCRYPT_LOG_N) throw new AgeError(`scrypt work factor ${logN} is above the limit ${MAX_SCRYPT_LOG_N}`);
        const key = await scrypt(enc.encode(id.passphrase), new Uint8Array([...enc.encode("age-encryption.org/v1/scrypt"), ...salt]), { logN, r: 8, p: 1, dkLen: 32 });
        fileKey = s.body.length === 32 ? chachaOpen(key, ZERO_NONCE, s.body) : null;
      } else if ("identity" in id && s.type === "X25519") {
        if (s.args.length !== 1) throw new AgeError("bad X25519 stanza");
        const share = fromB64raw(s.args[0]);
        if (share.length !== 32 || s.body.length !== 32) throw new AgeError("bad X25519 stanza");
        const raw = parseIdentity(id.identity);
        const shared = await x25519(await x25519Private(raw), share);
        const wrap = await hkdf(shared, new Uint8Array([...share, ...(await publicOf(raw))]), "age-encryption.org/v1/X25519");
        fileKey = chachaOpen(wrap, ZERO_NONCE, s.body);
      }
      if (fileKey) break;
    }
    if (fileKey) break;
  }
  if (!fileKey) throw new AgeError("no identity matched (wrong passphrase or key)");
  const want = await hmacSha256(await hkdf(fileKey, new Uint8Array(), "header"), headerNoMac);
  if (mac.length !== 32 || want.some((b, i) => b !== mac[i])) throw new AgeError("the header MAC does not match");

  const nonce = file.subarray(pos, pos + 16);
  if (nonce.length !== 16) throw new AgeError("truncated payload");
  pos += 16;
  const payloadKey = await hkdf(fileKey, nonce, "payload");
  const parts: Uint8Array[] = [];
  const sealedChunk = CHUNK + 16;
  for (let i = 0; ; i++) {
    const rest = file.length - pos;
    if (rest < 16) throw new AgeError("truncated payload");
    const last = rest <= sealedChunk;
    const piece = file.subarray(pos, pos + Math.min(rest, sealedChunk));
    const pt = chachaOpen(payloadKey, chunkNonce(i, last), piece);
    if (!pt) throw new AgeError(last ? "the payload was changed or truncated" : "the payload was changed");
    if (last && pt.length === 0 && i > 0) throw new AgeError("empty last chunk");
    parts.push(pt);
    pos += piece.length;
    if (last) break;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
