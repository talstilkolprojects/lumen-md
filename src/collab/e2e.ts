/**
 * End-to-end encrypted Yjs transport for password-protected rooms.
 *
 * Two documents per session:
 *
 *   plaintext doc  — what the editor, comments and version history bind to.
 *                    It is NEVER attached to a network provider, so its
 *                    updates never leave this tab unencrypted.
 *
 *   transport doc  — the only doc y-webrtc / y-websocket see. It holds a
 *                    single append-only `Y.Array` ("e2e") of envelopes:
 *
 *                      { v: 2, iv: Uint8Array(12), ct: Uint8Array, s?: 1 }
 *
 *                    `ct` is AES-GCM(key, yjsUpdate) where the key is
 *                    PBKDF2(password, "lumen.collab.v2|<room>"). The
 *                    format version and snapshot flag are bound into the
 *                    GCM tag as additional authenticated data, so a relay
 *                    can't flip a delta into a "snapshot" or vice versa.
 *
 * Data flow:
 *
 *   local edit → plaintext `update` (origin ≠ E2E_REMOTE_ORIGIN)
 *              → queue → mergeUpdates → encrypt → push envelope (origin
 *                E2E_LOCAL_ORIGIN) into the transport array → providers
 *                replicate ciphertext.
 *
 *   remote envelope (transport array insert, origin ≠ E2E_LOCAL_ORIGIN)
 *              → decrypt → `Y.applyUpdate(plaintext, bytes, E2E_REMOTE_ORIGIN)`.
 *                A failed decrypt (wrong password, tampered envelope) is
 *                reported via `onDecryptError` and nothing is applied.
 *
 * Remote updates are tagged with E2E_REMOTE_ORIGIN and the plaintext
 * listener ignores that origin, so a received edit is never re-encrypted
 * (no update loop). Yjs buffers updates whose dependencies haven't
 * arrived yet (`store.pendingStructs`), so envelopes may be decrypted and
 * applied in any order.
 *
 * Compaction: once the array holds more than `compactThreshold`
 * envelopes, the peer that just pushed one encrypts a full-state snapshot
 * of its plaintext doc, pushes it with `s: 1`, and deletes exactly the
 * envelopes it has already applied (entries it hasn't seen — e.g. a
 * concurrent push from another peer — are kept). This is only attempted
 * when every applied envelope decrypted cleanly and the plaintext doc has
 * no pending (dependency-blocked) structs, so the snapshot provably covers
 * everything it replaces.
 */

import * as Y from "yjs";
import { decryptOp, encryptOp } from "./encryption";

export const E2E_REMOTE_ORIGIN = "e2e-remote";
export const E2E_LOCAL_ORIGIN = "e2e-local";
export const E2E_ARRAY_NAME = "e2e";
export const E2E_VERSION = 2;
export const DEFAULT_COMPACT_THRESHOLD = 500;

export interface Envelope {
  v: number;
  iv: Uint8Array;
  ct: Uint8Array;
  /** 1 = full-state snapshot envelope. */
  s?: 1;
}

export type E2EErrorReason = "decrypt-failed" | "malformed" | "unsupported-version";

export interface E2EOptions {
  password: string;
  /** Room id — scopes the key so equal passwords in different rooms differ. */
  room: string;
  /** Called at most once per channel, on the first failed envelope. */
  onDecryptError?: (reason: E2EErrorReason) => void;
  /** Envelope count that triggers snapshot compaction. 0 disables it. */
  compactThreshold?: number;
}

export interface E2EChannel {
  /** Resolves once every queued encrypt/decrypt has settled. */
  whenIdle(): Promise<void>;
  /** Number of envelopes currently in the transport array. */
  envelopeCount(): number;
  destroy(): void;
}

export function e2eSalt(room: string): string {
  return `lumen.collab.v2|${room}`;
}

function aadFor(snapshot: boolean): Uint8Array {
  return new TextEncoder().encode(`lumen-e2e|v${E2E_VERSION}|${snapshot ? "s" : "u"}`);
}

function isEnvelope(x: unknown): x is Envelope {
  if (!x || typeof x !== "object") return false;
  const e = x as Partial<Envelope>;
  return (
    typeof e.v === "number" &&
    e.iv instanceof Uint8Array &&
    e.ct instanceof Uint8Array
  );
}

function hasPending(doc: Y.Doc): boolean {
  return doc.store.pendingStructs !== null || doc.store.pendingDs !== null;
}

/**
 * Wire `plainDoc` ↔ `transportDoc`. Existing envelopes in the transport
 * doc (e.g. from a persistent server) are decrypted immediately; any
 * content already in `plainDoc` is encrypted and published.
 */
export function wireE2E(
  plainDoc: Y.Doc,
  transportDoc: Y.Doc,
  opts: E2EOptions,
): E2EChannel {
  const arr = transportDoc.getArray<Envelope>(E2E_ARRAY_NAME);
  const ctx = (snapshot: boolean) => ({ salt: e2eSalt(opts.room), aad: aadFor(snapshot) });
  const threshold = opts.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;

  let destroyed = false;
  let errorReported = false;
  let anyFailure = false;
  /** Envelopes whose content is already reflected in plainDoc. */
  const applied = new WeakSet<Envelope>();

  // One serial chain for all crypto work keeps envelope order stable and
  // makes `whenIdle()` meaningful.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (job: () => Promise<void>) => {
    chain = chain.then(job, job).catch(() => {
      /* why: individual jobs report their own errors */
    });
  };

  const reportError = (reason: E2EErrorReason) => {
    anyFailure = true;
    if (errorReported) return;
    errorReported = true;
    opts.onDecryptError?.(reason);
  };

  // ── Outbound ────────────────────────────────────────────────────────
  let outbox: Uint8Array[] = [];
  let flushScheduled = false;

  const flush = async () => {
    flushScheduled = false;
    if (destroyed || outbox.length === 0) return;
    const batch = outbox;
    outbox = [];
    const update = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch);
    const sealed = await encryptOp(opts.password, update, ctx(false));
    if (destroyed) return;
    const env: Envelope = {
      v: E2E_VERSION,
      iv: sealed.slice(0, 12),
      ct: sealed.slice(12),
    };
    applied.add(env); // our own content is in plainDoc already
    transportDoc.transact(() => arr.push([env]), E2E_LOCAL_ORIGIN);
    if (threshold > 0 && arr.length > threshold) await compact();
  };

  const compact = async () => {
    if (destroyed || anyFailure || hasPending(plainDoc)) return;
    const covered = arr.toArray().filter((e) => applied.has(e));
    if (covered.length < 2) return;
    const coveredSet = new Set(covered);
    const sealed = await encryptOp(
      opts.password,
      Y.encodeStateAsUpdate(plainDoc),
      ctx(true),
    );
    if (destroyed || hasPending(plainDoc)) return;
    const snap: Envelope = {
      v: E2E_VERSION,
      iv: sealed.slice(0, 12),
      ct: sealed.slice(12),
      s: 1,
    };
    applied.add(snap);
    transportDoc.transact(() => {
      // Delete back-to-front so indices stay valid.
      const items = arr.toArray();
      for (let i = items.length - 1; i >= 0; i--) {
        if (coveredSet.has(items[i])) arr.delete(i, 1);
      }
      arr.push([snap]);
    }, E2E_LOCAL_ORIGIN);
  };

  const onPlainUpdate = (update: Uint8Array, origin: unknown) => {
    if (destroyed || origin === E2E_REMOTE_ORIGIN) return;
    outbox.push(update);
    if (!flushScheduled) {
      flushScheduled = true;
      enqueue(flush);
    }
  };

  // ── Inbound ─────────────────────────────────────────────────────────
  const ingest = (envs: unknown[]) => {
    for (const raw of envs) {
      if (!isEnvelope(raw)) {
        reportError("malformed");
        continue;
      }
      if (applied.has(raw)) continue;
      enqueue(async () => {
        if (destroyed || applied.has(raw)) return;
        if (raw.v !== E2E_VERSION) {
          reportError("unsupported-version");
          return;
        }
        const payload = new Uint8Array(raw.iv.length + raw.ct.length);
        payload.set(raw.iv, 0);
        payload.set(raw.ct, raw.iv.length);
        const plain = await decryptOp(opts.password, payload, ctx(raw.s === 1));
        if (destroyed) return;
        if (!plain) {
          reportError("decrypt-failed");
          return;
        }
        try {
          Y.applyUpdate(plainDoc, plain, E2E_REMOTE_ORIGIN);
        } catch {
          reportError("malformed");
          return;
        }
        applied.add(raw);
      });
    }
  };

  const onArray = (event: Y.YArrayEvent<Envelope>) => {
    if (event.transaction.origin === E2E_LOCAL_ORIGIN) return;
    const inserted: unknown[] = [];
    for (const d of event.changes.delta) {
      if (Array.isArray(d.insert)) inserted.push(...d.insert);
    }
    ingest(inserted);
  };

  plainDoc.on("update", onPlainUpdate);
  arr.observe(onArray);

  // History already present (e.g. a provider synced before we wired up).
  ingest(arr.toArray());
  // Content already present locally (e.g. seeded before wiring).
  if (plainDoc.store.clients.size > 0) {
    onPlainUpdate(Y.encodeStateAsUpdate(plainDoc), null);
  }

  return {
    whenIdle: async () => {
      // The chain can grow while we wait; loop until it is stable.
      let current: Promise<void>;
      do {
        current = chain;
        await current;
      } while (current !== chain);
    },
    envelopeCount: () => arr.length,
    destroy() {
      destroyed = true;
      plainDoc.off("update", onPlainUpdate);
      arr.unobserve(onArray);
    },
  };
}
