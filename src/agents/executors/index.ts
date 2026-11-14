/**
 * Executor registry. Executors register themselves at import time; the
 * runtime asks for the first available one in the agent's preference
 * order. Default order: native Ollama, in-browser web-llm, then the
 * `chat()` adapter (which itself honours the AI policy).
 */

import type { Availability, Executor, ExecutorId } from "../types";
import { getAiPolicy } from "../../ai/policy";
import { chatExecutor } from "./chatExecutor";
import { ollamaExecutor } from "./ollama";
import { webllmExecutor } from "./webllm";

const registry = new Map<ExecutorId, Executor>();

export const DEFAULT_EXECUTOR_ORDER: ExecutorId[] = ["ollama", "webllm", "chat"];

export function registerExecutor(executor: Executor): void {
  registry.set(executor.id, executor);
}

export function getExecutor(id: ExecutorId): Executor | undefined {
  return registry.get(id);
}

export function listExecutors(): Executor[] {
  return [...registry.values()];
}

/** Reset to the built-in set (tests). */
export function resetExecutors(): void {
  registry.clear();
  registerExecutor(ollamaExecutor);
  registerExecutor(webllmExecutor);
  registerExecutor(chatExecutor);
}

export const EXECUTOR_PREF_KEY = "lumen.ai.executor";

/** The user's preferred executor from the AI settings panel, or null for automatic. */
export function preferredExecutor(): ExecutorId | null {
  try {
    const v = localStorage.getItem(EXECUTOR_PREF_KEY);
    return v === "ollama" || v === "webllm" || v === "chat" ? v : null;
  } catch {
    return null;
  }
}

export function setPreferredExecutor(id: ExecutorId | null): void {
  try {
    if (id) localStorage.setItem(EXECUTOR_PREF_KEY, id);
    else localStorage.removeItem(EXECUTOR_PREF_KEY);
  } catch {
    /* why: storage denied */
  }
}

/** Move the preferred executor to the front when the agent allows it at all. */
export function withPreference(order: ExecutorId[], pref: ExecutorId | null = preferredExecutor()): ExecutorId[] {
  if (!pref || !order.includes(pref)) return order;
  return [pref, ...order.filter((id) => id !== pref)];
}

export interface ExecutorPick {
  executor: Executor | null;
  /** Why each candidate was skipped, in order. */
  skipped: Array<{ id: ExecutorId; availability: Availability }>;
}

/**
 * Under the `cloud` policy the selected provider answers directly, through
 * the chat() adapter; the native local executors are skipped (an explicit
 * `executor` from the suggestions panel still wins).
 */
export async function pickExecutor(preference: ExecutorId[] = DEFAULT_EXECUTOR_ORDER, forced?: ExecutorId): Promise<ExecutorPick> {
  const order = forced ? [forced] : withPreference(preference);
  const skipped: ExecutorPick["skipped"] = [];
  const cloudOnly = !forced && getAiPolicy() === "cloud";
  for (const id of order) {
    const ex = registry.get(id);
    if (!ex) {
      skipped.push({ id, availability: { available: false, reason: "not-registered" } });
      continue;
    }
    if (cloudOnly && id !== "chat") {
      skipped.push({ id, availability: { available: false, reason: "policy", detail: "cloud" } });
      continue;
    }
    let a: Availability;
    try {
      a = await ex.available();
    } catch (e) {
      a = { available: false, reason: "error", detail: (e as Error)?.message };
    }
    if (a.available) return { executor: ex, skipped };
    skipped.push({ id, availability: a });
  }
  return { executor: null, skipped };
}

resetExecutors();
