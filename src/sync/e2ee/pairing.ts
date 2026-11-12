/**
 * Pairing (plan 3.4, step 9): anchoring the rollback counter on a new device.
 *
 * A device that has never seen the vault cannot tell the newest manifest from
 * an old one the provider replays. An existing device therefore hands it a
 * pairing code — shown as text or a QR code, typed or scanned on the new
 * device, never sent through the provider — with the newest counter and
 * manifest digest it has verified. The code is authenticated with
 * HMAC-SHA256 under the vault's pairing key (derived from the passphrase), so
 * the provider, which has no key, cannot forge or alter one. The new device
 * still needs the passphrase: the code carries no key material.
 *
 * Without an existing device the new device trusts the first manifest and
 * the first keyring it sees (TOFU) and shows "freshness not verified" until
 * the user confirms it. Such a device pulls, but it doesn't upload (its
 * changes wait on it, third review 12.11 N6), re-key or enroll devices
 * (RR-5): served an old epoch, what it wrote would be readable by a device
 * revoked meanwhile, and it would wrap the next epoch for that device.
 *
 * Two ways to pair (third review 12.11, N3):
 *
 *   • two-way (the default in the UI): the new device shows a *request*
 *     (`createPairingRequest`) naming the keyring and manifest it sees, under
 *     that epoch's pairing key and with a fresh nonce. The existing device
 *     checks it against its own *current* state when the user enters it — so
 *     a new device shown an old epoch is caught there, whichever device made
 *     the newer epoch — and answers (`createPairingAnswer`) with its anchors
 *     at that moment, bound to the nonce. The new device accepts only the
 *     answer to its own request, within `PAIRING_REQUEST_TTL_MS` of making it
 *     (its own clock), and the answering device makes no key change for as long.
 *   • one-way: a code from the existing device (`createPairingCode`). It
 *     vouches for the issuer's state when it was made, so it is valid for
 *     `PAIRING_TTL_MS` (2 minutes) only, and the issuer makes no key change
 *     while one of its codes is valid.
 */

import { concat, fromB64u, fromUtf8, randomBytes, toB64u, utf8 } from "./bytes";
import { anchorOf, type RingAnchor } from "./keyring";
import { epochKeys, hmac, verifyHmac, type VaultKeys } from "./keys";
import type { FreshnessAnchor } from "./manifest";

/**
 * Version 2 (re-review 12.11, RR-5): the code also carries the keyring the
 * issuing device verified — its epoch, revision and digest — so the new
 * device is anchored on the keys, not only on the manifest. The epoch is in
 * the clear in front (`lumen-pair:2:<epoch>:…`): the code is authenticated
 * with that epoch's pairing key, and a device that sees an older epoch can
 * say so instead of "not from this vault".
 */
const PREFIX = "lumen-pair:2:";
/** Two-way pairing (N3): the new device's request, and the existing device's answer to it. */
const REQUEST_PREFIX = "lumen-pair-request:1:";
const ANSWER_PREFIX = "lumen-pair-answer:1:";
/**
 * A one-way code older than this is refused (N3: 15 minutes before). It
 * vouches for the issuer's state when it was made; a key change made after
 * that, on another device, isn't in it. The issuer itself makes no key
 * change while its code is valid. An answer to a request has the same life.
 */
export const PAIRING_TTL_MS = 2 * 60 * 1000;
/**
 * Two-way: the new device accepts the answer within this long of making its
 * request, on its own clock (no clock of another device is compared), and the
 * answering device makes no key change for this long after answering.
 */
export const PAIRING_REQUEST_TTL_MS = 5 * 60 * 1000;

interface PairingBody {
  vaultId: string;
  counter: number;
  digest: string;
  /** The keyring the issuer verified: epoch (0: no keyring), revision, SHA-256 of its bytes ("" at epoch 0). */
  epoch: number;
  ringRev: number;
  ringDigest: string;
  issuedAt: number;
  nonce: string;
}

/** What a pairing code anchors: the manifest (counter, digest) and the keyring. */
export interface PairingAnchor extends FreshnessAnchor {
  ring: RingAnchor;
}

export class PairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingError";
  }
}

/** The code is from another key epoch: "newer" — this device may be shown old keys (RR-5); "older" — the issuer is behind. */
export class PairingEpochError extends PairingError {
  constructor(
    public readonly kind: "newer" | "older",
    message: string,
  ) {
    super(message);
  }
}

/** A pairing code for `anchor` (the issuing device's verified anchor) and the keyring `ring` it verified. */
export async function createPairingCode(keys: VaultKeys, anchor: FreshnessAnchor, now = Date.now(), ring: RingAnchor = anchorOf(keys)): Promise<string> {
  if (ring.epoch !== keys.epoch) throw new PairingError("The keys and the keyring anchor are from different epochs");
  const body: PairingBody = {
    vaultId: keys.vaultId,
    counter: anchor.counter,
    digest: anchor.digest,
    epoch: ring.epoch,
    ringRev: ring.rev,
    ringDigest: ring.digest,
    issuedAt: now,
    nonce: toB64u(randomBytes(12)),
  };
  const json = utf8(JSON.stringify(body));
  const tag = await hmac(keys.pairing, json);
  return `${PREFIX}${ring.epoch}:${toB64u(concat(tag, json))}`;
}

/** Verify `code` for this vault and return the anchors it carries. */
export async function readPairingCode(keys: VaultKeys, code: string, now = Date.now()): Promise<PairingAnchor> {
  const s = code.trim();
  if (!s.startsWith(PREFIX)) throw new PairingError("Not a Lumen pairing code (or one from an older build: create a new one)");
  const rest = s.slice(PREFIX.length);
  const colon = rest.indexOf(":");
  const epoch = Number(rest.slice(0, colon));
  if (colon < 1 || !Number.isSafeInteger(epoch) || epoch < 0) throw new PairingError("The pairing code is damaged");
  if (epoch > keys.epoch) {
    throw new PairingEpochError(
      "newer",
      `The other device is at key epoch ${epoch}, this one sees ${keys.epoch}: the storage may be showing this device old keys. Sync both devices and try again; if it stays like this, don't trust this storage.`,
    );
  }
  if (epoch < keys.epoch) throw new PairingEpochError("older", "The other device is behind this one's keys: sync it, then create a new code");
  let raw: Uint8Array;
  try {
    raw = fromB64u(rest.slice(colon + 1));
  } catch {
    throw new PairingError("The pairing code is damaged");
  }
  if (raw.length < 33) throw new PairingError("The pairing code is damaged");
  const tag = raw.subarray(0, 32);
  const json = raw.subarray(32);
  if (!(await verifyHmac(keys.pairing, tag, json))) {
    throw new PairingError("The pairing code is not from this vault, or it was changed");
  }
  const body = JSON.parse(fromUtf8(json)) as PairingBody;
  if (body.vaultId !== keys.vaultId) throw new PairingError("The pairing code is for another vault");
  if (!Number.isSafeInteger(body.counter) || body.counter < 1 || typeof body.digest !== "string") {
    throw new PairingError("The pairing code is damaged");
  }
  if (body.epoch !== epoch || !Number.isSafeInteger(body.ringRev) || body.ringRev < 0 || typeof body.ringDigest !== "string") throw new PairingError("The pairing code is damaged");
  if (!(now - body.issuedAt <= PAIRING_TTL_MS && body.issuedAt - now <= 60_000)) {
    throw new PairingError("The pairing code has expired; create a new one");
  }
  return { counter: body.counter, digest: body.digest, ring: { epoch: body.epoch, rev: body.ringRev, digest: body.ringDigest } };
}

/* ─── Two-way pairing (third review 12.11, N3) ─────────────────────────── */

interface RequestBody {
  vaultId: string;
  /** The keyring the new device sees. */
  epoch: number;
  ringRev: number;
  ringDigest: string;
  /** The manifest it sees (null: it hasn't synced yet). */
  counter: number | null;
  digest: string | null;
  issuedAt: number;
  nonce: string;
}

interface AnswerBody {
  vaultId: string;
  /** The request's nonce: an answer is for one request only. */
  nonce: string;
  counter: number;
  digest: string;
  epoch: number;
  ringRev: number;
  ringDigest: string;
  answeredAt: number;
}

/** What a request says the new device sees. */
export interface PairingRequest {
  nonce: string;
  ring: RingAnchor;
  manifest: FreshnessAnchor | null;
  issuedAt: number;
}

async function encode(prefix: string, key: CryptoKey, epoch: number, body: object): Promise<string> {
  const json = utf8(JSON.stringify(body));
  return `${prefix}${epoch}:${toB64u(concat(await hmac(key, json), json))}`;
}

/** Split `<prefix><epoch>:<b64u(tag ‖ json)>`. */
function decode(code: string, prefix: string): { epoch: number; tag: Uint8Array; json: Uint8Array } {
  const s = code.trim();
  if (!s.startsWith(prefix)) throw new PairingError("Not a Lumen pairing code");
  const rest = s.slice(prefix.length);
  const colon = rest.indexOf(":");
  const epoch = Number(rest.slice(0, colon));
  if (colon < 1 || !Number.isSafeInteger(epoch) || epoch < 0) throw new PairingError("The pairing code is damaged");
  let raw: Uint8Array;
  try {
    raw = fromB64u(rest.slice(colon + 1));
  } catch {
    throw new PairingError("The pairing code is damaged");
  }
  if (raw.length < 33) throw new PairingError("The pairing code is damaged");
  return { epoch, tag: raw.subarray(0, 32), json: raw.subarray(32) };
}

export const isPairingAnswer = (code: string) => code.trim().startsWith(ANSWER_PREFIX);
export const isPairingRequest = (code: string) => code.trim().startsWith(REQUEST_PREFIX);

/** The new device's request: the keyring and manifest it sees, and a fresh nonce. */
export async function createPairingRequest(keys: VaultKeys, manifest: FreshnessAnchor | null, now = Date.now(), ring: RingAnchor = anchorOf(keys)): Promise<{ code: string; request: PairingRequest }> {
  if (ring.epoch !== keys.epoch) throw new PairingError("The keys and the keyring anchor are from different epochs");
  const nonce = toB64u(randomBytes(16));
  const body: RequestBody = { vaultId: keys.vaultId, epoch: ring.epoch, ringRev: ring.rev, ringDigest: ring.digest, counter: manifest?.counter ?? null, digest: manifest?.digest ?? null, issuedAt: now, nonce };
  return { code: await encode(REQUEST_PREFIX, keys.pairing, ring.epoch, body), request: { nonce, ring: { epoch: ring.epoch, rev: ring.rev, digest: ring.digest }, manifest, issuedAt: now } };
}

/** The pairing key of `epoch`, from `keys` (its own epoch, or an older one it holds). */
async function pairingKeyOf(keys: VaultKeys, epoch: number): Promise<CryptoKey | null> {
  if (epoch === keys.epoch) return keys.pairing;
  const s = keys.olderSecrets.get(epoch);
  return s ? (await epochKeys(s, keys.vaultId)).pairing : null;
}

/**
 * Read a request on the existing device, against its *current* keys. A
 * request from an older epoch it can still verify is refused as "stale"
 * (`PairingEpochError("older")`): the storage shows the new device old keys.
 */
export async function readPairingRequest(keys: VaultKeys, code: string): Promise<PairingRequest> {
  const { epoch, tag, json } = decode(code, REQUEST_PREFIX);
  if (epoch > keys.epoch) throw new PairingEpochError("newer", "The new device sees newer keys than this one: sync this device, then enter the request again");
  const key = await pairingKeyOf(keys, epoch);
  if (!key || !(await verifyHmac(key, tag, json))) throw new PairingError("The pairing request is not from this vault, or it was changed");
  const body = JSON.parse(fromUtf8(json)) as RequestBody;
  if (body.vaultId !== keys.vaultId || body.epoch !== epoch || !Number.isSafeInteger(body.ringRev) || typeof body.ringDigest !== "string" || typeof body.nonce !== "string") {
    throw new PairingError("The pairing request is damaged");
  }
  // No clock check here: the answer is made from this device's state now and
  // bound to the request's nonce; the new device times it on its own clock.
  if (epoch < keys.epoch) {
    throw new PairingEpochError(
      "older",
      `The new device is shown key epoch ${epoch}, this one is at ${keys.epoch}: the storage is showing it old keys. Don't pair it; sync it and try again, and if it stays like this, don't trust this storage.`,
    );
  }
  const manifest = body.counter !== null && body.digest !== null ? { counter: body.counter, digest: body.digest } : null;
  return { nonce: body.nonce, ring: { epoch, rev: body.ringRev, digest: body.ringDigest }, manifest, issuedAt: body.issuedAt };
}

/** The existing device's answer to `request`: its anchors now, bound to the request's nonce. */
export async function createPairingAnswer(keys: VaultKeys, request: PairingRequest, anchor: FreshnessAnchor, now = Date.now(), ring: RingAnchor = anchorOf(keys)): Promise<string> {
  if (ring.epoch !== keys.epoch) throw new PairingError("The keys and the keyring anchor are from different epochs");
  const body: AnswerBody = { vaultId: keys.vaultId, nonce: request.nonce, counter: anchor.counter, digest: anchor.digest, epoch: ring.epoch, ringRev: ring.rev, ringDigest: ring.digest, answeredAt: now };
  return encode(ANSWER_PREFIX, keys.pairing, ring.epoch, body);
}

/** Read the answer on the new device: it must answer `request` (its nonce) and come from its epoch. */
export async function readPairingAnswer(keys: VaultKeys, code: string, request: PairingRequest | null, now = Date.now()): Promise<PairingAnchor> {
  if (request && !(now - request.issuedAt <= PAIRING_REQUEST_TTL_MS && now >= request.issuedAt)) throw new PairingError("The pairing request has expired; create a new one");
  const { epoch, tag, json } = decode(code, ANSWER_PREFIX);
  if (!request) throw new PairingError("This device has no pairing request waiting: create one, and enter its answer");
  if (epoch > keys.epoch) {
    throw new PairingEpochError("newer", `The other device is at key epoch ${epoch}, this one sees ${keys.epoch}: the storage may be showing this device old keys. Sync both devices and try again; if it stays like this, don't trust this storage.`);
  }
  if (epoch < keys.epoch) throw new PairingEpochError("older", "The other device is behind this one's keys: sync it, then answer a new request");
  if (!(await verifyHmac(keys.pairing, tag, json))) throw new PairingError("The pairing answer is not from this vault, or it was changed");
  const body = JSON.parse(fromUtf8(json)) as AnswerBody;
  if (body.vaultId !== keys.vaultId || body.epoch !== epoch || body.nonce !== request.nonce) throw new PairingError("The pairing answer is for another request");
  if (!Number.isSafeInteger(body.counter) || body.counter < 1 || typeof body.digest !== "string" || !Number.isSafeInteger(body.ringRev) || typeof body.ringDigest !== "string") {
    throw new PairingError("The pairing answer is damaged");
  }
  return { counter: body.counter, digest: body.digest, ring: { epoch, rev: body.ringRev, digest: body.ringDigest } };
}
