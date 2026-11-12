/**
 * LAN sync (plan W2.19): one device on the local network hosts the vault's
 * bucket (the same sealed objects a WebDAV folder or S3 bucket would hold);
 * the others reach it over a direct link and run the same encrypted sync
 * (plan 3.4) against it. Nothing here is new cryptography: the objects are
 * already sealed, their names are HMACs, the host stores and serves bytes.
 *
 * ── Requests (peer → host) ─────────────────────────────────────────────────
 *   {id, op: "challenge"}                  → {nonce}
 *   {id, op: "auth", nonce, tag}           → {tag}            mutual proof
 *   {id, op: "get", name}                  → {etag} + bytes, or {missing}
 *   {id, op: "put", name, cond?} + bytes   → {etag} | {error: "precondition"}
 *   {id, op: "delete", name}               → {}
 *   {id, op: "list"}                       → {names}
 *   host → peer, unasked: {ev: "changed"} after any write by someone else.
 *
 * ── Who may do what ────────────────────────────────────────────────────────
 * Before the proof, a peer may read only what a passphrase unlock reads: the
 * vault header and the keyring without its plaintext device map (see
 * `preAuthKeyring`). Both only let a stranger test passphrases at the
 * header's KDF cost, which any storage provider can do too. The `.prev`
 * keyring of a passphrase change is not served before the proof: the old
 * passphrase does not open the vault over the LAN while a change is cut off.
 * The proof is mutual, under the vault's pairing key (from the passphrase):
 *   peer: HMAC(pairing, "lumen-lan:1|peer|<host nonce>|<peer nonce>")
 *   host: HMAC(pairing, "lumen-lan:1|host|<peer nonce>|<host nonce>")
 * so only a device that knows the passphrase can write, list or delete, and
 * the peer knows it reached the vault's own host. The role label keeps one
 * side's proof from being reflected as the other's.
 */

import { fromB64u, randomBytes, toB64u, utf8 } from "../bytes";
import { HEADER_NAME } from "../header";
import { decodeKeyring, KEYRING_NAME, type KeyringFile } from "../keyring";
import { hmac, verifyHmac, type VaultKeys } from "../keys";
import { PreconditionFailedError, ProviderUnavailableError, type PutCondition, type StoredObject, type SyncProvider } from "../provider";
import { messenger, type LanChannel, type Message } from "./channel";

/** The objects a peer may read before it has proved it belongs to the vault: what unlocking reads. */
const PRE_AUTH: ReadonlySet<string> = new Set([HEADER_NAME, KEYRING_NAME]);

/**
 * Review W6.11 (E56): before the proof, the keyring goes out with only the
 * fields a passphrase unlock reads (engine.ts `unlockVault`): the passphrase
 * wrap, the sealed contents, the epoch and a pending header. The plaintext
 * device map (ids, age recipients, how many devices) stays with the proven
 * peers: the vault header never told a stranger that, so neither does this.
 * Any field added later is left out by default. The etag is marked, so a
 * compare-and-swap made with a pre-proof copy can only fail.
 */
const PRE_AUTH_ETAG = "pre-auth:";

function preAuthKeyring(bytes: Uint8Array, depth = 0): Uint8Array | null {
  let f: KeyringFile;
  try {
    f = decodeKeyring(bytes);
  } catch {
    return null;
  }
  // Keyring protocol 2: during a passphrase change `prev` carries the keyring it replaced (the old
  // passphrase's way back, engine.ts unlockVault). It goes out the same way, without its device map
  // (keyringDigest does not cover the devices, so the chain still checks).
  let prev: string | undefined;
  if (f.prev !== undefined) {
    const p = depth < 1 ? preAuthKeyring(fromB64u(f.prev), depth + 1) : null;
    if (!p) return null;
    prev = toB64u(p);
  }
  const out: KeyringFile = {
    format: f.format,
    protocol: f.protocol,
    vaultId: f.vaultId,
    epoch: f.epoch,
    passphrase: f.passphrase,
    devices: {},
    sealed: f.sealed,
    ...(f.header !== undefined ? { header: f.header } : {}),
    ...(prev !== undefined ? { prev } : {}),
  };
  return utf8(JSON.stringify(out));
}

export const LAN_PROTOCOL = 1;
export const REQUEST_TIMEOUT_MS = 15_000;
const MAX_NAME = 256;

const proofData = (role: "host" | "peer", theirs: string, mine: string) => utf8(`lumen-lan:${LAN_PROTOCOL}|${role}|${theirs}|${mine}`);

export class LanAuthError extends Error {
  constructor(message = "The other device is not part of this vault") {
    super(message);
    this.name = "LanAuthError";
  }
}

/** The host is there but can't serve yet (its vault is locked). */
export class LanHostLockedError extends ProviderUnavailableError {
  constructor() {
    super("The hosting device's vault is locked");
    this.name = "LanHostLockedError";
  }
}

const isName = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= MAX_NAME;

function readCond(x: unknown): PutCondition | null {
  if (x === undefined || x === null) return undefined;
  if (typeof x !== "object") return null;
  const c = x as { ifMatch?: unknown; ifNoneMatch?: unknown };
  if (typeof c.ifMatch === "string") return { ifMatch: c.ifMatch };
  if (c.ifNoneMatch === "*") return { ifNoneMatch: "*" };
  return null;
}

/* ─── The host ─────────────────────────────────────────────────────────── */

export interface LanPeerInfo {
  /** The peer's LAN address, when the link knows it. */
  address: string | null;
  authed: boolean;
  connectedAt: number;
}

export interface LanHostOptions {
  /** Where the sealed objects live on this device. */
  bucket: SyncProvider;
  /** The vault's keys while it is unlocked here (to check the peers' proofs). */
  keys: () => VaultKeys | null;
}

export interface LanHost {
  /** The bucket for this device's own sync engine: its writes tell the peers. */
  readonly provider: SyncProvider;
  /** Serve one peer over `channel`. Returns the detach function. */
  attach(channel: LanChannel, info?: { address?: string | null }): () => void;
  peers(): LanPeerInfo[];
  /** Called after a peer wrote (this device should sync). */
  onPeerWrite(fn: () => void): () => void;
  /** Called when a peer comes, proves itself or goes. */
  onPeersChange(fn: () => void): () => void;
  close(): void;
}

interface Conn {
  send: (header: Record<string, unknown>, payload?: Uint8Array) => void;
  channel: LanChannel;
  nonce: string;
  authed: boolean;
  info: LanPeerInfo;
}

export function lanHost(opts: LanHostOptions): LanHost {
  const conns = new Set<Conn>();
  const writeListeners = new Set<() => void>();
  const peerListeners = new Set<() => void>();
  const inner = opts.bucket;
  const peersChanged = () => {
    for (const l of [...peerListeners]) l();
  };

  /** Tell every proven peer but `except` that the bucket changed; a peer's write also tells this device. */
  const changed = (except: Conn | null) => {
    for (const c of conns) if (c !== except && c.authed) c.send({ ev: "changed" });
    if (except) for (const l of [...writeListeners]) l();
  };

  async function handle(c: Conn, { header, payload }: Message): Promise<void> {
    const id = header.id;
    const reply = (h: Record<string, unknown>, p?: Uint8Array) => c.send({ ...h, id }, p);
    const op = header.op;
    if (op === "challenge") return reply({ nonce: c.nonce, v: LAN_PROTOCOL });
    if (op === "auth") {
      const keys = opts.keys();
      if (!keys) return reply({ error: "locked" });
      let tag: Uint8Array;
      try {
        tag = fromB64u(String(header.tag ?? ""));
      } catch {
        tag = new Uint8Array();
      }
      const theirNonce = typeof header.nonce === "string" ? header.nonce : "";
      if (theirNonce.length < 16 || !(await verifyHmac(keys.pairing, tag, proofData("peer", c.nonce, theirNonce)))) {
        reply({ error: "auth" });
        // After the answer has left: the peer learns why before the link drops.
        setTimeout(() => c.channel.close(), 100);
        return;
      }
      c.authed = true;
      c.info.authed = true;
      peersChanged();
      return reply({ tag: toB64u(await hmac(keys.pairing, proofData("host", theirNonce, c.nonce))) });
    }
    if (op === "get") {
      if (!isName(header.name)) return reply({ error: "bad-request" });
      // Before the proof, only what unlocking needs: the header and, since the keyring (W1.7, #399), the
      // keyring, from whose current epoch the pairing key derives. Both are sealed for an untrusted bucket,
      // and the header already lets anyone holding it test passphrases, so the keyring adds nothing to that.
      if (!c.authed && !PRE_AUTH.has(header.name)) return reply({ error: "auth" });
      const o = await inner.get(header.name);
      if (!o) return reply({ missing: true });
      if (!c.authed && header.name === KEYRING_NAME) {
        const pre = preAuthKeyring(o.data);
        return pre ? reply({ etag: PRE_AUTH_ETAG + o.etag }, pre) : reply({ error: "unavailable" });
      }
      return reply({ etag: o.etag }, o.data);
    }
    if (!c.authed) return reply({ error: "auth" });
    if (op === "put") {
      const cond = readCond(header.cond);
      if (!isName(header.name) || cond === null) return reply({ error: "bad-request" });
      try {
        const r = await inner.put(header.name, payload, cond);
        reply({ etag: r.etag });
      } catch (e) {
        if (e instanceof PreconditionFailedError) return reply({ error: "precondition" });
        throw e;
      }
      return changed(c);
    }
    if (op === "delete") {
      if (!isName(header.name)) return reply({ error: "bad-request" });
      await inner.delete(header.name);
      reply({});
      return changed(c);
    }
    if (op === "list") return reply({ names: await inner.list() });
    return reply({ error: "bad-request" });
  }

  const provider: SyncProvider = {
    id: "lan-host",
    get: (name) => inner.get(name),
    list: () => inner.list(),
    async put(name, data, cond) {
      const r = await inner.put(name, data, cond);
      changed(null);
      return r;
    },
    async delete(name) {
      await inner.delete(name);
      changed(null);
    },
  };

  return {
    provider,
    attach(channel, info = {}) {
      const m = messenger(channel);
      const c: Conn = { send: m.send, channel, nonce: toB64u(randomBytes(16)), authed: false, info: { address: info.address ?? null, authed: false, connectedAt: Date.now() } };
      conns.add(c);
      // One request at a time per peer, in order (a sync round is sequential anyway).
      let chain: Promise<void> = Promise.resolve();
      const off = m.onMessage((msg) => {
        chain = chain.then(() =>
          handle(c, msg).catch(() => {
            c.send({ id: msg.header.id, error: "unavailable" });
          }),
        );
      });
      const detach = () => {
        off();
        if (conns.delete(c)) peersChanged();
      };
      channel.onClose(detach);
      peersChanged();
      return () => {
        detach();
        channel.close();
      };
    },
    peers: () => [...conns].map((c) => ({ ...c.info })),
    onPeerWrite(fn) {
      writeListeners.add(fn);
      return () => writeListeners.delete(fn);
    },
    onPeersChange(fn) {
      peerListeners.add(fn);
      return () => peerListeners.delete(fn);
    },
    close() {
      for (const c of [...conns]) c.channel.close();
      conns.clear();
    },
  };
}

/* ─── A peer: the host's bucket as a SyncProvider ───────────────────────── */

export interface RemoteLanProvider extends SyncProvider {
  /** Prove this device belongs to the vault, and check the host does. Needed before anything but the header. */
  authenticate(keys: VaultKeys): Promise<void>;
  /** Called when the host says the bucket changed. */
  onChanged(fn: () => void): () => void;
  readonly closed: boolean;
  close(): void;
}

export function remoteLanProvider(channel: LanChannel, opts: { timeoutMs?: number } = {}): RemoteLanProvider {
  const m = messenger(channel);
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let nextId = 1;
  const pending = new Map<number, { resolve: (m: Message) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const changeListeners = new Set<() => void>();

  m.onMessage((msg) => {
    if (msg.header.ev === "changed") {
      for (const l of [...changeListeners]) l();
      return;
    }
    const id = msg.header.id;
    const p = typeof id === "number" ? pending.get(id) : undefined;
    if (!p) return;
    pending.delete(id as number);
    clearTimeout(p.timer);
    p.resolve(msg);
  });
  channel.onClose(() => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new ProviderUnavailableError("The link to the hosting device closed"));
    }
    pending.clear();
  });

  const request = (header: Record<string, unknown>, payload?: Uint8Array): Promise<Message> =>
    new Promise((resolve, reject) => {
      if (channel.closed) return reject(new ProviderUnavailableError("Not connected to the hosting device"));
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new ProviderUnavailableError("The hosting device did not answer"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      m.send({ ...header, id }, payload);
    });

  const fail = (header: Record<string, unknown>, name: string): Error => {
    switch (header.error) {
      case "precondition":
        return new PreconditionFailedError(name);
      case "auth":
        return new LanAuthError();
      case "locked":
        return new LanHostLockedError();
      default:
        return new ProviderUnavailableError(`The hosting device refused the request (${String(header.error)})`);
    }
  };
  const call = async (header: Record<string, unknown>, payload?: Uint8Array): Promise<Message> => {
    const r = await request(header, payload);
    if (r.header.error !== undefined) throw fail(r.header, typeof header.name === "string" ? header.name : "");
    return r;
  };

  return {
    id: "lan",
    get closed() {
      return channel.closed;
    },
    async get(name): Promise<StoredObject | null> {
      const r = await call({ op: "get", name });
      if (r.header.missing) return null;
      return { data: r.payload, etag: String(r.header.etag) };
    },
    async put(name, data, cond) {
      const r = await call({ op: "put", name, ...(cond ? { cond } : {}) }, data);
      return { etag: String(r.header.etag) };
    },
    async delete(name) {
      await call({ op: "delete", name });
    },
    async list() {
      const r = await call({ op: "list" });
      return Array.isArray(r.header.names) ? r.header.names.filter(isName) : [];
    },
    async authenticate(keys) {
      const challenge = await call({ op: "challenge" });
      const hostNonce = String(challenge.header.nonce ?? "");
      const nonce = toB64u(randomBytes(16));
      const tag = await hmac(keys.pairing, proofData("peer", hostNonce, nonce));
      const r = await call({ op: "auth", nonce, tag: toB64u(tag) });
      let hostTag: Uint8Array;
      try {
        hostTag = fromB64u(String(r.header.tag ?? ""));
      } catch {
        hostTag = new Uint8Array();
      }
      if (!(await verifyHmac(keys.pairing, hostTag, proofData("host", nonce, hostNonce)))) {
        channel.close();
        throw new LanAuthError("The hosting device is not part of this vault");
      }
    },
    onChanged(fn) {
      changeListeners.add(fn);
      return () => changeListeners.delete(fn);
    },
    close() {
      channel.close();
    },
  };
}

/* ─── Live sync: a round soon after any change ─────────────────────────── */

/**
 * Runs `round` shortly after `kick()` (debounced), never two at once, and
 * once more if a change came in while a round was running. The LAN sync
 * kicks it on every local edit and every "changed" from the other side, so
 * a change reaches the other device in about two round trips.
 */
export function liveSync(round: () => Promise<unknown>, opts: { debounceMs?: number } = {}) {
  const debounceMs = opts.debounceMs ?? 150;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  const fire = () => {
    timer = null;
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = round()
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        running = null;
        if (again && !stopped) {
          again = false;
          kick();
        }
      });
  };
  const kick = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
  };
  return {
    kick,
    /** Resolves once no round is scheduled or running. */
    async idle(): Promise<void> {
      while (timer || running) await (running ?? new Promise((r) => setTimeout(r, debounceMs)));
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
