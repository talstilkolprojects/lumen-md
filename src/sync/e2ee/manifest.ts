/**
 * The manifest (plan 3.4, steps 1, 7, 8): the vault's table of contents.
 *
 * It lists every path with its own version number, a random revision id (the
 * blob of that version is stored under `blobName(path, rev)`), the SHA-256 of
 * the plaintext and a tombstone flag for deletions. It also carries a
 * monotonic `counter`, raised by one on every write of the manifest.
 *
 * The manifest is sealed with AES-256-GCM (keys.ts), so the provider sees
 * neither paths, nor versions, nor the counter, and cannot change a byte of
 * it. Because only holders of the passphrase-derived key can produce a valid
 * manifest, the counter is authenticated by the AEAD tag — that is the
 * "signed" counter of the plan. A signature (Ed25519) would add nothing
 * against the provider: every device that can sync holds the same key anyway,
 * and telling devices apart from each other is not in this threat model (see
 * docs/src/content/docs/sync/e2ee.md).
 *
 * Rollback guard (`checkFreshness`): a device remembers the highest counter
 * it has verified and the digest of that manifest. It refuses a manifest with
 * a lower counter (a replay of an old state) and one with the same counter
 * but different content (a fork).
 */

import { sha256Hex, utf8 } from "./bytes";
import { PROTOCOL_VERSION } from "./header";
import { opaqueName, seal, unsealJson, DecryptError, type VaultKeys } from "./keys";
import { isSyncedPath } from "./localFiles";

export interface ManifestEntry {
  /** Per-file version: 1 for the first write of a path, +1 for every later one (deletions included). */
  ver: number;
  /** Random revision id (base64url); the blob is `blobName(path, rev)`. Empty for a tombstone. */
  rev: string;
  /** SHA-256 hex of the plaintext; "" for a tombstone. */
  hash: string;
  size: number;
  /** A deletion that other devices must apply. */
  deleted?: true;
  /** The device that wrote this version (a random id, not a name). */
  by: string;
}

export interface Manifest {
  protocol: number;
  vaultId: string;
  /** Raised by one on every manifest write; the rollback guard compares it. */
  counter: number;
  files: Record<string, ManifestEntry>;
  /**
   * The predecessors: `[counter, digest]` of the last `HISTORY_LENGTH`
   * manifests before this one, oldest first. A device checks that the
   * manifest it anchored on is among them, so a newer counter from another
   * branch is a fork, not an update.
   */
  history: Array<[number, string]>;
}

/** How many predecessors a manifest lists (about 7 KB of plaintext at most). */
export const HISTORY_LENGTH = 100;

/** The manifest object's name: the same for every version, so its name leaks nothing. */
export function manifestName(keys: VaultKeys): Promise<string> {
  return opaqueName(keys, "manifest");
}

/** The object name of `path` at revision `rev`: HMAC of the path (and revision), never the path itself. */
export function blobName(keys: VaultKeys, path: string, rev: string): Promise<string> {
  return opaqueName(keys, `blob\u0000${path}\u0000${rev}`);
}

/**
 * A path-keyed record without a prototype: a note called `__proto__` or
 * `constructor` is an ordinary own key, never an inherited one.
 */
export function pathRecord<T>(from?: Record<string, T>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  if (from) for (const k of Object.keys(from)) out[k] = from[k];
  return out;
}

export function emptyManifest(vaultId: string): Manifest {
  return { protocol: PROTOCOL_VERSION, vaultId, counter: 0, files: pathRecord(), history: [] };
}

/** Sorted keys, so the same manifest always seals the same plaintext (and digest). */
function canonical(m: Manifest): string {
  const files = pathRecord<ManifestEntry>();
  for (const p of Object.keys(m.files).sort()) files[p] = m.files[p];
  return JSON.stringify({ protocol: m.protocol, vaultId: m.vaultId, counter: m.counter, files, history: m.history });
}

export interface SealedManifest {
  bytes: Uint8Array<ArrayBuffer>;
  /** SHA-256 hex of the plaintext: what the rollback guard and pairing compare. */
  digest: string;
}

/** `name`: the manifest's object name when the caller already has it. */
export async function sealManifest(keys: VaultKeys, m: Manifest, name?: string): Promise<SealedManifest> {
  const plain = utf8(canonical(m));
  name ??= await manifestName(keys);
  return { bytes: await seal(keys.manifest, keys.vaultId, "manifest", name, plain), digest: await sha256Hex(plain) };
}

function isEntry(e: unknown): e is ManifestEntry {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  return (
    Number.isSafeInteger(o.ver) &&
    (o.ver as number) >= 1 &&
    typeof o.rev === "string" &&
    typeof o.hash === "string" &&
    Number.isSafeInteger(o.size) &&
    typeof o.by === "string" &&
    (o.deleted === undefined || o.deleted === true)
  );
}

/** Decrypt, authenticate and validate a manifest. `DecryptError` on any tampering. */
export async function openManifest(
  keys: VaultKeys,
  sealed: Uint8Array,
  name?: string,
): Promise<{ manifest: Manifest; digest: string }> {
  const { value, bytes } = await unsealJson(keys.manifest, keys.vaultId, "manifest", name ?? (await manifestName(keys)), sealed);
  const o = value as Record<string, unknown>;
  if (!o || o.protocol !== PROTOCOL_VERSION) throw new DecryptError("Unsupported manifest protocol");
  if (o.vaultId !== keys.vaultId) throw new DecryptError("The manifest belongs to another vault");
  if (!Number.isSafeInteger(o.counter) || (o.counter as number) < 1) throw new DecryptError("Bad manifest counter");
  if (!o.files || typeof o.files !== "object") throw new DecryptError("Bad manifest files");
  const files = pathRecord<ManifestEntry>();
  for (const [p, e] of Object.entries(o.files as Record<string, unknown>)) {
    if (!isSyncedPath(p) || !isEntry(e)) throw new DecryptError("Bad manifest entry");
    files[p] = e;
  }
  const counter = o.counter as number;
  const history = o.history;
  if (
    !Array.isArray(history) ||
    history.length > HISTORY_LENGTH ||
    !history.every(
      (h, i) =>
        Array.isArray(h) &&
        h.length === 2 &&
        Number.isSafeInteger(h[0]) &&
        typeof h[1] === "string" &&
        h[0] < counter &&
        (i === 0 || h[0] > (history[i - 1] as [number, string])[0]),
    )
  ) {
    throw new DecryptError("Bad manifest history");
  }
  return {
    manifest: { protocol: PROTOCOL_VERSION, vaultId: keys.vaultId, counter, files, history: history as Array<[number, string]> },
    digest: await sha256Hex(bytes),
  };
}

/** What a device remembers about the newest manifest it has verified. */
export interface FreshnessAnchor {
  counter: number;
  digest: string;
}

export class RollbackError extends Error {
  constructor(
    public readonly seen: number,
    public readonly got: number,
    public readonly kind: "older" | "fork",
  ) {
    super(
      kind === "older"
        ? `The provider returned manifest ${got}, older than ${seen} seen before — refused (rollback/replay)`
        : `The provider returned a different manifest with the same counter ${got} — refused (fork)`,
    );
    this.name = "RollbackError";
  }
}

/**
 * Throws `RollbackError` unless `got` is at least as new as `anchor`, is the
 * anchored manifest itself when equally new, and — when newer — descends from
 * it: `history` (got's predecessors) must list the anchor's counter with the
 * anchor's digest. Returns "unproven" when the anchor is older than the
 * history reaches (or no history is given): the caller can no longer claim
 * the device is verified.
 */
export function checkFreshness(
  anchor: FreshnessAnchor | null,
  got: FreshnessAnchor,
  history?: Array<[number, string]>,
): "ok" | "unproven" {
  if (!anchor) return "ok";
  if (got.counter < anchor.counter) throw new RollbackError(anchor.counter, got.counter, "older");
  if (got.counter === anchor.counter) {
    if (got.digest !== anchor.digest) throw new RollbackError(anchor.counter, got.counter, "fork");
    return "ok";
  }
  const at = history?.find(([c]) => c === anchor.counter);
  if (!at) return "unproven";
  if (at[1] !== anchor.digest) throw new RollbackError(anchor.counter, got.counter, "fork");
  return "ok";
}
