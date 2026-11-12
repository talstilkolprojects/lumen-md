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
 * the user confirms it. Such a device can sync, but it can't re-key or
 * enroll devices (RR-5): served an old epoch, it would wrap the next one for
 * a device revoked meanwhile.
 */

import { concat, fromB64u, fromUtf8, randomBytes, toB64u, utf8 } from "./bytes";
import { anchorOf, type RingAnchor } from "./keyring";
import { hmac, verifyHmac, type VaultKeys } from "./keys";
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
/** A code older than this is refused: it would anchor an old counter. */
export const PAIRING_TTL_MS = 15 * 60 * 1000;

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
