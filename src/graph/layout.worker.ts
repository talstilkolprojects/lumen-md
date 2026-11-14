/// <reference lib="webworker" />
/**
 * Graph layout off the main thread (plan W1.10): the view sends the node
 * count and the edges; the worker sends back positions every few steps (so
 * the picture appears at once and settles), then the final ones.
 */
import { layoutGraph } from "./layout";
import type { LayoutRequest, LayoutResponse } from "./layoutClient";

self.onmessage = (e: MessageEvent<LayoutRequest>) => {
  const { id, n, edges, iterations } = e.data;
  const post = (msg: LayoutResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
  const positions = layoutGraph(n, edges, {
    iterations,
    every: 10,
    onProgress: (pos, step, steps) => {
      const copy = Float32Array.from(pos);
      post({ id, done: false, step, steps, positions: copy }, [copy.buffer]);
    },
  });
  post({ id, done: true, step: 1, steps: 1, positions }, [positions.buffer]);
};
