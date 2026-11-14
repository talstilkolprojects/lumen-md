/**
 * The plugin logic sandbox (plan 11.2.2): a plugin's `main` runs inside
 * QuickJS (quickjs-emscripten, MIT) — a separate JavaScript engine compiled
 * to WebAssembly, with its own heap and no I/O at all. There is no `fetch`,
 * no `XMLHttpRequest`, no `WebSocket`, no `importScripts`, no DOM, no
 * storage: the only way out is the `lumen` API object this module injects,
 * and each of its methods needs a capability the user granted (default
 * deny; capabilities.ts). Limits: heap, stack, CPU per entry, log rate.
 *
 * Runs in a Worker (host.worker.ts) in the app, and directly in Node for
 * the tests. Values cross as JSON strings only.
 */
import type { QuickJSContext, QuickJSHandle, QuickJSRuntime, QuickJSWASMModule } from "quickjs-emscripten-core";
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import { isGranted, METHOD_CAPABILITY, networkGranted, PluginDenied, type Grants } from "./capabilities";
import type { PluginManifest } from "./manifest";
import { DEFAULT_LIMITS, METHOD_RE, type SandboxLimits } from "./protocol";

export interface SandboxHost {
  /** Perform a granted call in the app. Rejections become errors inside the plugin. */
  call(method: string, args: unknown[]): Promise<unknown>;
  log(level: "log" | "warn" | "error", text: string): void;
  /** The plugin's code failed in a way that ends it (uncaught error, limit). */
  fatal(error: string): void;
}

export interface SandboxOptions {
  manifest: PluginManifest;
  code: string;
  grants: Grants;
  limits?: Partial<SandboxLimits>;
  host: SandboxHost;
  /** Where the QuickJS wasm is served from (the app stages it; Node finds it next to the package). */
  wasmUrl?: string;
}

export interface Sandbox {
  /** Deliver an event to the plugin's handlers (a registered command ran, the document changed, …). */
  dispatch(name: string, payload: unknown): Promise<void>;
  /** Calls the plugin made that were refused for a missing capability, by capability. */
  readonly denied: ReadonlyMap<string, number>;
  dispose(): void;
}

/** The API surface inside the sandbox, from the method table: `lumen.<ns>.<fn>(...args)` → host call. */
const PRELUDE = `
"use strict";
(function () {
  const methods = __lumen_methods.split(",");
  const lumen = Object.create(null);
  const handlers = new Map();
  function call(method, args) {
    return __lumen_call(method, JSON.stringify(args)).then((json) => (json === "" ? undefined : JSON.parse(json)));
  }
  for (const m of methods) {
    const [ns, fn] = m.split(".");
    lumen[ns] ??= Object.create(null);
    lumen[ns][fn] = (...args) => call(m, args);
  }
  // Events: lumen.on(name, handler) → unsubscribe. Command handlers are events named "command:<id>".
  lumen.on = (name, handler) => {
    if (typeof handler !== "function") throw new TypeError("handler must be a function");
    const list = handlers.get(name) ?? [];
    list.push(handler);
    handlers.set(name, list);
    return () => handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== handler));
  };
  lumen.commands.register = (cmd, handler) => {
    if (handler) lumen.on("command:" + cmd.id, handler);
    return call("commands.register", [cmd]);
  };
  lumen.manifest = Object.freeze(JSON.parse(__lumen_manifest));
  globalThis.__lumen_dispatch = (name, json) => {
    const payload = json === "" ? undefined : JSON.parse(json);
    const list = handlers.get(name) ?? [];
    return Promise.all(list.map((h) => Promise.resolve().then(() => h(payload)))).then(() => undefined);
  };
  const fmt = (args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  globalThis.console = Object.freeze({
    log: (...a) => __lumen_log("log", fmt(a)),
    info: (...a) => __lumen_log("log", fmt(a)),
    debug: (...a) => __lumen_log("log", fmt(a)),
    warn: (...a) => __lumen_log("warn", fmt(a)),
    error: (...a) => __lumen_log("error", fmt(a)),
  });
  Object.freeze(lumen);
  for (const ns of Object.keys(lumen)) if (typeof lumen[ns] === "object") Object.freeze(lumen[ns]);
  Object.defineProperty(globalThis, "lumen", { value: lumen, writable: false, configurable: false, enumerable: true });
  delete globalThis.__lumen_methods;
  delete globalThis.__lumen_manifest;
})();
`;

let modulePromise: Promise<QuickJSWASMModule> | null = null;

/** The QuickJS WebAssembly module, loaded once per thread. */
export function loadQuickJS(wasmUrl?: string): Promise<QuickJSWASMModule> {
  modulePromise ??= (async () => {
    const base = (await import("@jitl/quickjs-wasmfile-release-sync")).default;
    return newQuickJSWASMModuleFromVariant(wasmUrl ? newVariant(base, { wasmLocation: wasmUrl }) : base);
  })();
  return modulePromise;
}

export async function createSandbox(opts: SandboxOptions): Promise<Sandbox> {
  const limits: SandboxLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const QuickJS = await loadQuickJS(opts.wasmUrl);
  const runtime: QuickJSRuntime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  // CPU: every entry into plugin code (eval, event, job drain) gets `cpuMsPerEntry`; the handler is polled by the interpreter.
  let deadline = Infinity;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context: QuickJSContext = runtime.newContext();
  const denied = new Map<string, number>();
  let disposed = false;
  let callSeq = 0;
  const pendingCalls = new Set<number>();

  // Log rate limit: a sliding minute.
  const logTimes: number[] = [];
  const log = (level: "log" | "warn" | "error", text: string) => {
    const now = Date.now();
    while (logTimes.length && now - logTimes[0] > 60_000) logTimes.shift();
    if (logTimes.length >= limits.logLinesPerMinute) return;
    logTimes.push(now);
    opts.host.log(level, text.slice(0, 2000));
  };

  // While the plugin loads, a fatal error is thrown from createSandbox instead of reported.
  let loading = true;
  let loadError: string | null = null;
  const fatal = (error: string) => {
    if (disposed) return;
    if (loading) loadError = error;
    else opts.host.fatal(error);
    dispose();
  };

  /** Run `fn` as one entry into plugin code: CPU deadline on, pending jobs drained after. */
  const enter = <T>(fn: () => T): T => {
    deadline = Date.now() + limits.cpuMsPerEntry;
    try {
      const out = fn();
      drain();
      return out;
    } finally {
      deadline = Infinity;
    }
  };
  const drain = () => {
    const r = runtime.executePendingJobs();
    if (r.error) {
      const err = describe(context, r.error);
      r.error.dispose();
      fatal(`uncaught in plugin ${opts.manifest.id}: ${err}`);
    }
  };

  /** The one door out: `__lumen_call(method, argsJson)` → a promise of a JSON string. */
  const callFn = context.newFunction("__lumen_call", (methodH, argsH) => {
    const method = context.getString(methodH);
    const argsJson = context.getString(argsH);
    const deferred = context.newPromise();
    const id = ++callSeq;
    pendingCalls.add(id);
    const settle = (ok: boolean, text: string) => {
      pendingCalls.delete(id);
      if (disposed) return;
      deadline = Date.now() + limits.cpuMsPerEntry;
      try {
        if (ok) deferred.resolve(context.newString(text));
        else deferred.reject(context.newError({ name: text.startsWith("PluginDenied:") ? "PluginDenied" : "Error", message: text.replace(/^PluginDenied:\s*/, "") }));
        drain();
      } finally {
        deferred.dispose();
        deadline = Infinity;
      }
    };
    void (async () => {
      // Never settle inside the native call itself: the promise handle is still being handed back to QuickJS.
      await Promise.resolve();
      let args: unknown[];
      try {
        args = JSON.parse(argsJson) as unknown[];
        if (!Array.isArray(args)) throw new Error("args");
      } catch {
        return settle(false, "arguments must be JSON-serialisable");
      }
      const refusal = refuse(method, args);
      if (refusal) {
        denied.set(refusal.capability, (denied.get(refusal.capability) ?? 0) + 1);
        return settle(false, `PluginDenied: ${refusal.message}`);
      }
      try {
        const value = await opts.host.call(method, args);
        settle(true, value === undefined ? "" : JSON.stringify(value));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        settle(false, e instanceof PluginDenied || (e as Error)?.name === "PluginDenied" ? `PluginDenied: ${msg}` : msg);
      }
    })();
    return deferred.handle;
  });

  /** Capability check inside the sandbox — before anything reaches the host. */
  const refuse = (method: string, args: unknown[]): PluginDenied | null => {
    if (!METHOD_RE.test(method) || !(method in METHOD_CAPABILITY)) return new PluginDenied(opts.manifest.id, method, "no such method");
    const cap = METHOD_CAPABILITY[method];
    if (cap === "network") {
      const url = typeof args[0] === "string" ? args[0] : "";
      let origin = "?";
      try {
        origin = new URL(url).origin;
      } catch {
        /* why: keep "?" */
      }
      return networkGranted(opts.grants, url) ? null : new PluginDenied(opts.manifest.id, `network:${origin}`);
    }
    return isGranted(opts.grants, cap) ? null : new PluginDenied(opts.manifest.id, cap);
  };

  const logFn = context.newFunction("__lumen_log", (levelH, textH) => {
    const level = context.getString(levelH);
    log(level === "warn" || level === "error" ? level : "log", context.getString(textH));
  });
  const methodsH = context.newString(Object.keys(METHOD_CAPABILITY).join(","));
  const manifestH = context.newString(JSON.stringify(opts.manifest));
  context.setProp(context.global, "__lumen_call", callFn);
  context.setProp(context.global, "__lumen_log", logFn);
  context.setProp(context.global, "__lumen_methods", methodsH);
  context.setProp(context.global, "__lumen_manifest", manifestH);
  callFn.dispose();
  logFn.dispose();
  methodsH.dispose();
  manifestH.dispose();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      context.dispose();
    } catch {
      /* why: already gone */
    }
    try {
      runtime.dispose();
    } catch {
      /* why: already gone */
    }
  };

  // Prelude, then the plugin's module.
  const preludeResult = enter(() => context.evalCode(PRELUDE, "lumen-prelude.js"));
  if (disposed) throw new Error(`sandbox prelude failed: ${loadError}`);
  if (preludeResult.error) {
    const err = describe(context, preludeResult.error);
    preludeResult.error.dispose();
    dispose();
    throw new Error(`sandbox prelude failed: ${err}`);
  }
  preludeResult.value.dispose();

  const mainResult = enter(() => context.evalCode(opts.code, opts.manifest.main, { type: "module", strict: true }));
  if (disposed) throw new Error(`plugin ${opts.manifest.id} failed to load: ${loadError}`);
  if (mainResult.error) {
    const err = describe(context, mainResult.error);
    mainResult.error.dispose();
    dispose();
    throw new Error(`plugin ${opts.manifest.id} failed to load: ${err}`);
  }
  // A module may return a promise (top-level await): await it so load errors surface here.
  const modH = mainResult.value;
  if (context.typeof(modH) === "object" && isPromise(context, modH)) {
    const state = await settleModule(context, runtime, modH, limits, () => (deadline = Date.now() + limits.cpuMsPerEntry), () => (deadline = Infinity));
    if (!disposed) modH.dispose();
    if (state || disposed) {
      dispose();
      throw new Error(`plugin ${opts.manifest.id} failed to load: ${state ?? loadError}`);
    }
  } else modH.dispose();
  loading = false;

  return {
    denied,
    async dispatch(name, payload) {
      if (disposed) return;
      const dispatchH = context.getProp(context.global, "__lumen_dispatch");
      const nameH = context.newString(name);
      const payloadH = context.newString(payload === undefined ? "" : JSON.stringify(payload));
      let out;
      try {
        out = enter(() => context.callFunction(dispatchH, context.undefined, nameH, payloadH));
      } finally {
        dispatchH.dispose();
        nameH.dispose();
        payloadH.dispose();
      }
      if (disposed) return;
      if (out.error) {
        const err = describe(context, out.error);
        out.error.dispose();
        fatal(`plugin ${opts.manifest.id} event "${name}": ${err}`);
        return;
      }
      // Handlers are async: wait for their promise, running jobs as host calls settle.
      const h = out.value;
      const failure = await settleModule(context, runtime, h, limits, () => (deadline = Date.now() + limits.cpuMsPerEntry), () => (deadline = Infinity));
      if (!disposed) h.dispose();
      if (failure && !disposed) fatal(`plugin ${opts.manifest.id} event "${name}": ${failure}`);
    },
    dispose,
  };
}

function isPromise(context: QuickJSContext, h: QuickJSHandle): boolean {
  const then = context.getProp(h, "then");
  const yes = context.typeof(then) === "function";
  then.dispose();
  return yes;
}

/** Wait for a promise inside the sandbox; returns the rejection text, or null when fulfilled. */
async function settleModule(context: QuickJSContext, runtime: QuickJSRuntime, h: QuickJSHandle, limits: SandboxLimits, arm: () => void, disarm: () => void): Promise<string | null> {
  // Poll: host calls settle on the native event loop and re-enter the runtime themselves.
  const started = Date.now();
  for (;;) {
    if (!context.alive) return "the plugin was stopped";
    let state;
    arm();
    try {
      state = context.getPromiseState(h);
      const jobs = runtime.executePendingJobs();
      if (jobs.error) {
        const err = describe(context, jobs.error);
        jobs.error.dispose();
        return err;
      }
    } finally {
      disarm();
    }
    if (state.type === "fulfilled") {
      state.value.dispose();
      return null;
    }
    if (state.type === "rejected") {
      const err = describe(context, state.error);
      state.error.dispose();
      return err;
    }
    if (Date.now() - started > Math.max(10_000, limits.cpuMsPerEntry * 40)) return "timed out waiting for the plugin's promise";
    await new Promise((r) => setTimeout(r, 2));
  }
}

function describe(context: QuickJSContext, errH: QuickJSHandle): string {
  try {
    const v = context.dump(errH) as unknown;
    if (v && typeof v === "object" && "message" in v) {
      const e = v as { name?: string; message?: string; stack?: string };
      return `${e.name ?? "Error"}: ${e.message ?? ""}`;
    }
    return String(v);
  } catch {
    return "unknown error";
  }
}
