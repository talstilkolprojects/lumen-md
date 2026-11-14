/**
 * The index core answering protocol requests (./vaultIndexProtocol.ts):
 * the index worker's message handler, and the in-thread engine used where
 * there is no Worker (or after it died). A lazy chunk of the page.
 */

import { VaultIndex, type IndexInput } from "./vaultIndexCore";
import { engineOver, type IndexEngine, type IndexRequest, type IndexRequestBody, type IndexResponse, type RestoredNote } from "./vaultIndexProtocol";
import { dropSnapshot, loadSnapshot, readSnapshotBody, readSnapshotManifest, sameNote, saveSnapshot, snapshotRaw } from "./indexSnapshot";
import { summarize } from "./noteSummary";
import type { SnapshotKeys } from "./snapshotSeal";

/**
 * Index the listed notes the snapshot holds unchanged; their summaries for
 * the main thread (W2.22). W6.36: with `defer`, the summaries are answered
 * first and the indexing itself is handed to `defer` — the worker runs it
 * right after posting the answer, before any later request, so the vault
 * is open (tree, tags, graph) while the index fills, and every search still
 * sees all of it. `listing` null: every note the snapshot holds (the open
 * that trusts the snapshot and checks the vault behind it).
 */
async function restoreInto(
  index: VaultIndex,
  vault: string,
  listing: { path: string; name: string; modified: number; size?: number }[] | null,
  keys?: SnapshotKeys,
  defer?: (work: () => Promise<void>) => void,
): Promise<RestoredNote[]> {
  bodyRefused.set(index, false);
  // W6.36 round 2: a sealed snapshot opened without a listing answers from its manifest; the texts are opened and
  // indexed right after. If the body is then refused, `snapshotBody` says so and the caller reads those notes.
  if (!listing && keys) {
    const raw = await snapshotRaw();
    const { entries, refused } = await readSnapshotManifest(raw, vault, keys);
    if (refused) await dropSnapshot();
    if (!entries) return [];
    const out: RestoredNote[] = entries.filter((e) => e.modified);
    const work = async () => {
      const contents = await readSnapshotBody(raw, vault, keys, entries.length);
      if (!contents) {
        bodyRefused.set(index, true);
        await dropSnapshot();
        return;
      }
      entries.forEach((e, i) => {
        if (e.modified) index.upsert({ path: e.path, name: e.name, content: contents[i], modified: e.modified });
      });
    };
    if (defer) defer(work);
    else await work();
    return out;
  }
  const snap = await loadSnapshot(vault, keys);
  if (!snap) return [];
  const out: RestoredNote[] = [];
  const take: IndexInput[] = [];
  // W6.36: no listing — every note of the snapshot, as it recorded it.
  const entries = listing ?? [...snap.values()].map((s) => ({ path: s.path, name: s.name, modified: s.modified, size: s.size }));
  for (const e of entries) {
    const s = snap.get(e.path);
    // S3: the same mtime and, when both are known, the same size.
    if (!s || !sameNote(s, e)) continue;
    take.push({ path: e.path, name: e.name, content: s.content, modified: s.modified });
    const r: RestoredNote = { path: e.path, name: e.name, modified: s.modified, ...summarize(s.content) };
    if (s.size !== undefined) r.size = s.size;
    out.push(r);
  }
  const work = async () => {
    for (const f of take) index.upsert(f);
  };
  if (defer) defer(work);
  else await work();
  return out;
}

/** Whether the body of the snapshot last restored into an index was refused after its manifest was taken (W6.36). */
const bodyRefused = new WeakMap<VaultIndex, boolean>();

export { VaultIndex };

/**
 * Apply one request to `index`. Never throws: a failure is an `ok: false`
 * answer. `defer` (the worker passes one): work to run after the answer is
 * posted and before the next request (W6.36).
 */
export function handleIndexRequest(index: VaultIndex, req: IndexRequest, defer?: (work: () => Promise<void>) => void): IndexResponse | Promise<IndexResponse> {
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
      case "backlinks":
        return { id: req.id, ok: true, result: index.backlinks(req.target) };
      case "stats":
        return { id: req.id, ok: true, result: index.stats() };
      case "tasks":
        return { id: req.id, ok: true, result: index.queryTasks(req.query, req.today) };
      case "move": {
        let n = 0;
        for (const m of req.moves) if (index.move(m.from, m.to, m.name)) n++;
        return { id: req.id, ok: true, result: n };
      }
      case "texts":
        return { id: req.id, ok: true, result: index.texts(req.paths) };
      case "related":
        return { id: req.id, ok: true, result: index.related(req.query.paragraph, req.query) };
      case "snapshotSave":
        return saveSnapshot(req.vault, index.notes(), req.keys).then(
          () => ({ id: req.id, ok: true as const, result: index.size }),
          (err: unknown) => ({ id: req.id, ok: false as const, error: String(err) }),
        );
      case "snapshotBody":
        return { id: req.id, ok: true, result: { refused: bodyRefused.get(index) ?? false } };
      case "snapshotRestore":
        return restoreInto(index, req.vault, req.listing, req.keys, defer).then(
          (result) => ({ id: req.id, ok: true as const, result }),
          (err: unknown) => ({ id: req.id, ok: false as const, error: String(err) }),
        );
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
    const res = await handleIndexRequest(index, { ...body, id: ++id } as IndexRequest);
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
