/**
 * The window's side of the render worker (plan 8.1).
 *
 * `renderInWorker` posts a request and resolves to the worker's HAST, or to
 * null when there is no worker to ask — no `Worker` (Node, old browsers),
 * the worker failed to start or crashed, or it reported an error — in which
 * case the caller renders on the main thread (./pipeline.ts). A request
 * superseded by a newer one on its channel resolves to `STALE`.
 *
 * The worker is started on the first request, and lives for the page.
 */
import type { Root as HastRoot } from "hast";
import { airplaneWorkerName } from "../privacy/airplaneBoot";
import type { HostData, RenderBlockRequest, RenderDocRequest, RenderHoverRequest, RenderReply, RenderRequest } from "./renderProtocol";

/** A request a newer one on the same channel replaced. */
export const STALE = Symbol("stale");

/** What the window needs from a worker: the slice of `Worker` this module uses. */
export interface RenderPort {
  postMessage(msg: RenderRequest): void;
  onmessage: ((e: MessageEvent<RenderReply>) => void) | null;
  onerror: ((e: unknown) => void) | null;
  terminate(): void;
}

type Pending = { resolve: (r: RenderReply | null) => void };

let port: RenderPort | null = null;
let broken = false;
let answered = false;
let seq = 0;
const pending = new Map<number, Pending>();
const versions = new Map<string, number>();

function defaultPort(): RenderPort | null {
  if (typeof Worker === "undefined") return null;
  return new Worker(new URL("./render.worker.ts", import.meta.url), { type: "module", name: airplaneWorkerName("render") }) as unknown as RenderPort;
}

let makePort: () => RenderPort | null = defaultPort;

/**
 * Use `make` to start the worker (tests: the real handler behind a
 * structured-clone boundary, see src/__tests__/renderWorker.test.ts), or
 * the default again with no argument. Drops a running worker.
 */
export function setRenderPortFactory(make?: () => RenderPort | null): void {
  port?.terminate();
  port = null;
  broken = false;
  answered = false;
  settleAll();
  makePort = make ?? defaultPort;
}

function settleAll(): void {
  for (const p of pending.values()) p.resolve(null);
  pending.clear();
}

function getPort(): RenderPort | null {
  if (broken) return null;
  if (port) return port;
  try {
    port = makePort();
  } catch {
    // why: a worker that cannot start (blocked by CSP, no module workers): render here
    port = null;
  }
  if (!port) {
    broken = true;
    return null;
  }
  port.onmessage = (e) => {
    const r = e.data;
    answered = true;
    const p = pending.get(r.id);
    if (!p) return;
    pending.delete(r.id);
    p.resolve(r);
  };
  port.onerror = () => {
    // A crashed worker answers nothing more: everything in flight renders here, and so does the rest.
    broken = true;
    port?.terminate();
    port = null;
    settleAll();
  };
  return port;
}

/** Is there a worker to render in (or one may still start)? */
export function renderWorkerAvailable(): boolean {
  return !broken && (port !== null || typeof Worker !== "undefined" || makePort !== defaultPort);
}

/** Has the worker answered a request yet (its pipeline chunks are loaded)? */
export function renderWorkerWarm(): boolean {
  return answered && !broken;
}

/** The next version for `channel`: every request after it makes the earlier ones stale. */
export function nextVersion(channel: string): number {
  const v = (versions.get(channel) ?? 0) + 1;
  versions.set(channel, v);
  getPort()?.postMessage({ type: "cancel", channel, version: v });
  return v;
}

type Ask<R> = Omit<R, "id" | "host"> & { host: HostData };

function ask(req: Ask<RenderDocRequest> | Ask<RenderBlockRequest> | Ask<RenderHoverRequest>): Promise<RenderReply | null> {
  const p = getPort();
  if (!p) return Promise.resolve(null);
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    try {
      p.postMessage({ ...req, id } as RenderRequest);
    } catch {
      // why: the request could not be cloned (it never should): render here
      pending.delete(id);
      resolve(null);
    }
  });
}

/** The worker's reply as a result: the tree, `STALE`, or null (render on the main thread). */
function result<T>(r: RenderReply | null, pick: (ok: Extract<RenderReply, { ok: true }>) => T): T | typeof STALE | null {
  if (!r) return null;
  if ("stale" in r) return STALE;
  if (!r.ok) return null;
  return pick(r);
}

export async function renderDocInWorker(req: Ask<RenderDocRequest>): Promise<{ hast: HastRoot; used: string[] } | typeof STALE | null> {
  return result(await ask(req), (r) => ({ hast: r.hast, used: r.used ?? [] }));
}

export async function renderBlockInWorker(req: Ask<RenderBlockRequest>): Promise<{ hast: HastRoot; slugTexts: string[]; ms: number } | typeof STALE | null> {
  return result(await ask(req), (r) => ({ hast: r.hast, slugTexts: r.slugTexts ?? [], ms: r.ms }));
}

export async function renderHoverInWorker(req: Ask<RenderHoverRequest>): Promise<HastRoot | typeof STALE | null> {
  return result(await ask(req), (r) => r.hast);
}
