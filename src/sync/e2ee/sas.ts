/**
 * Short authentication string for pairing (plan W8.5, seventh review 12.11,
 * G4): five symbols both devices show, which the user compares before either
 * device commits the pairing.
 *
 * Why: a pairing code or answer is a bearer token. One that leaked, or that
 * the user enters after cancelling pairing on the other device (G4), used to
 * pair a device the storage shows an old state. Now each device adds a fresh
 * X25519 key to the pairing, both derive the symbols from the shared secret
 * and the whole transcript, and neither commits until the user has said
 * "they match" on both. A device commits only once it also holds the other
 * device's confirmation, a MAC under a key from the same shared secret, so a
 * code alone, or a storage that replays one, commits nothing.
 *
 * The ordering follows Matrix's SAS verification: whoever sends a key first
 * sends only its hash (a commitment), and reveals the key after it has seen
 * the other's. An attacker in the middle must fix its keys before it can
 * compute either device's symbols, so it gets one guess at 2^-30 instead of
 * an offline search for a colliding string.
 *
 *   two-way   request (new → existing, by hand): commit(pub_J)
 *             answer  (existing → new, by hand): pub_I
 *             reveal  (new → storage):           pub_J
 *   one-way   code    (existing → new, by hand): commit(pub_I)
 *             reveal  (new → storage):           pub_J
 *             reveal  (existing → storage):      pub_I
 *   then each device, once its user confirmed: confirm (→ storage)
 *
 * Everything sent through the storage is MACed under the epoch's pairing key
 * as well, so a storage without the passphrase can't even inject a reveal.
 *
 *   transcript  JSON array, in this order: "lumen-pair-sas/1", flow,
 *               vaultId, epoch, ringRev, ringDigest, counter, digest,
 *               session (SHA-256 hex of the first message), answer
 *               (SHA-256 hex of the answer, "" one-way), nonce (the first
 *               message's), b64u(pub_I), b64u(pub_J)
 *   salt        SHA-256(transcript)
 *   symbols     HKDF-SHA256(X25519(sk, pub_other), salt, "lumen-pair-sas/1/sas", 4 bytes):
 *               the top 30 bits, six bits per symbol, most significant first
 *   confirm     HMAC-SHA256(HKDF(…, "lumen-pair-sas/1/confirm/<role>", 32),
 *               "lumen-pair-sas/1/confirm\0" ‖ salt)
 */

import { bs, concat, equalBytes, sha256Hex, toB64u, utf8 } from "./bytes";

export const SAS_LABEL = "lumen-pair-sas/1";
/** Symbols shown; each carries 6 bits (one of 64), 30 bits in all. */
export const SAS_LENGTH = 5;

/**
 * The 64 symbols, by index. Each has a name in every language
 * (`e2ee.sas.w<index>`); the emoji is the same everywhere, so two devices set
 * to different languages can still be compared. The list follows the idea of
 * Matrix's SAS emoji (common, easy to picture objects) and was chosen so the
 * Hebrew and English names have no near-homographs (no name within one
 * letter of another, none contained in another, no two short names a letter
 * apart).
 */
export const SAS_EMOJI = [
  "🐶", "🐱", "🦁", "🐎", "🦄", "🐷", "🐘", "🦉",
  "🐳", "🐓", "🐧", "🐢", "🐟", "🐙", "🦋", "🌻",
  "🌳", "🌵", "🧀", "🌏", "🌙", "☁️", "🔥", "🦀",
  "🥑", "🍓", "🍍", "🍕", "🎂", "🐝", "🐸", "🤖",
  "👑", "👓", "🧭", "🎈", "👍", "☂️", "🍉", "🦔",
  "🎁", "🔦", "📕", "🪑", "📎", "✉️", "🛡️", "🔑",
  "🔨", "🔭", "🥕", "🚂", "🚲", "⛵", "🚀", "🏅",
  "🧩", "🎸", "🎺", "🔔", "🚚", "🎧", "🪁", "🌈",
] as const;

export type PairingFlow = "two-way" | "one-way";
export type PairingRole = "issuer" | "joiner";

/** What both devices put into the symbols: every field of the pairing that either one acts on. */
export interface SasTranscript {
  flow: PairingFlow;
  vaultId: string;
  epoch: number;
  ringRev: number;
  ringDigest: string;
  /** The manifest the issuer vouches for. */
  counter: number;
  digest: string;
  /** SHA-256 hex of the first message (request, or one-way code). */
  session: string;
  /** SHA-256 hex of the answer; "" for a one-way code. */
  answer: string;
  /** The first message's nonce. */
  nonce: string;
  /** The issuer's (existing device's) and the joiner's (new device's) X25519 public keys. */
  pubI: Uint8Array;
  pubJ: Uint8Array;
}

export interface Sas {
  /** SAS_LENGTH indices into SAS_EMOJI. */
  symbols: number[];
  /** SHA-256 of the transcript (the HKDF salt). */
  th: Uint8Array;
  /** The confirmation key of each role. */
  confirm: Record<PairingRole, Uint8Array>;
}

export class SasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SasError";
  }
}

const PKCS8_X25519 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

function b64uToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** A fresh X25519 key pair for one pairing; `raw` (32 bytes) only for test vectors. */
export async function sasKeyPair(raw?: Uint8Array): Promise<{ priv: CryptoKey; pub: Uint8Array<ArrayBuffer> }> {
  if (!raw) {
    const k = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
    return { priv: k.privateKey, pub: new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey)) };
  }
  if (raw.length !== 32) throw new SasError("X25519 private key must be 32 bytes");
  const der = concat(PKCS8_X25519, raw);
  const priv = await crypto.subtle.importKey("pkcs8", der, { name: "X25519" }, true, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", priv);
  if (!jwk.x) throw new SasError("X25519: no public key");
  return { priv, pub: b64uToBytes(jwk.x) };
}

/** The commitment to a public key, as the first message carries it. */
export function sasCommit(pub: Uint8Array): Promise<string> {
  return sha256Hex(concat(utf8(`${SAS_LABEL}/commit\u0000`), pub));
}

export function transcriptBytes(t: SasTranscript): Uint8Array<ArrayBuffer> {
  return utf8(JSON.stringify([SAS_LABEL, t.flow, t.vaultId, t.epoch, t.ringRev, t.ringDigest, t.counter, t.digest, t.session, t.answer, t.nonce, toB64u(t.pubI), toB64u(t.pubJ)]));
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", bs(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: bs(salt), info: bs(utf8(info)) }, k, length * 8));
}

/** Six bits per symbol from the top of `b`. */
export function sasSymbols(b: Uint8Array): number[] {
  const n = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  return Array.from({ length: SAS_LENGTH }, (_, i) => (n >>> (26 - 6 * i)) & 63);
}

/** This device's symbols and confirmation keys, from its private key and the other device's public key. */
export async function deriveSas(priv: CryptoKey, otherPub: Uint8Array, t: SasTranscript): Promise<Sas> {
  if (otherPub.length !== 32 || t.pubI.length !== 32 || t.pubJ.length !== 32) throw new SasError("The other device's pairing key is damaged");
  let shared: Uint8Array;
  try {
    const pub = await crypto.subtle.importKey("raw", bs(otherPub), { name: "X25519" }, false, []);
    shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: pub }, priv, 256));
  } catch {
    throw new SasError("The other device's pairing key is damaged");
  }
  if (shared.every((x) => x === 0)) throw new SasError("The other device's pairing key is damaged");
  const th = new Uint8Array(await crypto.subtle.digest("SHA-256", transcriptBytes(t)));
  const symbols = sasSymbols(await hkdf(shared, th, `${SAS_LABEL}/sas`, 4));
  const issuer = await hkdf(shared, th, `${SAS_LABEL}/confirm/issuer`, 32);
  const joiner = await hkdf(shared, th, `${SAS_LABEL}/confirm/joiner`, 32);
  return { symbols, th, confirm: { issuer, joiner } };
}

async function hmacRaw(key: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", bs(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, bs(data)));
}

/** `role`'s confirmation: only a device that derived the same secret and transcript can make it. */
export function confirmTag(sas: Sas, role: PairingRole): Promise<Uint8Array<ArrayBuffer>> {
  return hmacRaw(sas.confirm[role], concat(utf8(`${SAS_LABEL}/confirm\u0000`), sas.th));
}

export async function confirmValid(sas: Sas, role: PairingRole, tag: Uint8Array): Promise<boolean> {
  return equalBytes(await confirmTag(sas, role), tag);
}
