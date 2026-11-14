/**
 * Plugin host, main-thread side (plan 11.2): loads a plugin into its own
 * worker (host.worker.ts → QuickJS sandbox), answers the calls the sandbox
 * lets through, and enforces the user's grants a second time here — the
 * worker is a boundary, not the policy. Network goes through this file
 * only: an exact-origin grant, the privacy ledger, `local-only` blocks it,
 * no credentials, no cross-origin redirects, a response size cap.
 *
 * Everything the plugin may do in the app is behind `HostServices`, which
 * the app wires (plan 11.2 part b). A method with no service is refused.
 */
import { completeLedgerEntry, recordPluginRequest } from "../../ai/privacyLedger";
import { log } from "../../lib/logger";
import { intersectWithManifest, isGranted, METHOD_CAPABILITY, networkGranted, PluginDenied, type Grants } from "./capabilities";
import type { PluginManifest } from "./manifest";
import { DEFAULT_LIMITS, METHOD_RE, type HostToWorker, type SandboxLimits, type WorkerToHost } from "./protocol";
import { validateUiTree } from "./uiTree";

export interface PluginFetchInit {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
}
export interface PluginFetchResult {
  status: number;
  headers: Record<string, string>;
  /** UTF-8 text of the body (binary bodies are not supported). */
  body: string;
}

/** What the app offers plugins; every entry is optional — a missing one is refused. Keyed `<ns>.<fn>`. */
export type HostServices = Partial<Record<keyof typeof METHOD_CAPABILITY, (plugin: PluginInstance, ...args: unknown[]) => unknown | Promise<unknown>>>;

export interface PluginInstance {
  readonly id: string;
  readonly manifest: PluginManifest;
  readonly grants: Grants;
  /** Refused calls, by capability (the host's count; the sandbox refuses first and counts its own). */
  readonly denied: ReadonlyMap<string, number>;
  /** Send an event to the plugin (a command it registered ran, …). */
  emit(name: string, payload?: unknown): void;
  unload(): Promise<void>;
  onLog(fn: (level: "log" | "warn" | "error", text: string) => void): () => void;
  /** The plugin died (uncaught error, limit). The instance is unusable afterwards. */
  onFatal(fn: (error: string) => void): () => void;
  readonly alive: boolean;
  /** For the developer panel (W3.10): the last calls the plugin made, how often each capability was used, CPU and memory. */
  readonly calls: readonly CallRecord[];
  readonly capabilityUse: ReadonlyMap<string, number>;
  readonly stats: SandboxStatsMessage | null;
  /** How long the plugin took to start, ms. */
  readonly loadMs: number | null;
  onActivity(fn: () => void): () => void;
}

/** One call a plugin made to the app, as the host saw it. */
export interface CallRecord {
  at: number;
  method: string;
  capability: string;
  ms: number;
  outcome: "ok" | "denied" | "error";
}

export type SandboxStatsMessage = Omit<Extract<WorkerToHost, { type: "stats" }>, "type">;

/** Calls kept per plugin for the developer panel. */
export const CALL_LOG_SIZE = 200;

export interface LoadOptions {
  manifest: PluginManifest;
  /** The plugin's `main` as text. */
  code: string;
  grants: Grants;
  services: HostServices;
  limits?: Partial<SandboxLimits>;
  /** For tests: a Worker factory. */
  createWorker?: () => Worker;
}

export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 20_000;

const base = (): string => (import.meta.env?.BASE_URL as string | undefined) ?? "/";
/** The QuickJS wasm, staged same-origin by scripts/copy-quickjs.mjs. */
export const quickJsWasmUrl = (): string => new URL(`${base()}quickjs/emscripten-module.wasm`, typeof location !== "undefined" ? location.origin : "http://localhost").href;

/**
 * The plugin's `network.fetch`: the request a plugin asked for, after the
 * grant check, through the ledger. Never with cookies, never following a
 * redirect (it could leave the granted origin), text bodies only.
 */
export async function pluginFetch(plugin: Pick<PluginInstance, "id" | "grants">, url: unknown, init: unknown): Promise<PluginFetchResult> {
  if (typeof url !== "string" || !networkGranted(plugin.grants, url)) {
    let origin = "?";
    try {
      origin = new URL(String(url)).origin;
    } catch {
      /* why: not a URL: the denial names the origin "?" */
    }
    throw new PluginDenied(plugin.id, `network:${origin}`);
  }
  const i = (init && typeof init === "object" ? init : {}) as PluginFetchInit;
  const method = i.method ?? "GET";
  const body = typeof i.body === "string" ? i.body : undefined;
  const entry = recordPluginRequest(plugin.id, url, method, body ? new TextEncoder().encode(body).length : 0);
  if (entry.decision === "blocked") throw new PluginDenied(plugin.id, "network", "the local-only AI policy allows no network requests");
  const headers: Record<string, string> = {};
  // Request headers a plugin may set: plain strings, none that identify the user or the app.
  for (const [k, v] of Object.entries(i.headers ?? {})) if (typeof v === "string" && !/^(cookie|host|origin|referer|user-agent)$/i.test(k)) headers[k] = v;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: ctl.signal });
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_RESPONSE_BYTES) throw new Error(`response larger than ${MAX_RESPONSE_BYTES} bytes`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_RESPONSE_BYTES) throw new Error(`response larger than ${MAX_RESPONSE_BYTES} bytes`);
    completeLedgerEntry(entry.id, res.status, buf.length);
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => (out[k] = v));
    return { status: res.status, headers: out, body: new TextDecoder().decode(buf) };
  } finally {
    clearTimeout(timer);
  }
}

export function loadPlugin(opts: LoadOptions): Promise<PluginInstance> {
  const grants = intersectWithManifest(opts.grants, opts.manifest);
  const worker = opts.createWorker ? opts.createWorker() : new Worker(new URL("./host.worker.ts", import.meta.url), { type: "module" });
  const send = (m: HostToWorker) => worker.postMessage(m);
  const logFns = new Set<(level: "log" | "warn" | "error", text: string) => void>();
  const fatalFns = new Set<(error: string) => void>();
  const denied = new Map<string, number>();
  const calls: CallRecord[] = [];
  const capabilityUse = new Map<string, number>();
  const activityFns = new Set<() => void>();
  let stats: SandboxStatsMessage | null = null;
  let loadMs: number | null = null;
  const activity = () => {
    for (const f of activityFns) f();
  };
  const record = (r: CallRecord) => {
    calls.push(r);
    if (calls.length > CALL_LOG_SIZE) calls.splice(0, calls.length - CALL_LOG_SIZE);
    if (r.outcome === "ok") capabilityUse.set(r.capability, (capabilityUse.get(r.capability) ?? 0) + 1);
    activity();
  };
  let alive = true;
  let unloaded: (() => void) | null = null;
  const die = (error: string) => {
    if (!alive) return;
    alive = false;
    log.error(`[plugin:${opts.manifest.id}] ${error}`);
    for (const f of fatalFns) f(error);
    worker.terminate();
  };

  const instance: PluginInstance = {
    id: opts.manifest.id,
    manifest: opts.manifest,
    grants,
    denied,
    get alive() {
      return alive;
    },
    emit(name, payload) {
      if (alive) send({ type: "event", name, payload });
    },
    async unload() {
      if (!alive) return;
      await new Promise<void>((resolve) => {
        unloaded = resolve;
        send({ type: "unload" });
        setTimeout(resolve, 3000);
      });
      alive = false;
      worker.terminate();
    },
    onLog: (fn) => (logFns.add(fn), () => void logFns.delete(fn)),
    onFatal: (fn) => (fatalFns.add(fn), () => void fatalFns.delete(fn)),
    calls,
    capabilityUse,
    get stats() {
      return stats;
    },
    get loadMs() {
      return loadMs;
    },
    onActivity: (fn) => (activityFns.add(fn), () => void activityFns.delete(fn)),
  };

  /** The host's own check and dispatch of a call the sandbox let through. */
  const handle = async (method: string, args: unknown[]): Promise<unknown> => {
    if (!METHOD_RE.test(method) || !(method in METHOD_CAPABILITY)) throw new PluginDenied(instance.id, method, "no such method");
    const cap = METHOD_CAPABILITY[method as keyof typeof METHOD_CAPABILITY];
    if (cap === "network") return pluginFetch(instance, args[0], args[1]);
    if (!isGranted(grants, cap)) throw new PluginDenied(instance.id, cap);
    const service = opts.services[method as keyof typeof METHOD_CAPABILITY];
    if (!service) throw new Error(`${method} is not available in this Lumen`);
    // UI is data: a tree of known elements, validated before the app renders it (uiTree.ts).
    if (method === "panel.render") args = [validateUiTree(args[0])];
    if (method === "renderer.result") args = [args[0], validateUiTree(args[1])];
    return service(instance, ...args);
  };

  return new Promise<PluginInstance>((resolve, reject) => {
    const timer = setTimeout(() => {
      die("the plugin did not start within 20 s");
      reject(new Error(`plugin ${opts.manifest.id} did not start within ${READY_TIMEOUT_MS / 1000} s`));
    }, READY_TIMEOUT_MS);
    worker.onerror = (e) => {
      const msg = e.message || "plugin worker failed";
      clearTimeout(timer);
      die(msg);
      reject(new Error(msg));
    };
    worker.onmessage = (ev: MessageEvent<WorkerToHost>) => {
      const m = ev.data;
      if (m.type === "ready") {
        clearTimeout(timer);
        loadMs = m.loadMs;
        resolve(instance);
      } else if (m.type === "stats") {
        const { type: _t, ...rest } = m;
        stats = rest;
        activity();
      } else if (m.type === "call") {
        const t0 = performance.now();
        let capability = String(METHOD_CAPABILITY[m.method as keyof typeof METHOD_CAPABILITY] ?? m.method);
        // A network call counts against the origin it went to, as the manifest names it.
        if (capability === "network") {
          try {
            capability = `network:${new URL(String((m.args as unknown[])[0])).origin}`;
          } catch {
            /* not a URL: the host refuses it below */
          }
        }
        void handle(m.method, m.args).then(
          (value) => {
            record({ at: Date.now(), method: m.method, capability, ms: Math.round((performance.now() - t0) * 10) / 10, outcome: "ok" });
            if (alive) send({ type: "result", id: m.id, ok: true, value: value === undefined ? null : value });
          },
          (e: unknown) => {
            const deniedErr = e instanceof PluginDenied;
            record({ at: Date.now(), method: m.method, capability: deniedErr ? e.capability : capability, ms: Math.round((performance.now() - t0) * 10) / 10, outcome: deniedErr ? "denied" : "error" });
            if (deniedErr) denied.set(e.capability, (denied.get(e.capability) ?? 0) + 1);
            if (alive) send({ type: "result", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e), denied: deniedErr });
          },
        );
      } else if (m.type === "log") {
        for (const f of logFns) f(m.level, m.text);
      } else if (m.type === "fatal") {
        clearTimeout(timer);
        die(m.error);
        reject(new Error(m.error));
      } else if (m.type === "unloaded") unloaded?.();
    };
    send({ type: "load", manifest: opts.manifest, code: opts.code, grants: [...grants], limits: { ...DEFAULT_LIMITS, ...opts.limits }, wasmUrl: quickJsWasmUrl() });
  });
}
