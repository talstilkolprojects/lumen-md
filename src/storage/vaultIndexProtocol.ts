/**
 * The messages between the workspace index (main thread,
 * ./workspaceIndex.ts) and the index core it drives (./vaultIndexCore.ts),
 * and the engine that drives it in the index worker
 * (./vaultIndex.worker.ts). The in-thread engine, for when there is no
 * Worker, is ./vaultIndexLocal.ts — loaded only then, off the startup path.
 * Both answer through `handleIndexRequest`, so they answer the same.
 */

import type { BacklinkHit, IndexInput, IndexStats, SearchHit, SearchOptions } from "./vaultIndexCore";
import type { QueryResult } from "../tasks/taskQuery";

export type IndexRequestBody =
  | { op: "upsert"; files: IndexInput[] }
  | { op: "remove"; paths: string[] }
  | { op: "clear" }
  | { op: "search"; query: string; opts: SearchOptions }
  | { op: "backlinks"; target: string }
  | { op: "stats" }
  | { op: "tasks"; query: string; today: string };

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
