/**
 * The index core answering protocol requests (./vaultIndexProtocol.ts):
 * the index worker's message handler, and the in-thread engine used where
 * there is no Worker (or after it died). A lazy chunk of the page.
 */

import { VaultIndex, type IndexInput } from "./vaultIndexCore";
import { engineOver, type IndexEngine, type IndexRequest, type IndexRequestBody, type IndexResponse } from "./vaultIndexProtocol";

export { VaultIndex };

/** Apply one request to `index`. Never throws: a failure is an `ok: false` answer. */
export function handleIndexRequest(index: VaultIndex, req: IndexRequest): IndexResponse {
  try {
    switch (req.op) {
      case "upsert":
        for (const f of req.files) index.upsert(f);
        return { id: req.id, ok: true, result: req.files.length };
      case "remove": {
        let n = 0;
        for (const p of req.paths) if (index.remove(p)) n++;
        return { id: req.id, ok: true, result: n };
      }
      case "clear":
        index.clear();
        return { id: req.id, ok: true, result: 0 };
      case "search":
        return { id: req.id, ok: true, result: index.search(req.query, req.opts) };
      case "query":
        return { id: req.id, ok: true, result: index.query(req.query, req.opts) };
      case "backlinks":
        return { id: req.id, ok: true, result: index.backlinks(req.target) };
      case "stats":
        return { id: req.id, ok: true, result: index.stats() };
    }
  } catch (err) {
    return { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** How long the in-thread engine indexes before it yields to the event loop (ms). */
export const LOCAL_SLICE_MS = 30;

/**
 * The index in this thread (no Worker, or after it died). Indexing a large
 * vault here would be one long task, so an upsert is done in slices: every
 * LOCAL_SLICE_MS it yields to the event loop (typing and paint go on), as
 * #232's first BM25 sync did. Requests still run one after another, in
 * order: a search sent after an upsert waits for all of it.
 */
export function localEngine(index: VaultIndex, opts: { sliceMs?: number; now?: () => number } = {}): IndexEngine {
  const sliceMs = opts.sliceMs ?? LOCAL_SLICE_MS;
  const now = opts.now ?? (() => performance.now());
  let id = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const upsertSliced = async (files: IndexInput[]) => {
    let start = now();
    for (const f of files) {
      index.upsert(f);
      if (now() - start > sliceMs) {
        await new Promise((r) => setTimeout(r, 0));
        start = now();
      }
    }
    return files.length;
  };
  const run = async (body: IndexRequestBody) => {
    if (body.op === "upsert") return upsertSliced(body.files);
    const res = handleIndexRequest(index, { ...body, id: ++id } as IndexRequest);
    if (!res.ok) throw new Error(res.error);
    return res.result;
  };
  return engineOver(
    "local",
    (body) => {
      const next = queue.then(() => run(body));
      queue = next.catch(() => undefined);
      return next;
    },
    () => index.clear(),
  );
}
