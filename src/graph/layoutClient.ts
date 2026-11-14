/**
 * Runs the graph layout in a worker when the browser has one, else on the
 * main thread (tests, very old browsers), with the same progress callbacks.
 */
import { layoutGraph } from "./layout";

export interface LayoutRequest {
  id: number;
  n: number;
  edges: Uint32Array;
  iterations?: number;
}
export interface LayoutResponse {
  id: number;
  done: boolean;
  step: number;
  steps: number;
  positions: Float32Array;
}

let worker: Worker | null = null;
let nextId = 1;

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  try {
    worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
    return worker;
  } catch {
    return null;
  }
}

/**
 * Lay out a graph; `onFrame` gets intermediate positions while it settles.
 * A newer call supersedes an older one (its frames stop arriving).
 */
export function runLayout(n: number, edges: Uint32Array, onFrame?: (positions: Float32Array) => void, opts: { iterations?: number; inThread?: boolean } = {}): Promise<Float32Array> {
  const id = nextId++;
  const w = opts.inThread ? null : getWorker();
  if (!w) return Promise.resolve(layoutGraph(n, edges, { iterations: opts.iterations, onProgress: onFrame ? (p) => onFrame(Float32Array.from(p)) : undefined }));
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent<LayoutResponse>) => {
      if (e.data.id !== id) return;
      if (!e.data.done) return onFrame?.(e.data.positions);
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      resolve(e.data.positions);
    };
    const onError = (e: ErrorEvent) => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      worker?.terminate();
      worker = null;
      // The worker failed (e.g. blocked by the page's CSP): lay out here instead.
      try {
        resolve(layoutGraph(n, edges, { iterations: opts.iterations }));
      } catch {
        reject(e.error ?? new Error(e.message));
      }
    };
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    const copy = Uint32Array.from(edges);
    w.postMessage({ id, n, edges: copy, iterations: opts.iterations } satisfies LayoutRequest, [copy.buffer]);
  });
}
