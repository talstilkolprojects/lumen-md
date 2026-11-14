/**
 * Graphviz layout in a Worker (F4 / P3). @hpcc-js/wasm's Emscripten embind
 * builds its bindings with `new Function`, which needs 'unsafe-eval'. Off
 * the main thread, that permission is granted to this worker's own script
 * only (its response carries its own CSP: route eval-workers in
 * security/policy.json), so the app's page CSP no longer allows eval at all.
 *
 *   → { id, dot, engine }   ← { id, svg } | { id, error }
 */
interface GraphvizInstance {
  layout(dot: string, format: string, engine: string): string;
}

let gv: Promise<GraphvizInstance> | null = null;

function load(): Promise<GraphvizInstance> {
  return (gv ??= (async () => {
    const mod = (await import("@hpcc-js/wasm/graphviz")) as { Graphviz: { load: () => Promise<GraphvizInstance> } };
    return mod.Graphviz.load();
  })().catch((e) => {
    gv = null;
    throw e;
  }));
}

self.onmessage = async (e: MessageEvent<{ id: number; dot: string; engine: string }>) => {
  const { id, dot, engine } = e.data;
  try {
    const svg = (await load()).layout(dot, "svg", engine);
    (self as unknown as Worker).postMessage({ id, svg });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: (err as Error)?.message ?? String(err) });
  }
};
