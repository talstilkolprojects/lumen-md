/**
 * Sealed rooms (plan W2.20): a room whose server only ever holds ciphertext.
 *
 * In an end-to-end encrypted room every client syncs a transport document
 * with one root, the array `e2e`, of envelopes {v, iv, ct, s?} (AES-GCM under
 * a key the server never sees; src/collab/e2e.ts), and presence states of
 * the form {e2e: "<base64>"} (src/collab/e2eAwareness.ts). Once a room is
 * sealed the server holds every client to that shape:
 *
 *   • a sync update that writes anything else (a Y.Text, a map entry, a
 *     nested type, an array element that isn't an envelope) is refused and
 *     its connection dropped, before it reaches the room;
 *   • so is a presence state with any field but `e2e`;
 *   • a document that is not ciphertext-only is never stored.
 *
 * The server can't tell ciphertext from other bytes inside `ct`: what it
 * enforces is the shape, what keeps `ct` unreadable is the client. A room is
 * sealed when an end-to-end client asks for a token with `e2ee: true`, or
 * for every room with COLLAB_REQUIRE_E2EE=1. Sealing is never undone.
 *
 * `Y` (the yjs module) is passed in, so the shape checks run against the
 * same yjs the server uses, and the message parsing runs without it.
 */

export const E2E_ROOT = "e2e";
export const AWARENESS_FIELD = "e2e";
/** Longest sealed presence state accepted (base64 characters), as on the client. */
export const MAX_SEALED_AWARENESS = 16_384;

/* ─── lib0 decoding (the subset Hocuspocus messages use) ──────────────── */

function reader(bytes) {
  let i = 0;
  const varUint = () => {
    let n = 0;
    let shift = 0;
    for (;;) {
      if (i >= bytes.length) throw new Error("short");
      const b = bytes[i++];
      n += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return n;
      shift += 7;
      if (shift > 49) throw new Error("long");
    }
  };
  const varBytes = () => {
    const len = varUint();
    if (i + len > bytes.length) throw new Error("short");
    const out = bytes.subarray(i, i + len);
    i += len;
    return out;
  };
  const varString = () => new TextDecoder("utf-8", { fatal: true }).decode(varBytes());
  return { varUint, varBytes, varString, done: () => i >= bytes.length };
}

/** Hocuspocus message types that carry document sync (`SyncReply` is handled as `Sync`). */
export const SYNC_TYPES = new Set([0, 4]);
export const AWARENESS_TYPE = 1;

/**
 * Split one Hocuspocus message:
 *   {kind: "update", update}      sync step 2 or update (both carry changes)
 *   {kind: "awareness", states}   [{clientID, clock, json}]
 *   {kind: "other"}               anything else (sync step 1, auth, stateless…)
 *   {kind: "malformed"}
 */
export function parseMessage(bytes) {
  try {
    const r = reader(bytes);
    r.varString(); // document name
    const type = r.varUint();
    if (SYNC_TYPES.has(type)) {
      const step = r.varUint();
      if (step !== 1 && step !== 2) return { kind: "other" };
      return { kind: "update", update: r.varBytes() };
    }
    if (type === AWARENESS_TYPE) {
      const a = reader(r.varBytes());
      const n = a.varUint();
      const states = [];
      for (let k = 0; k < n; k++) states.push({ clientID: a.varUint(), clock: a.varUint(), json: a.varString() });
      return { kind: "awareness", states };
    }
    return { kind: "other" };
  } catch {
    return { kind: "malformed" };
  }
}

/* ─── Shapes ──────────────────────────────────────────────────────────── */

const ENVELOPE_KEYS = new Set(["v", "iv", "ct", "s"]);

/** An E2E envelope as src/collab/e2e.ts writes it, and nothing more. */
export function isEnvelope(x) {
  if (!x || typeof x !== "object" || Array.isArray(x) || x instanceof Uint8Array) return false;
  for (const k of Object.keys(x)) if (!ENVELOPE_KEYS.has(k)) return false;
  return (
    typeof x.v === "number" &&
    x.iv instanceof Uint8Array &&
    x.iv.length === 12 &&
    x.ct instanceof Uint8Array &&
    x.ct.length >= 16 && // at least the GCM tag
    (x.s === undefined || x.s === 1)
  );
}

/** Is this presence state (its JSON) sealed? `null` and `{}` (no presence yet) are too. */
export function isSealedAwarenessJson(json) {
  let v;
  try {
    v = JSON.parse(json);
  } catch {
    return false;
  }
  if (v === null) return true;
  if (typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length === 0) return true;
  return keys.length === 1 && keys[0] === AWARENESS_FIELD && typeof v[AWARENESS_FIELD] === "string" && v[AWARENESS_FIELD].length <= MAX_SEALED_AWARENESS;
}

/**
 * Why this Yjs update (v1) isn't ciphertext-only, or null when it is.
 * Every item it adds must sit in the `e2e` root array and hold envelopes;
 * deletions are fine. An item that names no parent continues one it points
 * to, so a foreign root always shows up on its first item.
 */
export function sealedUpdateProblem(update, Y) {
  let decoded;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    return "malformed";
  }
  for (const st of decoded.structs) {
    if (!(st instanceof Y.Item)) continue; // GC and Skip carry no content
    if (typeof st.parent === "string") {
      if (st.parent !== E2E_ROOT) return `root:${st.parent.slice(0, 32)}`;
    } else if (st.parent !== null) return "nested";
    if (st.parentSub !== null) return "map-entry";
    const c = st.content;
    if (c instanceof Y.ContentDeleted) continue;
    if (!(c instanceof Y.ContentAny)) return `content:${c?.constructor?.name ?? "unknown"}`;
    for (const e of c.arr) if (!isEnvelope(e)) return "not-an-envelope";
  }
  return null;
}

/** Why this incoming message breaks the sealed shape, or null. */
export function sealedMessageProblem(bytes, Y) {
  const m = parseMessage(bytes);
  if (m.kind === "malformed") return "malformed";
  if (m.kind === "update") return sealedUpdateProblem(m.update, Y);
  if (m.kind === "awareness") {
    for (const s of m.states) if (!isSealedAwarenessJson(s.json)) return "presence";
  }
  return null;
}

/** Does this document hold ciphertext only (nothing outside the `e2e` array of envelopes)? */
export function isSealedDocument(doc) {
  for (const [name, type] of doc.share) {
    if (name === E2E_ROOT) continue;
    if (type._start !== null || type._map.size > 0) return false;
  }
  if (!doc.share.has(E2E_ROOT)) return true;
  const arr = doc.getArray(E2E_ROOT);
  if (arr._map.size > 0) return false;
  return arr.toArray().every(isEnvelope);
}

/** The same check for a stored state. */
export function isSealedState(state, Y) {
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, state);
    return isSealedDocument(doc);
  } catch {
    return false;
  } finally {
    doc.destroy();
  }
}
