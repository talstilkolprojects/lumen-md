/**
 * The room's size, kept up to date per update instead of measured again on
 * every one (train 5's owed item: in a 4 MB room `Y.encodeStateAsUpdate`
 * per message cost ~50 ms of CPU against the 10 ms a Workers message gets).
 *
 * The number is the same one the reviewed accounting used (R6 r14/r18):
 * the exact byte length of `Y.encodeStateAsUpdate(doc)`, not an estimate.
 * That encoding is a sum of independent parts —
 *
 *   varuint(#clients) + Σ client section + varuint(#clients with deletions) + Σ delete-set section
 *
 * where a client's section is its struct count, id and first clock followed
 * by each of its structs, and its delete-set section is its id, its range
 * count and each range of consecutive deleted structs. So the meter keeps
 * each client's two section sizes and, after a transaction, measures again
 * only the clients the transaction could have changed: the ones that got new
 * structs, had items deleted (gc'd, merged) or split (`_mergeStructs`).
 * Within a client a struct whose length and content are unchanged is not
 * encoded again (a struct's encoding follows from its id, length and
 * content), and an `any` value (an envelope) is encoded once for its length.
 *
 * Where that reasoning does not cover a transaction, the meter counts the
 * whole room (still without copying the content), or encodes it outright:
 *   - a deleted nested type: its gc turns children of any client into GC structs;
 *   - pending structs or deletions: the encoding then merges them in.
 * src/__tests__/collabRoomSize.test.ts checks the meter against
 * `Y.encodeStateAsUpdate(doc).byteLength` after every one of thousands of
 * generated updates.
 */
import * as Y from "yjs";
import * as encoding from "lib0/encoding";

/** Bytes of lib0's varuint for `n` (`encoding.writeVarUint`). */
function varUintLength(n) {
  let len = 1;
  while (n > 0b1111111) {
    n = Math.floor(n / 128);
    len++;
  }
  return len;
}

/** lib0's `writeAny` length of a value; an object (an envelope) is encoded once. */
const anyLengths = new WeakMap();
function anyLength(value) {
  const cacheable = value !== null && typeof value === "object";
  if (cacheable) {
    const known = anyLengths.get(value);
    if (known !== undefined) return known;
  }
  const e = encoding.createEncoder();
  encoding.writeAny(e, value);
  const len = encoding.length(e);
  if (cacheable) anyLengths.set(value, len);
  return len;
}

/** Yjs's own V1 encoder, writing everything but `any` values: those are counted. */
class CountingEncoder extends Y.UpdateEncoderV1 {
  constructor() {
    super();
    this.counted = 0;
  }
  writeAny(value) {
    this.counted += anyLength(value);
  }
  get length() {
    return encoding.length(this.restEncoder) + this.counted;
  }
}

/** Encoded size of each struct, valid while its length and content are the ones it was measured with. */
const structSizes = new WeakMap();
function structSize(struct) {
  const known = structSizes.get(struct);
  if (known && known.length === struct.length && known.content === struct.content && known.ctor === struct.constructor) return known.size;
  const e = new CountingEncoder();
  struct.write(e, 0);
  const size = e.length;
  structSizes.set(struct, { length: struct.length, content: struct.content, ctor: struct.constructor, size });
  return size;
}

/** One client's struct section and delete-set section (0 when it has no deletions). */
function measureClient(client, structs) {
  let body = 0;
  let ranges = 0;
  let rangesBytes = 0;
  for (let i = 0; i < structs.length; i++) {
    const struct = structs[i];
    body += structSize(struct);
    if (struct.deleted) {
      // A run of deleted structs is one range (createDeleteSetFromStructStore).
      const clock = struct.id.clock;
      let len = struct.length;
      while (i + 1 < structs.length && structs[i + 1].deleted) {
        i++;
        len += structs[i].length;
        body += structSize(structs[i]);
      }
      ranges++;
      rangesBytes += varUintLength(clock) + varUintLength(len);
    }
  }
  const head = varUintLength(structs.length) + varUintLength(client) + varUintLength(structs[0].id.clock);
  return { structs: head + body, ds: ranges ? varUintLength(client) + varUintLength(ranges) + rangesBytes : 0 };
}

/**
 * `createRoomMeter(doc).measure()` → `Y.encodeStateAsUpdate(doc).byteLength`,
 * at the cost of the clients the transactions since the last call touched.
 * Create it before the doc's own "update" listeners need it: it learns from
 * every transaction's cleanup, including ones that emit no update.
 */
export function createRoomMeter(doc) {
  const sections = new Map(); // client → { structs, ds }
  let all = true; // measure every client at the next call
  const dirty = new Set();
  doc.on("beforeObserverCalls", (tr) => {
    // Before the cleanup gc's them: a deleted nested type takes its children (any client) with it.
    if (all) return;
    for (const [client, ranges] of tr.deleteSet.clients) {
      const structs = doc.store.clients.get(client) ?? [];
      for (const { clock, len } of ranges) {
        // Read only (iterateDeletedStructs would split at the range ends).
        for (let i = Y.findIndexSS(structs, clock); i < structs.length && structs[i].id.clock < clock + len; i++) {
          if (structs[i] instanceof Y.Item && structs[i].content instanceof Y.ContentType) {
            all = true;
            return;
          }
        }
      }
    }
  });
  doc.on("afterTransactionCleanup", (tr) => {
    if (all) return;
    for (const [client, clock] of tr.afterState) if ((tr.beforeState.get(client) ?? 0) !== clock) dirty.add(client);
    for (const client of tr.deleteSet.clients.keys()) dirty.add(client);
    for (const struct of tr._mergeStructs) dirty.add(struct.id.client);
  });
  const measure = () => {
    const store = doc.store;
    if (store.pendingStructs !== null || store.pendingDs !== null) return Y.encodeStateAsUpdate(doc).byteLength;
    const clients = all ? [...store.clients.keys()] : [...dirty];
    if (all) sections.clear();
    all = false;
    dirty.clear();
    for (const client of clients) {
      const structs = store.clients.get(client);
      if (structs?.length) sections.set(client, measureClient(client, structs));
      else sections.delete(client);
    }
    let total = varUintLength(sections.size);
    let dsClients = 0;
    for (const s of sections.values()) {
      total += s.structs + s.ds;
      if (s.ds) dsClients++;
    }
    return total + varUintLength(dsClients);
  };
  return { measure };
}
