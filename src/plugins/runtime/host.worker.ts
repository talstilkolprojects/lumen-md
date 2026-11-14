/// <reference lib="webworker" />
/**
 * The plugin worker (plan 11.2.2): one per loaded plugin. It runs the
 * plugin's logic in the QuickJS sandbox (sandbox.ts) and relays the
 * sandbox's granted calls to the main thread as messages — the worker
 * itself never calls `fetch` or touches storage on a plugin's behalf; the
 * host (pluginHost.ts) does, after its own capability check and through
 * the privacy ledger.
 */
import type { HostToWorker, WorkerToHost } from "./protocol";
import { createSandbox, type Sandbox } from "./sandbox";
import { grantsFrom } from "./capabilities";

const post = (m: WorkerToHost) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

let sandbox: Sandbox | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let queue: Promise<void> = Promise.resolve();

async function load(m: Extract<HostToWorker, { type: "load" }>): Promise<void> {
  const t0 = performance.now();
  sandbox = await createSandbox({
    manifest: m.manifest,
    code: m.code,
    grants: grantsFrom(m.grants),
    limits: m.limits,
    wasmUrl: m.wasmUrl,
    host: {
      call: (method, args) =>
        new Promise((resolve, reject) => {
          const id = ++seq;
          pending.set(id, { resolve, reject });
          post({ type: "call", id, method, args });
        }),
      log: (level, text) => post({ type: "log", level, text }),
      fatal: (error) => {
        post({ type: "fatal", error });
        sandbox = null;
      },
    },
  });
  post({ type: "ready", loadMs: Math.round(performance.now() - t0) });
}

self.onmessage = (ev: MessageEvent<HostToWorker>) => {
  const m = ev.data;
  if (m.type === "result") {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else {
      const e = new Error(m.error);
      if (m.denied) e.name = "PluginDenied";
      p.reject(e);
    }
    return;
  }
  // Load, events and unload run in order; events are delivered one at a time.
  queue = queue
    .then(async () => {
      if (m.type === "load") await load(m);
      else if (m.type === "event") await sandbox?.dispatch(m.name, m.payload);
      else if (m.type === "unload") {
        sandbox?.dispose();
        sandbox = null;
        for (const p of pending.values()) p.reject(new Error("plugin unloaded"));
        pending.clear();
        post({ type: "unloaded" });
      }
    })
    .catch((e: unknown) => {
      post({ type: "fatal", error: e instanceof Error ? e.message : String(e) });
      sandbox = null;
    });
};
