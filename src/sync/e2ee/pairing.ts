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
 *     answer to its own request — the answer names the request's hash —
 *     within `PAIRING_REQUEST_TTL_MS` of making it (its own clock), and the
 *     answering device makes no key change for as long (or until
 *     `E2eeSync.cancelPairing()`).
 *   • one-way: a code from the existing device (`createPairingCode`). It
 *     vouches for the issuer's state when it was made, so it is valid for
 *     `PAIRING_TTL_MS` (2 minutes) only, and the issuer makes no key change
 *     while one of its codes is valid.
 *
 * Request, answer and code are three kinds of message under one key; their
 * MACs are domain-separated and their bodies have distinct shapes (fifth
 * review 12.11, F1), so whoever sees one can't turn it into another.
 *
 * None of them commits anything by itself (plan W8.5, seventh review G4):
 * the code and the request carry a commitment to the sender's comparison
 * key, the answer the answering device's key, and the new device is paired
 * only after the user compared the symbols on both devices (sas.ts; the
 * engine's `pairingSas`, `confirmPairing`, `rejectPairing`).
 */


import { concat, fromB64u, fromUtf8, randomBytes, sha256Hex, toB64u, utf8 } from "./bytes";
import { anchorOf, type RingAnchor } from "./keyring";
import { epochKeys, hmac, verifyHmac, type VaultKeys } from "./keys";
import type { FreshnessAnchor } from "./manifest";
import { sasCommit, type PairingRole } from "./sas";

/** A commitment to a key nobody holds: a message made without one verifies, but can never be confirmed (W8.5). */
const nobody = () => sasCommit(randomBytes(32));
const isHex64 = (s: unknown) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const isKey = (s: unknown) => {
  if (typeof s !== "string") return false;
  try {
    return fromB64u(s).length === 32;
  } catch {
    return false;
  }
};

/**
 * The three messages (fifth review 12.11, F1). Each one's MAC covers its kind
 * and version in front of the body — `HMAC(pairing_N, "lumen-pair/<kind>/<v>\0" ‖ body)`
 * — its body says its kind, and each kind has fields the others can't have:
 * a request can't be passed off as an answer or a one-way code, or the
 * reverse. The epoch is in the clear in front (`<prefix><epoch>:…`): the
 * message is authenticated with that epoch's pairing key, and a device that
 * sees an older epoch can say so instead of "not from this vault".
 *
 * A one-way code (version 3) carries the keyring the issuing device verified
 * (re-review 12.11, RR-5) as well as the manifest.
 */
const CODE_PREFIX = "lumen-pair:4:";
/** Two-way pairing (N3, F1): the new device's request, and the existing device's answer to it. */
const REQUEST_PREFIX = "lumen-pair-request:3:";
const ANSWER_PREFIX = "lumen-pair-answer:3:";
/**
 * The comparison (plan W8.5, G4; see sas.ts): a device's pairing key, and its
 * confirmation once the user said the symbols match. Sent through the
 * storage, never typed.
 */
const REVEAL_PREFIX = "lumen-pair-reveal:1:";
const CONFIRM_PREFIX = "lumen-pair-confirm:1:";
/**
 * Codes of earlier builds: refused with a message that says so. Code 3,
 * request 2 and answer 2 carry no comparison key (W8.5), so they can't be
 * confirmed and don't pair.
 */
const OLDER_PREFIXES = ["lumen-pair:1:", "lumen-pair:2:", "lumen-pair:3:", "lumen-pair-request:1:", "lumen-pair-request:2:", "lumen-pair-answer:1:", "lumen-pair-answer:2:"];

type Kind = "code" | "request" | "answer" | "reveal" | "confirm";
const VERSION: Record<Kind, number> = { code: 4, request: 3, answer: 3, reveal: 1, confirm: 1 };
/** The domain label in front of a message's body, inside its MAC. */
export const pairingLabel = (kind: Kind) => utf8(`lumen-pair/${kind}/${VERSION[kind]}\u0000`);

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
/**
 * How far ahead of this device's clock a code's issuedAt may be (another
 * device's clock). The issuer keeps its hold this much longer once it has
 * confirmed a comparison (plan W8.5), so the new device's window, measured
 * against issuedAt on its own clock, always ends inside the hold.
 */
export const PAIRING_CLOCK_SKEW_MS = 60_000;

/** The fields of each kind's body, exactly: a body with any other field is refused. */
const FIELDS: Record<Kind, string[]> = {
  code: ["kind", "vaultId", "counter", "digest", "epoch", "ringRev", "ringDigest", "issuedAt", "nonce", "commit"],
  request: ["kind", "vaultId", "epoch", "ringRev", "ringDigest", "counter", "digest", "requestedAt", "nonce", "commit"],
  answer: ["kind", "vaultId", "request", "nonce", "counter", "digest", "epoch", "ringRev", "ringDigest", "answeredAt", "pub"],
  reveal: ["kind", "vaultId", "session", "role", "pub"],
  confirm: ["kind", "vaultId", "session", "role", "tag"],
};

interface CodeBody {
  kind: "code";
  vaultId: string;
  counter: number;
  digest: string;
  /** The keyring the issuer verified: epoch (0: no keyring), revision, digest ("" at epoch 0). */
  epoch: number;
  ringRev: number;
  ringDigest: string;
  issuedAt: number;
  nonce: string;
  /** The issuer's commitment to its comparison key (W8.5): `sasCommit(pub_I)`. */
  commit: string;
}

interface RequestBody {
  kind: "request";
  vaultId: string;
  /** The keyring the new device sees. */
  epoch: number;
  ringRev: number;
  ringDigest: string;
  /** The manifest it sees (null: it hasn't synced yet). */
  counter: number | null;
  digest: string | null;
  requestedAt: number;
  nonce: string;
  /** The new device's commitment to its comparison key (W8.5): `sasCommit(pub_J)`. */
  commit: string;
}

interface AnswerBody {
  kind: "answer";
  vaultId: string;
  /** SHA-256 hex of the request (the text the new device showed): an answer is for one request only. */
  request: string;
  /** The request's nonce. */
  nonce: string;
  counter: number;
  digest: string;
  epoch: number;
  ringRev: number;
  ringDigest: string;
  answeredAt: number;
  /** The answering device's comparison key (W8.5), b64u. */
  pub: string;
}

interface RevealBody {
  kind: "reveal";
  vaultId: string;
  /** SHA-256 hex of the session's first message (request or code). */
  session: string;
  role: PairingRole;
  pub: string;
}

interface ConfirmBody {
  kind: "confirm";
  vaultId: string;
  session: string;
  role: PairingRole;
  tag: string;
}

/** What a pairing code anchors: the manifest (counter, digest) and the keyring. */
export interface PairingAnchor extends FreshnessAnchor {
  ring: RingAnchor;
}

/** What the comparison needs from a code or an answer (W8.5). */
export interface PairingSasInput {
  /** SHA-256 hex of the session's first message: the code, or the request. */
  session: string;
  /** SHA-256 hex of the answer; "" for a code. */
  answer: string;
  /** The first message's nonce. */
  nonce: string;
  /**
   * When the offer stops holding (the issuer's clock): the code's issuedAt +
   * PAIRING_TTL_MS, the answer's answeredAt + PAIRING_REQUEST_TTL_MS. The new
   * device's comparison ends then at the latest (review 13, S13-1).
   */
  expires: number;
  /** One-way: the issuer's commitment. Two-way: the issuer's key (b64u). */
  commit?: string;
  pub?: string;
}

/** A code or an answer, read: the anchors it vouches for and the comparison's inputs. Nothing is committed yet. */
export interface PairingOffer extends PairingAnchor {
  sas: PairingSasInput;
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

/** What a request says the new device sees. */
export interface PairingRequest {
  nonce: string;
  ring: RingAnchor;
  manifest: FreshnessAnchor | null;
  issuedAt: number;
  /** SHA-256 hex of the request's text (F1): the answer names it. Absent in a request saved by an earlier build. */
  hash?: string;
  /** The new device's commitment to its comparison key (W8.5). Absent in a request saved by an earlier build. */
  commit?: string;
}

const NEWER = (epoch: number, mine: number) =>
  `The other device is at key epoch ${epoch}, this one sees ${mine}: the storage may be showing this device old keys. Sync both devices and try again; if it stays like this, don't trust this storage.`;

async function encode(prefix: string, kind: Kind, key: CryptoKey, epoch: number, body: object): Promise<string> {
  const json = utf8(JSON.stringify(body));
  return `${prefix}${epoch}:${toB64u(concat(await hmac(key, concat(pairingLabel(kind), json)), json))}`;
}

/** Split `<prefix><epoch>:<b64u(tag ‖ json)>`. */
function decode(code: string, prefix: string): { epoch: number; tag: Uint8Array; json: Uint8Array } {
  const s = code.trim();
  if (!s.startsWith(prefix)) {
    if (OLDER_PREFIXES.some((p) => s.startsWith(p))) throw new PairingError("This pairing code is from an older build of Lumen: create a new one");
    throw new PairingError("Not a Lumen pairing code");
  }
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

/** The MAC under `key` with `kind`'s label, then the body: of that kind, with exactly its fields. */
async function open<T>(kind: Kind, key: CryptoKey | null, tag: Uint8Array, json: Uint8Array, what: string): Promise<T> {
  if (!key || !(await verifyHmac(key, tag, concat(pairingLabel(kind), json)))) throw new PairingError(`The ${what} is not from this vault, or it was changed`);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(fromUtf8(json)) as Record<string, unknown>;
  } catch {
    throw new PairingError(`The ${what} is damaged`);
  }
  const keys = body && typeof body === "object" ? Object.keys(body) : [];
  if (body?.kind !== kind || keys.length !== FIELDS[kind].length || !FIELDS[kind].every((k) => keys.includes(k))) throw new PairingError(`The ${what} is damaged`);
  return body as T;
}

const isCount = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
const ringOk = (b: { ringRev: unknown; ringDigest: unknown }) => isCount(b.ringRev) && typeof b.ringDigest === "string";

export const isPairingAnswer = (code: string) => code.trim().startsWith(ANSWER_PREFIX) || code.trim().startsWith("lumen-pair-answer:");
export const isPairingRequest = (code: string) => code.trim().startsWith(REQUEST_PREFIX) || code.trim().startsWith("lumen-pair-request:");

/** The SHA-256 hex of a request's text, as the answer names it. */
export const pairingRequestHash = (code: string) => sha256Hex(utf8(code.trim()));

/** A pairing code for `anchor` (the issuing device's verified anchor) and the keyring `ring` it verified. */
export async function createPairingCode(keys: VaultKeys, anchor: FreshnessAnchor, now = Date.now(), ring: RingAnchor = anchorOf(keys), commit?: string): Promise<string> {
  if (ring.epoch !== keys.epoch) throw new PairingError("The keys and the keyring anchor are from different epochs");
  const body: CodeBody = {
    kind: "code",
    vaultId: keys.vaultId,
    counter: anchor.counter,
    digest: anchor.digest,
    epoch: ring.epoch,
    ringRev: ring.rev,
    ringDigest: ring.digest,
    issuedAt: now,
    nonce: toB64u(randomBytes(12)),
    commit: commit ?? (await nobody()),
  };
  return encode(CODE_PREFIX, "code", keys.pairing, ring.epoch, body);
}

/** Verify a one-way `code` for this vault and return the anchors it carries. */
export async function readPairingCode(keys: VaultKeys, code: string, now = Date.now()): Promise<PairingOffer> {
  const { epoch, tag, json } = decode(code, CODE_PREFIX);
  if (epoch > keys.epoch) throw new PairingEpochError("newer", NEWER(epoch, keys.epoch));
  if (epoch < keys.epoch) throw new PairingEpochError("older", "The other device is behind this one's keys: sync it, then create a new code");
  const body = await open<CodeBody>("code", keys.pairing, tag, json, "pairing code");
  if (body.vaultId !== keys.vaultId) throw new PairingError("The pairing code is for another vault");
  if (!Number.isSafeInteger(body.counter) || body.counter < 1 || typeof body.digest !== "string") throw new PairingError("The pairing code is damaged");
  if (body.epoch !== epoch || !ringOk(body) || !Number.isSafeInteger(body.issuedAt) || typeof body.nonce !== "string" || !isHex64(body.commit)) throw new PairingError("The pairing code is damaged");
  if (!(now - body.issuedAt <= PAIRING_TTL_MS && body.issuedAt - now <= PAIRING_CLOCK_SKEW_MS)) {
    throw new PairingError("The pairing code has expired; create a new one");
  }
  return { counter: body.counter, digest: body.digest, ring: { epoch: body.epoch, rev: body.ringRev, digest: body.ringDigest }, sas: { session: await pairingRequestHash(code), answer: "", nonce: body.nonce, expires: body.issuedAt + PAIRING_TTL_MS, commit: body.commit } };
}

/* ─── Two-way pairing (third review 12.11, N3; fifth review F1) ────────── */

/** The new device's request: the keyring and manifest it sees, and a fresh nonce. */
export async function createPairingRequest(keys: VaultKeys, manifest: FreshnessAnchor | null, now = Date.now(), ring: RingAnchor = anchorOf(keys), commit?: string): Promise<{ code: string; request: PairingRequest }> {
  if (ring.epoch !== keys.epoch) throw new PairingError("The keys and the keyring anchor are from different epochs");
  const nonce = toB64u(randomBytes(16));
  const c = commit ?? (await nobody());
  const body: RequestBody = { kind: "request", vaultId: keys.vaultId, epoch: ring.epoch, ringRev: ring.rev, ringDigest: ring.digest, counter: manifest?.counter ?? null, digest: manifest?.digest ?? null, requestedAt: now, nonce, commit: c };
  const code = await encode(REQUEST_PREFIX, "request", keys.pairing, ring.epoch, body);
  return { code, request: { nonce, ring: { epoch: ring.epoch, rev: ring.rev, digest: ring.digest }, manifest, issuedAt: now, hash: await pairingRequestHash(code), commit: c } };
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
  const body = await open<RequestBody>("request", await pairingKeyOf(keys, epoch), tag, json, "pairing request");
  const manifestOk = (body.counter === null && body.digest === null) || (Number.isSafeInteger(body.counter) && (body.counter as number) >= 1 && typeof body.digest === "string");
  if (body.vaultId !== keys.vaultId || body.epoch !== epoch || !ringOk(body) || !manifestOk || typeof body.nonce !== "string" || !Number.isSafeInteger(body.requestedAt) || !isHex64(body.commit)) {
    throw new PairingError("The pairing request is damaged");
  }
  // No clock check here: the answer is made from this device's state now and
  // bound to the request; the new device times it on its own clock.
  if (epoch < keys.epoch) {
    throw new PairingEpochError(
      "older",
      `The new device is shown key epoch ${epoch}, this one is at ${keys.epoch}: the storage is showing it old keys. Don't pair it; sync it and try again, and if it stays like this, don't trust this storage.`,
    );
  }
  const manifest = body.counter !== null && body.digest !== null ? { counter: body.counter, digest: body.digest } : null;
  return { nonce: body.nonce, ring: { epoch, rev: body.ringRev, digest: body.ringDigest }, manifest, issuedAt: body.requestedAt, hash: await pairingRequestHash(code), commit: body.commit };
}

/** The existing device's answer to `request` (read by `readPairingRequest`): its anchors now, bound to the request. */
export async function createPairingAnswer(keys: VaultKeys, request: PairingRequest, anchor: FreshnessAnchor, now = Date.now(), ring: RingAnchor = anchorOf(keys), pub?: Uint8Array): Promise<string> {
  if (ring.epoch !== keys.epoch) throw new PairingError("The keys and the keyring anchor are from different epochs");
  if (!request.hash) throw new PairingError("The pairing request has no hash: read it with readPairingRequest");
  const body: AnswerBody = { kind: "answer", vaultId: keys.vaultId, request: request.hash, nonce: request.nonce, counter: anchor.counter, digest: anchor.digest, epoch: ring.epoch, ringRev: ring.rev, ringDigest: ring.digest, answeredAt: now, pub: toB64u(pub ?? randomBytes(32)) };
  return encode(ANSWER_PREFIX, "answer", keys.pairing, ring.epoch, body);
}

/** Read the answer on the new device: it must answer `request` (its hash and nonce) and come from its epoch. */
export async function readPairingAnswer(keys: VaultKeys, code: string, request: PairingRequest | null, now = Date.now()): Promise<PairingOffer> {
  if (request && !(now - request.issuedAt <= PAIRING_REQUEST_TTL_MS && now >= request.issuedAt)) throw new PairingError("The pairing request has expired; create a new one");
  const { epoch, tag, json } = decode(code, ANSWER_PREFIX);
  if (!request?.hash) throw new PairingError("This device has no pairing request waiting: create one, and enter its answer");
  if (epoch > keys.epoch) throw new PairingEpochError("newer", NEWER(epoch, keys.epoch));
  if (epoch < keys.epoch) throw new PairingEpochError("older", "The other device is behind this one's keys: sync it, then answer a new request");
  const body = await open<AnswerBody>("answer", keys.pairing, tag, json, "pairing answer");
  if (body.vaultId !== keys.vaultId || body.epoch !== epoch || body.request !== request.hash || body.nonce !== request.nonce) throw new PairingError("The pairing answer is for another request");
  if (!Number.isSafeInteger(body.counter) || body.counter < 1 || typeof body.digest !== "string" || !ringOk(body) || !Number.isSafeInteger(body.answeredAt) || !isKey(body.pub)) {
    throw new PairingError("The pairing answer is damaged");
  }
  return { counter: body.counter, digest: body.digest, ring: { epoch, rev: body.ringRev, digest: body.ringDigest }, sas: { session: request.hash, answer: await pairingRequestHash(code), nonce: request.nonce, expires: body.answeredAt + PAIRING_REQUEST_TTL_MS, pub: body.pub } };
}

/* ─── The comparison's messages through the storage (plan W8.5) ───────── */

/** A device's comparison key for `session`, MACed under this epoch's pairing key. */
export function createPairingReveal(keys: VaultKeys, session: string, role: PairingRole, pub: Uint8Array): Promise<string> {
  const body: RevealBody = { kind: "reveal", vaultId: keys.vaultId, session, role, pub: toB64u(pub) };
  return encode(REVEAL_PREFIX, "reveal", keys.pairing, keys.epoch, body);
}

/** `role`'s confirmation of `session` (a MAC from sas.ts's confirmTag), MACed under this epoch's pairing key. */
export function createPairingConfirm(keys: VaultKeys, session: string, role: PairingRole, tag: Uint8Array): Promise<string> {
  const body: ConfirmBody = { kind: "confirm", vaultId: keys.vaultId, session, role, tag: toB64u(tag) };
  return encode(CONFIRM_PREFIX, "confirm", keys.pairing, keys.epoch, body);
}

async function readStored<T extends { vaultId: string; session: string; role: PairingRole }>(kind: "reveal" | "confirm", prefix: string, keys: VaultKeys, text: string, session: string, role: PairingRole): Promise<T> {
  const { epoch, tag, json } = decode(text, prefix);
  if (epoch !== keys.epoch) throw new PairingError(`The pairing ${kind} is from another key epoch`);
  const body = await open<T>(kind, keys.pairing, tag, json, `pairing ${kind}`);
  if (body.vaultId !== keys.vaultId || body.session !== session || body.role !== role) throw new PairingError(`The pairing ${kind} is for another pairing`);
  return body;
}

/** The other device's comparison key for `session`, as `role` posted it. */
export async function readPairingReveal(keys: VaultKeys, text: string, session: string, role: PairingRole): Promise<Uint8Array> {
  const body = await readStored<RevealBody>("reveal", REVEAL_PREFIX, keys, text, session, role);
  if (!isKey(body.pub)) throw new PairingError("The pairing reveal is damaged");
  return fromB64u(body.pub);
}

/** The other device's confirmation tag for `session`. */
export async function readPairingConfirm(keys: VaultKeys, text: string, session: string, role: PairingRole): Promise<Uint8Array> {
  const body = await readStored<ConfirmBody>("confirm", CONFIRM_PREFIX, keys, text, session, role);
  let tag: Uint8Array;
  try {
    tag = fromB64u(body.tag);
  } catch {
    throw new PairingError("The pairing confirmation is damaged");
  }
  if (tag.length !== 32) throw new PairingError("The pairing confirmation is damaged");
  return tag;
}
