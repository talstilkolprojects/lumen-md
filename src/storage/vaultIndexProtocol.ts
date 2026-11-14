/**
 * The messages between the workspace index (main thread,
 * ./workspaceIndex.ts) and the index core it drives (./vaultIndexCore.ts),
 * and the engine that drives it in the index worker
 * (./vaultIndex.worker.ts). The in-thread engine, for when there is no
 * Worker, is ./vaultIndexLocal.ts — loaded only then, off the startup path.
 * Both answer through `handleIndexRequest`, so they answer the same.
 */

import type { BacklinkHit, IndexInput, IndexStats, NoteText, SearchHit, SearchOptions } from "./vaultIndexCore";
import type { QueryResult } from "../tasks/taskQuery";
import type { RelatedHit } from "../related/related";
import type { NoteSummary } from "./noteSummary";
import type { SnapshotKeys } from "./snapshotSeal";
import type { HighlightItem } from "../highlights/hub";

/** A note restored from the snapshot, as the main thread keeps it. */
export interface RestoredNote extends NoteSummary {
  path: string;
  name: string;
  modified: number;
  /** UTF-8 bytes of the note's text, as the snapshot recorded it (review 14.11 S3). */
  size?: number;
}

/** What the related-notes panel asks the index (plan W2.2). */
export interface RelatedQuery {
  paragraph: string;
  self?: string | null;
  offFolders?: string[];
  semantic?: { path: string; score: number }[];
  limit?: number;
}

export type IndexRequestBody =
  | { op: "upsert"; files: IndexInput[] }
  | { op: "remove"; paths: string[] }
  | { op: "clear" }
  | { op: "search"; query: string; opts: SearchOptions }
  | { op: "backlinks"; target: string }
  | { op: "stats" }
  | { op: "tasks"; query: string; today: string }
  // W2.22: the text stays in the index; these work on what it holds.
  | { op: "move"; moves: { from: string; to: string; name: string }[] }
  | { op: "texts"; paths?: string[] }
  | { op: "related"; query: RelatedQuery }
  // W10.C25: the highlights hub's index, built from the notes the index holds.
  | { op: "highlights" }
  // W6.36: `keys` (an encrypted vault) seals / opens the snapshot in the worker.
  | { op: "snapshotSave"; vault: string; keys?: SnapshotKeys }
  | { op: "snapshotBody" }
  | { op: "snapshotRestore"; vault: string; listing: { path: string; name: string; modified: number; size?: number }[] | null; keys?: SnapshotKeys };

export type IndexRequest = IndexRequestBody & { id: number };

export type IndexResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export interface IndexEngine {
  /** "worker": the index lives in the index worker; "local": in this thread. */
  readonly kind: "worker" | "local";
  upsert(files: IndexInput[]): Promise<void>;
  remove(paths: string[]): Promise<void>;
  clear(): Promise<void>;
  search(query: string, opts: SearchOptions): Promise<SearchHit[]>;
  backlinks(target: string): Promise<BacklinkHit[]>;
  stats(): Promise<IndexStats>;
  /** Run a ```tasks``` query (plan 4.13); `today` is YYYY-MM-DD in the user's time zone. */
  tasks(query: string, today: string): Promise<QueryResult>;
  /** Move notes inside the index (no text sent). */
  move(moves: { from: string; to: string; name: string }[]): Promise<void>;
  /** The text of these notes (all when omitted), read from the index (W2.22). */
  texts(paths?: string[]): Promise<NoteText[]>;
  /** Every highlight in the indexed notes (plan W1.15), built here, not on the main thread (W10.C25). */
  highlights(): Promise<HighlightItem[]>;
  /** Notes related to a paragraph, ranked in the index (plan W2.2). */
  related(query: RelatedQuery): Promise<RelatedHit[]>;
  /** Save the indexed notes for the next session (indexSnapshot.ts); sealed with `keys` in an encrypted vault (W6.36). */
  saveSnapshot(vault: string, keys?: SnapshotKeys): Promise<void>;
  /**
   * Index every listed note the snapshot holds with the same mtime; returns
   * their summaries (the caller reads only the others). W6.36: `listing`
   * null takes every note the snapshot holds, with the mtime it recorded
   * (the snapshot is its own manifest); the caller then checks them
   * against the vault.
   */
  restoreSnapshot(vault: string, listing: { path: string; name: string; modified: number; size?: number }[] | null, keys?: SnapshotKeys): Promise<RestoredNote[]>;
  /**
   * W6.36: after a restore without a listing, whether the snapshot's body
   * (the texts) was refused after its manifest was taken; answered once the
   * restored texts are indexed.
   */
  snapshotBody(): Promise<{ refused: boolean }>;
  dispose(): void;
}

export function engineOver(kind: IndexEngine["kind"], send: (req: IndexRequestBody) => Promise<unknown>, dispose: () => void): IndexEngine {
  return {
    kind,
    upsert: async (files) => void (await send({ op: "upsert", files })),
    remove: async (paths) => void (await send({ op: "remove", paths })),
    clear: async () => void (await send({ op: "clear" })),
    search: (query, opts) => send({ op: "search", query, opts }) as Promise<SearchHit[]>,
    backlinks: (target) => send({ op: "backlinks", target }) as Promise<BacklinkHit[]>,
    stats: () => send({ op: "stats" }) as Promise<IndexStats>,
    tasks: (query, today) => send({ op: "tasks", query, today }) as Promise<QueryResult>,
    move: async (moves) => void (await send({ op: "move", moves })),
    texts: (paths) => send({ op: "texts", paths }) as Promise<NoteText[]>,
    related: (query) => send({ op: "related", query }) as Promise<RelatedHit[]>,
    highlights: () => send({ op: "highlights" }) as Promise<HighlightItem[]>,
    saveSnapshot: async (vault, keys) => void (await send(keys ? { op: "snapshotSave", vault, keys } : { op: "snapshotSave", vault })),
    restoreSnapshot: (vault, listing, keys) => send(keys ? { op: "snapshotRestore", vault, listing, keys } : { op: "snapshotRestore", vault, listing }) as Promise<RestoredNote[]>,
    snapshotBody: () => send({ op: "snapshotBody" }) as Promise<{ refused: boolean }>,
    dispose,
  };
}

/** What `workerEngine` needs of a Worker (a fake one in tests). */
export interface WorkerLike {
  postMessage(message: IndexRequest): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<IndexResponse>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

/**
 * The index in a worker. Requests are answered in order (the worker
 * handles one message at a time), so an upsert sent before a search is
 * always in the search's results. When the worker dies every pending and
 * later request rejects, and the caller falls back to a local engine.
 */
export function workerEngine(worker: WorkerLike): IndexEngine {
  let nextId = 0;
  let dead: Error | null = null;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const fail = (err: Error) => {
    dead = err;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  worker.onmessage = (e) => {
    const res = e.data;
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    if (res.ok) p.resolve(res.result);
    else p.reject(new Error(res.error));
  };
  worker.onerror = (e) => {
    e.preventDefault?.();
    fail(new Error(e.message || "vault index worker failed"));
  };
  return engineOver(
    "worker",
    (body) => {
      if (dead) return Promise.reject(dead);
      const id = ++nextId;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          worker.postMessage({ ...body, id } as IndexRequest);
        } catch (err) {
          pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    () => {
      fail(new Error("vault index worker stopped"));
      worker.terminate();
    },
  );
}
