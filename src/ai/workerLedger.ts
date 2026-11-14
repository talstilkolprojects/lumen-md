/**
 * Privacy ledger for Web Workers (plan 2.4).
 *
 * `installPrivacyLedger()` wraps the window's `fetch`, but a worker has its
 * own: model downloads by transformers.js (Whisper, embeddings) and
 * web-llm happen there, out of the panel's sight. A worker imports
 * `./workerLedgerInstall` FIRST — before any library captures `fetch` — and
 * every request it makes is reported on a BroadcastChannel; the window
 * classifies and records it with the same rules as its own requests
 * (`listenToWorkerLedger` in privacyLedger.ts). A BroadcastChannel keeps the
 * reports out of each worker's own message protocol.
 *
 * Limits, stated: the worker only reports — it does not block. Workers only
 * download models (a category the policy never blocks), and the CSP still
 * bounds where they can connect. Requests made by `Cache.add()` (web-llm's
 * cache) bypass `fetch` entirely; the worker reports those itself with
 * `reportWorkerDownload` before it loads a model that is not cached
 * (webllm.worker.ts).
 */

export const LEDGER_CHANNEL = "lumen-privacy-ledger";

export type WorkerLedgerMessage =
  | { kind: "start"; id: string; url: string; method: string; bytesOut: number; worker: string }
  | { kind: "end"; id: string; status: number; bytesIn: number | null };

type FetchScope = { fetch: typeof fetch; name?: string; location?: { pathname?: string } };

/** The channel and worker name `installWorkerLedger` set up, for `reportWorkerDownload`. */
let installed: { post: (m: WorkerLedgerMessage) => void; worker: string; next: () => string } | null = null;

function bodySize(body: BodyInit | null | undefined): number {
  if (body == null) return 0;
  if (typeof body === "string") return new TextEncoder().encode(body).length;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return 0;
}

/**
 * Wrap `scope.fetch` so each request is reported. Returns false when it
 * could not (no BroadcastChannel, no fetch, or already installed).
 */
export function installWorkerLedger(scope: FetchScope, channel?: Pick<BroadcastChannel, "postMessage">): boolean {
  const marker = scope as FetchScope & { __lumenLedger?: true };
  if (marker.__lumenLedger || typeof scope.fetch !== "function") return false;
  let ch = channel;
  if (!ch) {
    if (typeof BroadcastChannel === "undefined") return false;
    ch = new BroadcastChannel(LEDGER_CHANNEL);
  }
  marker.__lumenLedger = true;
  const inner = scope.fetch.bind(scope);
  const worker = scope.name || scope.location?.pathname?.split("/").pop() || "worker";
  let seq = 0;
  const post = (m: WorkerLedgerMessage) => {
    try {
      ch!.postMessage(m);
    } catch {
      // why: a closed channel must never break the worker's own request
    }
  };
  const next = () => `${worker}:${++seq}:${Date.now().toString(36)}`;
  installed = { post, worker, next };
  scope.fetch = async function ledgerWorkerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")).toUpperCase();
    const id = next();
    post({ kind: "start", id, url, method, bytesOut: bodySize(init?.body), worker });
    const res = await inner(input, init);
    const len = res.headers?.get?.("content-length");
    post({ kind: "end", id, status: res.status, bytesIn: len != null && Number.isFinite(Number(len)) ? Number(len) : null });
    return res;
  } as typeof fetch;
  return true;
}

/**
 * Report a download the worker's `fetch` does not see (web-llm's
 * `Cache.add()`). Size unknown, so recorded with no byte count. Returns the
 * function that settles it — call it with the outcome once the load is done
 * (200 when the model loaded, 0 when it failed), so a failed download is never
 * recorded as a success — or null when the ledger is not installed here.
 */
export function reportWorkerDownload(url: string): ((status: number) => void) | null {
  if (!installed) return null;
  const { post, next, worker } = installed;
  const id = next();
  post({ kind: "start", id, url, method: "GET", bytesOut: 0, worker });
  let settled = false;
  return (status: number) => {
    if (settled) return;
    settled = true;
    post({ kind: "end", id, status, bytesIn: null });
  };
}

/** Tests only. */
export function __resetWorkerLedger(): void {
  installed = null;
}
