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
 * Limits, stated: outside airplane mode the worker only reports — it does not block. Workers only
 * download models (a category the policy never blocks), and the CSP still
 * bounds where they can connect. Requests made by `Cache.add()` (web-llm's
 * cache) bypass `fetch` entirely; the worker reports those itself with
 * `reportWorkerDownload` before it loads a model that is not cached
 * (webllm.worker.ts).
 */

export const LEDGER_CHANNEL = "lumen-privacy-ledger";

/**
 * Airplane mode (plan W5.9, src/privacy/airplane.ts): the worker asks the
 * window whether the switch is on ("hello" → "state") and reports every
 * attempt ("attempt"); while it is on, a request to another host fails here,
 * before it leaves. The window answers at once, from the startup bundle
 * (src/privacy/airplaneBoot.ts). A worker that hears nothing within
 * AIRPLANE_WAIT_MS blocks every request to another host (fail closed: the
 * window's CSP <meta> does not cover workers) until an answer says the switch
 * is off; later answers keep updating it.
 */
export const AIRPLANE_CHANNEL = "lumen-airplane";
export const AIRPLANE_WAIT_MS = 3000;
/**
 * Review 2 (12.11): the channel is shared by every tab of the app. A worker
 * whose name carries its window's id (`<label>#lumen-tab=<id>`,
 * airplaneWorkerName in src/privacy/airplaneBoot.ts) says it in its hello
 * and takes a state only for that id, so another tab (still off) cannot
 * switch it off. And "on" sticks: once a worker has heard on, only a reload
 * (a new worker) turns it off, as turning the switch off reloads the page.
 */
export const AIRPLANE_TAB_MARK = "#lumen-tab=";
export type AirplaneMessage =
  | { kind: "hello"; tab?: string }
  | { kind: "state"; on: boolean; tab?: string }
  | { kind: "attempt"; url: string; method: string; worker: string; blocked: boolean };

/** blob:, data: and loopback never leave the device. */
function stays(url: string, base: string | undefined): boolean {
  try {
    const u = new URL(url, base);
    if (u.protocol === "blob:" || u.protocol === "data:") return true;
    const h = u.hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

export type WorkerLedgerMessage =
  | { kind: "start"; id: string; url: string; method: string; bytesOut: number; worker: string }
  | { kind: "end"; id: string; status: number; bytesIn: number | null };

type FetchScope = { fetch: typeof fetch; name?: string; location?: { pathname?: string; href?: string } };

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
export function installWorkerLedger(
  scope: FetchScope,
  channel?: Pick<BroadcastChannel, "postMessage">,
  airChannel?: Pick<BroadcastChannel, "postMessage" | "addEventListener">,
): boolean {
  const marker = scope as FetchScope & { __lumenLedger?: true };
  if (marker.__lumenLedger || typeof scope.fetch !== "function") return false;
  let ch = channel;
  if (!ch) {
    if (typeof BroadcastChannel === "undefined") return false;
    ch = new BroadcastChannel(LEDGER_CHANNEL);
  }
  marker.__lumenLedger = true;
  const inner = scope.fetch.bind(scope);
  const rawName = scope.name ?? "";
  const mark = rawName.indexOf(AIRPLANE_TAB_MARK);
  const tab = mark >= 0 ? rawName.slice(mark + AIRPLANE_TAB_MARK.length) || null : null;
  const worker = (mark >= 0 ? rawName.slice(0, mark) : rawName) || scope.location?.pathname?.split("/").pop() || "worker";
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
  // Airplane mode: the window's answer, awaited once (see AIRPLANE_CHANNEL).
  let airplane: boolean | null = null;
  // An injected ledger channel (tests) without an airplane channel: no airplane check.
  const air: Pick<BroadcastChannel, "postMessage" | "addEventListener"> | null =
    airChannel ?? (!channel && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(AIRPLANE_CHANNEL) : null);
  let heard: Promise<void> = Promise.resolve();
  if (air) {
    heard = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, AIRPLANE_WAIT_MS);
      air.addEventListener("message", ((e: MessageEvent<AirplaneMessage>) => {
        if (e.data?.kind !== "state") return;
        // Bound to a window: only its answers count.
        if (tab !== null && e.data.tab !== tab) return;
        const next = e.data.on === false ? false : true;
        // On sticks until the page (and so this worker) is reloaded.
        if (airplane === true && !next) return;
        airplane = next;
        clearTimeout(timer);
        resolve();
      }) as EventListener);
    });
    air.postMessage((tab !== null ? { kind: "hello", tab } : { kind: "hello" }) satisfies AirplaneMessage);
  }
  scope.fetch = async function ledgerWorkerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")).toUpperCase();
    if (air) {
      if (airplane === null) await heard;
      // No answer (null) is treated as on: fail closed.
      const blocked = airplane !== false && !stays(url, scope.location?.href);
      try {
        air.postMessage({ kind: "attempt", url, method, worker, blocked } satisfies AirplaneMessage);
      } catch {
        /* why: a closed channel: the request is still decided here */
      }
      if (blocked) throw new TypeError(`Blocked: airplane mode is ${airplane === null ? "not confirmed off" : "on"} (${new URL(url, scope.location?.href).host})`);
    }
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
