/**
 * The "local network" sync provider (plan W2.19), next to WebDAV, S3,
 * Dropbox and Google Drive: no cloud, no server, no internet needed.
 *
 *   host  this device keeps the vault's bucket (IndexedDB) and serves it to
 *         the devices it paired with; its own sync runs against it directly.
 *   peer  this device reaches a host over a LAN link (./link.ts) and syncs
 *         against the host's bucket, end-to-end encrypted as everywhere.
 *
 * Both sync live: a round runs shortly after a local edit and after the
 * other side reports a change, so an edit reaches the other device within
 * a couple of seconds.
 */

import { HEADER_NAME } from "../header";
import type { VaultKeys } from "../keys";
import { ProviderUnavailableError, type SyncProvider } from "../provider";
import { hostBucket } from "./bucket";
import { lanHost, remoteLanProvider, type LanHost, type RemoteLanProvider } from "./rpc";
import type { LanLink } from "./link";

export type LanRole = "host" | "peer";

/** What the sync session can do with a provider beyond storing objects. */
export interface LiveProvider extends SyncProvider {
  probe?(): Promise<void>;
  /** The vault was unlocked on this device (the LAN host checks peers with it; a peer proves itself). */
  unlocked?(keys: VaultKeys): Promise<void>;
  locked?(): void;
  /** The other side changed the bucket. Returns the unsubscribe function. */
  onRemoteChange?(fn: () => void): () => void;
  /** Sync soon after every local edit, not only every few minutes. */
  readonly live?: boolean;
}

export class LanNotConnectedError extends ProviderUnavailableError {
  constructor() {
    super("Not connected to a device on this network");
    this.name = "LanNotConnectedError";
  }
}

/** The host has no vault yet: it is created (or unlocked) on the host first. */
export class LanNoVaultError extends Error {
  constructor() {
    super("The hosting device has no vault yet");
    this.name = "LanNoVaultError";
  }
}

/* ─── This device as the host ──────────────────────────────────────────── */

let host: LanHost | null = null;
let hostKeys: VaultKeys | null = null;

/** The host of this tab (one bucket per device). */
export function thisHost(): LanHost {
  return (host ??= lanHost({ bucket: hostBucket(), keys: () => hostKeys }));
}

function hostProvider(): LiveProvider {
  const h = thisHost();
  return {
    id: "lan-host",
    get: (n) => h.provider.get(n),
    put: (n, d, c) => h.provider.put(n, d, c),
    delete: (n) => h.provider.delete(n),
    list: () => h.provider.list(),
    live: true,
    async unlocked(keys) {
      hostKeys = keys;
    },
    locked() {
      hostKeys = null;
    },
    onRemoteChange: (fn) => h.onPeerWrite(fn),
  };
}

/* ─── This device as a peer ────────────────────────────────────────────── */

interface PeerLink {
  link: LanLink;
  remote: RemoteLanProvider;
  /** The proof on this link, once the vault is unlocked here (a new link proves itself again). */
  auth: Promise<void> | null;
}

let peer: PeerLink | null = null;
let peerKeys: VaultKeys | null = null;
const peerListeners = new Set<() => void>();
const changeListeners = new Set<() => void>();
let offChanged: (() => void) | null = null;

/** Use `link` (just opened from the pairing dialog) as this device's way to its host. */
export function adoptPeerLink(link: LanLink): RemoteLanProvider {
  peer?.link.close();
  offChanged?.();
  const remote = remoteLanProvider(link.channel);
  peer = { link, remote, auth: null };
  offChanged = remote.onChanged(() => {
    for (const l of [...changeListeners]) l();
  });
  link.channel.onClose(() => {
    if (peer?.link !== link) return;
    peer = null;
    for (const l of [...peerListeners]) l();
  });
  for (const l of [...peerListeners]) l();
  return remote;
}

export function peerLink(): LanLink | null {
  return peer?.link ?? null;
}

export function onPeerLinkChange(fn: () => void): () => void {
  peerListeners.add(fn);
  return () => peerListeners.delete(fn);
}

/** The host's bucket over the current link, proven once the vault is unlocked here. */
async function current(): Promise<RemoteLanProvider> {
  const p = peer;
  if (!p || p.remote.closed) throw new LanNotConnectedError();
  if (peerKeys) {
    if (!p.auth) {
      p.auth = p.remote.authenticate(peerKeys);
      p.auth.catch(() => {
        if (peer === p) p.auth = null;
      });
    }
    await p.auth;
  }
  return p.remote;
}

/**
 * Ask a service on the host this device is linked to (plan W6.19: dictation
 * sent to the desktop). Null when there is no link, or the vault isn't
 * unlocked here yet (a service needs the proof, and the proof needs the keys).
 */
export function peerService(): { address: string | null; call: RemoteLanProvider["service"]; keys: VaultKeys } | null {
  const p = peer;
  if (!p || p.remote.closed || !peerKeys) return null;
  const keys = peerKeys;
  return {
    address: p.link.remoteAddress ?? null,
    keys,
    call: async (op, header, payload, opts) => (await current()).service(op, header, payload, opts),
  };
}

function peerProvider(): LiveProvider {
  return {
    id: "lan",
    get: async (n) => (await current()).get(n),
    put: async (n, d, c) => (await current()).put(n, d, c),
    delete: async (n) => (await current()).delete(n),
    list: async () => (await current()).list(),
    live: true,
    async probe() {
      // A peer joins a vault; it never creates one on someone else's device.
      if (!(await (await current()).get(HEADER_NAME))) throw new LanNoVaultError();
    },
    async unlocked(keys) {
      peerKeys = keys;
      if (peer) peer.auth = null;
      await current();
    },
    locked() {
      peerKeys = null;
    },
    onRemoteChange(fn) {
      changeListeners.add(fn);
      return () => changeListeners.delete(fn);
    },
  };
}

/** The provider for `role` (the sync providers' registry calls this for kind "lan"). */
export function lanSyncProvider(role: LanRole): LiveProvider {
  return role === "host" ? hostProvider() : peerProvider();
}

/** @internal tests: forget this tab's host and link. */
export function __resetLan(): void {
  host?.close();
  host = null;
  hostKeys = null;
  peer?.link.close();
  peer = null;
  peerKeys = null;
  offChanged?.();
  offChanged = null;
  peerListeners.clear();
  changeListeners.clear();
}
