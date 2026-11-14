/**
 * End-to-end encrypted presence (plan W2.20).
 *
 * In a password room the document already travels as ciphertext (`./e2e.ts`),
 * but awareness, the channel that carries names, colours and cursors, went
 * out as plain JSON: y-webrtc encrypts its own signaling with the room
 * password, the Hocuspocus server did not. Here presence gets the same split
 * as the document:
 *
 *   plain awareness      what the editor's cursors, the peer list and
 *                        `snapshotPeers` read and write. Never attached to
 *                        a provider.
 *
 *   transport awareness  the one the providers sync. Each participant's
 *                        state there is only `{ e2e: "<base64>" }`:
 *                        AES-GCM(key, JSON {n, s}) under the room's key,
 *                        where `s` is the plain state and `n` a counter.
 *
 * The client id is bound into the GCM tag (`lumen-e2e-aw|v1|<clientID>`), so
 * a relay can't show one participant's name or cursor as another's, and `n`
 * only goes up, so it can't replay an older cursor either. A state that
 * isn't sealed, or doesn't decrypt, is never shown.
 *
 * Kept free of yjs and y-protocols (it works on the small `AwarenessLike`
 * surface), so it runs in plain Node too.
 */

import { decryptOp, encryptOp, roomSalt as e2eSalt } from "./encryption";
import type { E2EErrorReason } from "./e2e";

/** Origin of the changes this bridge makes to the plain awareness. */
export const E2E_AWARENESS_ORIGIN = "e2e-awareness";
/** The only field of a participant's state on the transport awareness. */
export const E2E_AWARENESS_FIELD = "e2e";
export const E2E_AWARENESS_VERSION = 1;
/** Longest sealed state accepted (base64 characters). A cursor and a name are a few hundred. */
export const MAX_SEALED_AWARENESS = 16_384;

type Changes = { added: number[]; updated: number[]; removed: number[] };
type Listener = (changes: Changes, origin: unknown) => void;
type State = Record<string, unknown>;

/** The part of y-protocols' `Awareness` this bridge uses. */
export interface AwarenessLike {
  clientID: number;
  states: Map<number, State>;
  meta: Map<number, { clock: number; lastUpdated: number }>;
  getLocalState(): State | null;
  setLocalState(state: State | null): void;
  getStates(): Map<number, State>;
  on(event: "change" | "update", fn: Listener): void;
  off(event: "change" | "update", fn: Listener): void;
  emit(event: "change" | "update", args: [Changes, unknown]): void;
}

export interface E2EAwarenessOptions {
  password: string;
  /** The room id: the same key as the room's document. */
  room: string;
  /** Called once, on the first state that can't be opened. */
  onDecryptError?: (reason: E2EErrorReason) => void;
}

export interface E2EAwarenessBridge {
  /** Resolves once every queued encrypt/decrypt has settled. */
  whenIdle(): Promise<void>;
  destroy(): void;
}

export const awarenessAad = (clientID: number): Uint8Array => new TextEncoder().encode(`lumen-e2e-aw|v${E2E_AWARENESS_VERSION}|${clientID}`);

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Seal one plain state for the transport awareness (exported for the tests and the server's check). */
export async function sealAwarenessState(password: string, room: string, clientID: number, n: number, state: State): Promise<State> {
  const bytes = new TextEncoder().encode(JSON.stringify({ n, s: state }));
  const sealed = await encryptOp(password, bytes, { salt: e2eSalt(room), aad: awarenessAad(clientID) });
  return { [E2E_AWARENESS_FIELD]: toBase64(sealed) };
}

/** Open a sealed state; null when it isn't one of ours or doesn't decrypt. */
export async function openAwarenessState(password: string, room: string, clientID: number, sealed: string): Promise<{ n: number; s: State } | "malformed" | null> {
  if (sealed.length > MAX_SEALED_AWARENESS) return "malformed";
  const bytes = fromBase64(sealed);
  if (!bytes) return "malformed";
  const plain = await decryptOp(password, bytes, { salt: e2eSalt(room), aad: awarenessAad(clientID) });
  if (!plain) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(plain)) as { n?: unknown; s?: unknown };
    if (typeof v.n !== "number" || !v.s || typeof v.s !== "object" || Array.isArray(v.s)) return "malformed";
    return { n: v.n, s: v.s as State };
  } catch {
    return "malformed";
  }
}

/**
 * Wire `plain` ↔ `transport`. Both must have the same client id (the
 * transport doc borrows the plain doc's id, see `connectCollab`).
 */
export function wireE2EAwareness(plain: AwarenessLike, transport: AwarenessLike, opts: E2EAwarenessOptions): E2EAwarenessBridge {
  const own = plain.clientID;
  let destroyed = false;
  let errorReported = false;
  const report = (reason: E2EErrorReason) => {
    if (errorReported) return;
    errorReported = true;
    opts.onDecryptError?.(reason);
  };

  let chain: Promise<void> = Promise.resolve();
  const enqueue = (job: () => Promise<void>) => {
    chain = chain.then(job, job).catch(() => {
      /* each job handles its own failure */
    });
  };

  // ── Outbound: our plain state, sealed ────────────────────────────────
  let counter = 0;
  let pushQueued = false;
  const push = () => {
    if (pushQueued) return;
    pushQueued = true;
    enqueue(async () => {
      pushQueued = false;
      if (destroyed) return;
      // Read at run time: a burst of cursor moves is sealed once, latest wins.
      const state = plain.getLocalState();
      if (state === null) {
        transport.setLocalState(null);
        return;
      }
      const sealed = await sealAwarenessState(opts.password, opts.room, own, ++counter, state);
      if (!destroyed) transport.setLocalState(sealed);
    });
  };
  const onPlainChange: Listener = ({ added, updated, removed }, origin) => {
    if (origin === E2E_AWARENESS_ORIGIN || destroyed) return;
    if (added.includes(own) || updated.includes(own) || removed.includes(own)) push();
  };

  // ── Inbound: everyone else's sealed states, opened ──────────────────
  /** Last sealed string seen per client (a renewal re-sends the same one). */
  const lastSealed = new Map<number, string>();
  /** Highest counter shown per client: an older state is a replay. */
  const lastN = new Map<number, number>();
  /** Bumped on every new sealed state, so a slow decrypt can't overwrite a newer one. */
  const generation = new Map<number, number>();
  const nextGeneration = (id: number) => {
    const g = (generation.get(id) ?? 0) + 1;
    generation.set(id, g);
    return g;
  };

  const emit = (changes: Changes) => {
    plain.emit("change", [changes, E2E_AWARENESS_ORIGIN]);
    plain.emit("update", [changes, E2E_AWARENESS_ORIGIN]);
  };
  const show = (id: number, state: State) => {
    const had = plain.states.has(id);
    const clock = (plain.meta.get(id)?.clock ?? 0) + 1;
    plain.states.set(id, state);
    plain.meta.set(id, { clock, lastUpdated: Date.now() });
    emit(had ? { added: [], updated: [id], removed: [] } : { added: [id], updated: [], removed: [] });
  };
  const hide = (id: number) => {
    if (!plain.states.has(id)) return;
    plain.states.delete(id);
    plain.meta.delete(id);
    emit({ added: [], updated: [], removed: [id] });
  };
  const touch = (id: number) => {
    const m = plain.meta.get(id);
    if (m) m.lastUpdated = Date.now();
  };

  const ingest = (id: number) => {
    if (id === own) return;
    const raw = transport.getStates().get(id);
    const sealed = raw && typeof raw === "object" ? raw[E2E_AWARENESS_FIELD] : undefined;
    if (typeof sealed !== "string") {
      // No state, or not sealed (a peer without the key, or a plain client): never shown.
      lastSealed.delete(id);
      nextGeneration(id);
      hide(id);
      return;
    }
    if (lastSealed.get(id) === sealed) return touch(id); // a keep-alive renewal
    lastSealed.set(id, sealed);
    const g = nextGeneration(id);
    enqueue(async () => {
      if (destroyed || generation.get(id) !== g) return;
      const opened = await openAwarenessState(opts.password, opts.room, id, sealed);
      if (destroyed || generation.get(id) !== g) return;
      if (opened === null || opened === "malformed") {
        report(opened === null ? "decrypt-failed" : "malformed");
        hide(id);
        return;
      }
      if (opened.n <= (lastN.get(id) ?? 0)) return; // replayed
      lastN.set(id, opened.n);
      show(id, opened.s);
    });
  };

  const onTransportUpdate: Listener = ({ added, updated, removed }) => {
    if (destroyed) return;
    for (const id of added) ingest(id);
    for (const id of updated) ingest(id);
    for (const id of removed) {
      if (id === own) continue;
      lastSealed.delete(id);
      nextGeneration(id);
      hide(id);
    }
  };

  plain.on("change", onPlainChange);
  transport.on("update", onTransportUpdate);
  // States that arrived before the bridge, and our own state so far.
  for (const id of transport.getStates().keys()) ingest(id);
  if (plain.getLocalState() !== null) push();

  return {
    whenIdle: async () => {
      let current: Promise<void>;
      do {
        current = chain;
        await current;
      } while (current !== chain);
    },
    destroy() {
      destroyed = true;
      plain.off("change", onPlainChange);
      transport.off("update", onTransportUpdate);
    },
  };
}
