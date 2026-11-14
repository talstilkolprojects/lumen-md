/**
 * A room of the public collab relay (plan W4.8): end-to-end encrypted
 * documents only, so the server never holds a note's text.
 *
 * Two pieces, shared by both servers:
 *
 *   checkE2eeUpdate(doc, update)   is this Yjs update, applied to the room's
 *                                  document, still nothing but encrypted
 *                                  envelopes? (src/collab/e2e.ts writes one
 *                                  `Y.Array("e2e")` of {v, iv, ct, s?}.)
 *                                  `collab-server.mjs` runs it before
 *                                  Hocuspocus applies a message when
 *                                  COLLAB_E2EE_ONLY=1; the Worker always.
 *
 *   createRelayRoom(opts)          the Hocuspocus wire protocol (v4: auth,
 *                                  sync, awareness, sync status) for one
 *                                  document, on any socket with send/close.
 *                                  The Cloudflare Durable Object in
 *                                  edge-workers/collab/ hosts one per room.
 *
 * Awareness (cursors and the random display name) is relayed between the
 * people in the room and kept in memory only; it is never stored.
 */
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";

export const E2E_ARRAY = "e2e";

/** Hocuspocus message types (packages/server/src/types.ts, v4.7.0). */
export const MessageType = { Sync: 0, Awareness: 1, Auth: 2, QueryAwareness: 3, SyncReply: 4, Stateless: 5, CLOSE: 7, SyncStatus: 8 };
const SyncStep1 = 0;
const SyncStep2 = 1;
const SyncUpdate = 2;
const AuthToken = 0;
const AuthPermissionDenied = 1;
const AuthAuthenticated = 2;

/** Close codes the provider understands (@hocuspocus/common CloseEvents). */
export const Close = {
  Forbidden: { code: 4403, reason: "Forbidden" },
  TooLarge: { code: 4413, reason: "Room too large" },
  Reset: { code: 4205, reason: "Reset Content" },
};

const isBytes = (x) => x instanceof Uint8Array;

/** Is `x` exactly one envelope of src/collab/e2e.ts: {v, iv(12), ct(≥16), s?: 1}? */
function isEnvelope(x) {
  if (!x || typeof x !== "object" || Array.isArray(x) || isBytes(x)) return false;
  for (const k of Object.keys(x)) if (k !== "v" && k !== "iv" && k !== "ct" && k !== "s") return false;
  return (
    typeof x.v === "number" &&
    Number.isInteger(x.v) &&
    isBytes(x.iv) &&
    x.iv.byteLength === 12 &&
    isBytes(x.ct) &&
    x.ct.byteLength >= 16 &&
    (x.s === undefined || x.s === 1)
  );
}

/** Does a top-level type hold anything at all? */
const hasContent = (type) => type._start !== null || type._map.size > 0;

/**
 * Null when `doc` with `update` applied holds only encrypted envelopes in
 * `Y.Array("e2e")`; otherwise why not: "plaintext" (any other content),
 * "not-envelope", "incomplete" (the update needs structs the room does not
 * have, so it can't be checked), or "malformed".
 * `doc` itself is not changed.
 */
export function checkE2eeUpdate(doc, update) {
  const probe = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(probe, update);
  } catch {
    probe.destroy();
    return "malformed";
  }
  try {
    if (probe.store.pendingStructs !== null || probe.store.pendingDs !== null) return "incomplete";
    for (const [name, type] of probe.share) {
      if (name === E2E_ARRAY) continue;
      if (hasContent(type)) return "plaintext";
    }
    const raw = probe.share.get(E2E_ARRAY);
    if (!raw) return null;
    if (raw._map.size > 0) return "plaintext";
    const items = probe.getArray(E2E_ARRAY).toArray();
    for (const item of items) if (!isEnvelope(item)) return "not-envelope";
    return null;
  } finally {
    probe.destroy();
  }
}

/**
 * The Yjs update a Hocuspocus client message carries (sync step 2 or an
 * update), or null for every other message. For `beforeHandleMessage`.
 */
export function updateInMessage(message) {
  try {
    const d = decoding.createDecoder(message);
    decoding.readVarString(d);
    const type = decoding.readVarUint(d);
    if (type !== MessageType.Sync && type !== MessageType.SyncReply) return null;
    const step = decoding.readVarUint(d);
    if (step !== SyncStep2 && step !== SyncUpdate) return null;
    return decoding.readVarUint8Array(d);
  } catch {
    return null;
  }
}

function frame(address, type, write) {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, address);
  encoding.writeVarUint(e, type);
  write?.(e);
  return encoding.toUint8Array(e);
}

/**
 * One room. `state` is what was stored (or null); `onChange(doc)` follows
 * every change, for the host to store (debounced).
 * `authorize(token, documentName, socket)` resolves true to let a connection in;
 * `onAuthenticated(socket, address)` follows (the Worker stores it with the
 * socket). Updates that would make the room larger than `maxBytes` close
 * the connection.
 *
 *   const room = createRelayRoom({ name, state, authorize, onChange })
 *   const peer = room.join({ send(bytes), close(code, reason) })
 *   peer.receive(bytes) … peer.leave()
 */
export function createRelayRoom({ name, state = null, authorize, onChange = () => {}, onAuthenticated = () => {}, e2eeOnly = true, maxBytes = 4_000_000 }) {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, state);
  const awareness = new Awareness(doc);
  awareness.setLocalState(null); // the server is not a participant
  const peers = new Set();
  let bytes = state ? state.byteLength : 0;

  doc.on("update", (update, origin) => {
    for (const p of peers) if (p !== origin && p.ready) p.socket.send(frame(p.address, MessageType.Sync, (e) => {
      encoding.writeVarUint(e, SyncUpdate);
      encoding.writeVarUint8Array(e, update);
    }));
    bytes = Y.encodeStateAsUpdate(doc).byteLength;
    onChange(doc);
  });
  awareness.on("update", ({ added, updated, removed }, origin) => {
    const changed = added.concat(updated, removed);
    const msg = encodeAwarenessUpdate(awareness, changed);
    for (const p of peers) if (p.ready) p.socket.send(frame(p.address, MessageType.Awareness, (e) => encoding.writeVarUint8Array(e, msg)));
    if (origin && origin.clients) for (const id of added) origin.clients.add(id);
  });

  function applyChecked(peer, update) {
    if (e2eeOnly) {
      const why = checkE2eeUpdate(doc, update);
      if (why) {
        // As Hocuspocus does: a CLOSE message with the reason, for the
        // provider, then the socket.
        peer.socket.send(frame(peer.address, MessageType.SyncStatus, (e) => encoding.writeVarUint(e, 0)));
        peer.socket.send(frame(peer.address, MessageType.CLOSE, (e) => encoding.writeVarString(e, `e2ee-only: ${why}`)));
        peer.socket.close(Close.Forbidden.code, `e2ee-only: ${why}`);
        return false;
      }
    }
    if (bytes + update.byteLength > maxBytes) {
      peer.socket.close(Close.TooLarge.code, Close.TooLarge.reason);
      return false;
    }
    Y.applyUpdate(doc, update, peer);
    peer.socket.send(frame(peer.address, MessageType.SyncStatus, (e) => encoding.writeVarUint(e, 1)));
    return true;
  }

  return {
    doc,
    get size() {
      return bytes;
    },
    get peerCount() {
      return peers.size;
    },
    state: () => Y.encodeStateAsUpdate(doc),
    /**
     * A connection joins. `resume` brings back one that was already let in
     * (a Durable Object woken from hibernation keeps the socket, not this
     * object).
     */
    join(socket, resume = null) {
      const peer = { socket, ready: Boolean(resume?.ready), address: resume?.address ?? name, clients: new Set(), queue: [] };
      peers.add(peer);
      const handle = (data) => {
        const d = decoding.createDecoder(data);
        const address = decoding.readVarString(d);
        const sep = address.indexOf("\0");
        if ((sep === -1 ? address : address.slice(0, sep)) !== name) return socket.close(Close.Forbidden.code, "wrong-room");
        peer.address = address;
        const type = decoding.readVarUint(d);
        switch (type) {
          case MessageType.Sync:
          case MessageType.SyncReply: {
            const step = decoding.readVarUint(d);
            if (step === SyncStep1) {
              const sv = decoding.readVarUint8Array(d);
              socket.send(frame(address, MessageType.Sync, (e) => {
                encoding.writeVarUint(e, SyncStep2);
                encoding.writeVarUint8Array(e, Y.encodeStateAsUpdate(doc, sv));
              }));
              // Ask for what the client has (as Hocuspocus does over a socket:
              // a Sync message; SyncReply is only for direct connections).
              if (type === MessageType.Sync)
                socket.send(frame(address, MessageType.Sync, (e) => {
                  encoding.writeVarUint(e, SyncStep1);
                  encoding.writeVarUint8Array(e, Y.encodeStateVector(doc));
                }));
            } else if (step === SyncStep2 || step === SyncUpdate) {
              applyChecked(peer, decoding.readVarUint8Array(d));
            }
            return;
          }
          case MessageType.Awareness:
            applyAwarenessUpdate(awareness, decoding.readVarUint8Array(d), peer);
            return;
          case MessageType.QueryAwareness:
            socket.send(frame(address, MessageType.Awareness, (e) =>
              encoding.writeVarUint8Array(e, encodeAwarenessUpdate(awareness, [...awareness.getStates().keys()])),
            ));
            return;
          case MessageType.CLOSE:
            socket.close(1000, "provider_initiated");
            return;
          default:
            return; // stateless messages and the rest: nothing to relay here
        }
      };
      return {
        async receive(data) {
          if (peer.ready) return handle(data);
          const d = decoding.createDecoder(data);
          const address = decoding.readVarString(d);
          const type = decoding.readVarUint(d);
          if (type !== MessageType.Auth) {
            if (peer.queue.length >= 64) return socket.close(Close.Reset.code, Close.Reset.reason);
            peer.queue.push(data);
            return;
          }
          decoding.readVarUint(d); // AuthToken
          const token = decoding.readVarString(d);
          const sep = address.indexOf("\0");
          const docName = sep === -1 ? address : address.slice(0, sep);
          let ok = false;
          try {
            ok = docName === name && (await authorize(token, docName, socket));
          } catch {
            ok = false;
          }
          if (!ok) {
            socket.send(frame(address, MessageType.Auth, (e) => {
              encoding.writeVarUint(e, AuthPermissionDenied);
              encoding.writeVarString(e, "permission-denied");
            }));
            return;
          }
          peer.address = address;
          socket.send(frame(address, MessageType.Auth, (e) => {
            encoding.writeVarUint(e, AuthAuthenticated);
            encoding.writeVarString(e, "read-write");
          }));
          peer.ready = true;
          onAuthenticated(socket, address);
          if (awareness.getStates().size > 0)
            socket.send(frame(address, MessageType.Awareness, (e) =>
              encoding.writeVarUint8Array(e, encodeAwarenessUpdate(awareness, [...awareness.getStates().keys()])),
            ));
          const queued = peer.queue.splice(0);
          for (const q of queued) handle(q);
        },
        leave() {
          peers.delete(peer);
          if (peer.clients.size) removeAwarenessStates(awareness, [...peer.clients], null);
        },
      };
    },
    destroy() {
      awareness.destroy();
      doc.destroy();
    },
  };
}

