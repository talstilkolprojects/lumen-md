/**
 * The vault header (plan 3.4, steps 1–2): the one object at the provider that
 * is not encrypted, because a device needs it before it has a key. It holds
 * the protocol version, a random vault id and the KDF parameters — nothing
 * about the notes — and an HMAC under a key derived from the passphrase, so:
 *
 *   • a wrong passphrase is detected before any data is touched;
 *   • a provider that edits the header (say, to lower the PBKDF2 iterations)
 *     makes the MAC fail, and the client refuses the vault.
 *
 * Its object name is the fixed `HEADER_NAME`: a new device has to find it
 * without a key, and the name says nothing about the vault's contents.
 */

import { fromUtf8, randomBytes, toB64u, fromB64u, utf8 } from "./bytes";
import { deriveMasterKey, newKdfParams, validateKdfParams, type KdfParams, type KdfPolicy } from "./kdf";
import { deriveVaultKeys, hmac, verifyHmac, type VaultKeys } from "./keys";

/** Protocol version, written into the header and every manifest since day one. */
export const PROTOCOL_VERSION = 1;
export const HEADER_NAME = "lumen-e2ee-vault";
const FORMAT = "lumen-e2ee";

export interface VaultHeader {
  format: typeof FORMAT;
  protocol: number;
  vaultId: string;
  kdf: KdfParams;
  /** base64url HMAC-SHA256 under the header key over `headerMacInput`. */
  mac: string;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super("Wrong passphrase, or the vault header was changed");
    this.name = "WrongPassphraseError";
  }
}

export class UnsupportedProtocolError extends Error {
  constructor(public readonly protocol: unknown) {
    super(`Unsupported sync protocol version ${String(protocol)}`);
    this.name = "UnsupportedProtocolError";
  }
}

/** The exact bytes the MAC covers: every field but the MAC, in a fixed order. */
function headerMacInput(h: Omit<VaultHeader, "mac">): Uint8Array {
  return utf8(JSON.stringify([h.format, h.protocol, h.vaultId, h.kdf]));
}

/** A new vault: fresh id and KDF salt, keys derived from `passphrase`. */
export async function createHeader(
  passphrase: string,
  opts: { pbkdf2Iterations?: number } = {},
): Promise<{ header: VaultHeader; keys: VaultKeys }> {
  const body = {
    format: FORMAT,
    protocol: PROTOCOL_VERSION,
    vaultId: toB64u(randomBytes(16)),
    kdf: newKdfParams(opts.pbkdf2Iterations),
  } as const;
  const keys = await deriveVaultKeys(await deriveMasterKey(passphrase, body.kdf), body.vaultId);
  const mac = toB64u(await hmac(keys.header, headerMacInput(body)));
  return { header: { ...body, mac }, keys };
}

export function encodeHeader(h: VaultHeader): Uint8Array<ArrayBuffer> {
  return utf8(JSON.stringify(h));
}

/** Parse a header read from the provider; throws on anything malformed or from a newer protocol. */
export function decodeHeader(bytes: Uint8Array, policy: KdfPolicy = {}): VaultHeader {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(fromUtf8(bytes)) as Record<string, unknown>;
  } catch {
    throw new Error("The vault header is not valid JSON");
  }
  if (o.format !== FORMAT) throw new Error("Not a Lumen encrypted vault");
  if (o.protocol !== PROTOCOL_VERSION) throw new UnsupportedProtocolError(o.protocol);
  if (typeof o.vaultId !== "string" || fromB64u(o.vaultId).length !== 16) throw new Error("Bad vault id");
  if (typeof o.mac !== "string") throw new Error("The vault header has no MAC");
  return { format: FORMAT, protocol: PROTOCOL_VERSION, vaultId: o.vaultId, kdf: validateKdfParams(o.kdf, policy), mac: o.mac };
}

/** Derive the keys for `header` from `passphrase` and check its MAC. */
export async function unlockHeader(header: VaultHeader, passphrase: string): Promise<VaultKeys> {
  const keys = await deriveVaultKeys(await deriveMasterKey(passphrase, header.kdf), header.vaultId);
  let tag: Uint8Array;
  try {
    tag = fromB64u(header.mac);
  } catch {
    throw new WrongPassphraseError();
  }
  const body = { format: header.format, protocol: header.protocol, vaultId: header.vaultId, kdf: header.kdf };
  if (!(await verifyHmac(keys.header, tag, headerMacInput(body)))) throw new WrongPassphraseError();
  return keys;
}
