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
 * Without an existing device the new device trusts the first manifest it sees
 * (TOFU) and shows "freshness not verified" until the user confirms it.
 */

import { concat, fromB64u, fromUtf8, randomBytes, toB64u, utf8 } from "./bytes";
import { hmac, verifyHmac, type VaultKeys } from "./keys";
import type { FreshnessAnchor } from "./manifest";

const PREFIX = "lumen-pair:1:";
/** A code older than this is refused: it would anchor an old counter. */
export const PAIRING_TTL_MS = 15 * 60 * 1000;

interface PairingBody {
  vaultId: string;
  counter: number;
  digest: string;
  issuedAt: number;
  nonce: string;
}

export class PairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingError";
  }
}

/** A pairing code for `anchor` (the issuing device's verified anchor). */
export async function createPairingCode(keys: VaultKeys, anchor: FreshnessAnchor, now = Date.now()): Promise<string> {
  const body: PairingBody = {
    vaultId: keys.vaultId,
    counter: anchor.counter,
    digest: anchor.digest,
    issuedAt: now,
    nonce: toB64u(randomBytes(12)),
  };
  const json = utf8(JSON.stringify(body));
  const tag = await hmac(keys.pairing, json);
  return PREFIX + toB64u(concat(tag, json));
}

/** Verify `code` for this vault and return the anchor it carries. */
export async function readPairingCode(keys: VaultKeys, code: string, now = Date.now()): Promise<FreshnessAnchor> {
  const s = code.trim();
  if (!s.startsWith(PREFIX)) throw new PairingError("Not a Lumen pairing code");
  let raw: Uint8Array;
  try {
    raw = fromB64u(s.slice(PREFIX.length));
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
  if (!(now - body.issuedAt <= PAIRING_TTL_MS && body.issuedAt - now <= 60_000)) {
    throw new PairingError("The pairing code has expired; create a new one");
  }
  return { counter: body.counter, digest: body.digest };
}
