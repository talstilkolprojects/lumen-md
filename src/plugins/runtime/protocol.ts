/**
 * Messages between the plugin host (main thread) and the sandbox worker
 * that runs a plugin's logic in QuickJS (plan 11.2.2). Everything that
 * crosses is JSON-serialisable; the worker sees no DOM, no app state and
 * no network — only what the host answers.
 */
import type { Capability, PluginManifest } from "./manifest";

/** Resource limits of the QuickJS runtime, per plugin. */
export interface SandboxLimits {
  /** Heap, bytes. */
  memoryBytes: number;
  /** Stack, bytes. */
  stackBytes: number;
  /** CPU per entry into plugin code (a call, an event, a job queue drain), milliseconds. */
  cpuMsPerEntry: number;
  /** Console lines per minute before further output is dropped. */
  logLinesPerMinute: number;
}

export const DEFAULT_LIMITS: SandboxLimits = { memoryBytes: 32 * 1024 * 1024, stackBytes: 512 * 1024, cpuMsPerEntry: 250, logLinesPerMinute: 120 };

export type HostToWorker =
  | { type: "load"; manifest: PluginManifest; code: string; grants: Capability[]; limits: SandboxLimits; wasmUrl?: string }
  /** The answer to a `call` the worker made. */
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; error: string; denied?: boolean }
  /** Something happened in the app that the plugin subscribed to (a command it registered ran, …). */
  | { type: "event"; name: string; payload: unknown }
  | { type: "unload" };

export type WorkerToHost =
  | { type: "ready"; loadMs: number }
  | { type: "call"; id: number; method: string; args: unknown[] }
  | { type: "log"; level: "log" | "warn" | "error"; text: string }
  /** The plugin's code failed: at load, in an event handler, or hit a limit. The worker is dead afterwards. */
  | { type: "fatal"; error: string }
  | { type: "unloaded" };

/** The host-side API names a plugin can call: `<namespace>.<method>`. */
export const METHOD_RE = /^[a-z]+\.[a-zA-Z]+$/;
