/**
 * Agent run traces — the last runs on this device, so a user (or the
 * suggestions panel) can see which executor and model answered, which
 * tools were called, how many retries it took and why a run failed.
 *
 * Kept in IndexedDB under one key (a small ring buffer), with an in-memory
 * mirror so reads are synchronous once loaded. Outputs are truncated: the
 * trace is for diagnosis, not a second copy of every document. In an
 * encrypted vault (plan 11.4) the list is stored sealed, and not written at
 * all while the vault is locked.
 */

import { get, set } from "idb-keyval";
import { forStore, fromStore, isSealedValue } from "../storage/vault/restStore";
import type { AgentRun } from "./types";

export const TRACE_LIMIT = 50;
const IDB_KEY = "lumen-agent-trace";
const OUTPUT_PREVIEW = 400;

let runs: AgentRun[] = [];
let loaded: Promise<void> | null = null;
const listeners = new Set<(runs: AgentRun[]) => void>();

function previewOf(run: AgentRun): AgentRun {
  const output = run.output === undefined ? undefined : typeof run.output === "string" ? run.output : JSON.stringify(run.output);
  return {
    ...run,
    output: output === undefined ? undefined : output.length > OUTPUT_PREVIEW ? output.slice(0, OUTPUT_PREVIEW) + "…" : output,
    steps: run.steps.map((st) => ({ ...st, detail: st.detail && st.detail.length > OUTPUT_PREVIEW ? st.detail.slice(0, OUTPUT_PREVIEW) + "…" : st.detail })),
  };
}

const LABEL = "agent-trace";

export function loadTrace(): Promise<void> {
  if (!loaded) {
    const p: Promise<void> = get(IDB_KEY)
      .then(async (stored: unknown) => {
        const v = await fromStore<unknown>(LABEL, stored);
        // Sealed and the vault is locked: try again after it is unlocked.
        if (v === undefined && isSealedValue(stored)) {
          if (loaded === p) loaded = null;
          return;
        }
        if (Array.isArray(v)) runs = [...(v as AgentRun[]), ...runs].slice(0, TRACE_LIMIT);
      })
      .catch(() => {
        // why: IndexedDB unavailable or unreadable: the trace starts empty for this session
      });
    loaded = p;
  }
  return loaded;
}

async function persist(): Promise<void> {
  const v = await forStore(LABEL, runs);
  if (v !== undefined) await set(IDB_KEY, v);
}

export async function recordRun(run: AgentRun): Promise<void> {
  await loadTrace();
  runs = [previewOf(run), ...runs].slice(0, TRACE_LIMIT);
  for (const l of listeners) l(runs);
  await persist().catch(() => {
    // why: storage full or blocked: the run stays in the in-memory trace for this session
  });
}

/** Store the list again — sealed now that the vault is encrypted (plan 11.4). */
export async function resealTrace(): Promise<void> {
  await loadTrace();
  await persist();
}

/** Most recent first. */
export function listRuns(): AgentRun[] {
  return runs;
}

export function onTrace(listener: (runs: AgentRun[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function clearTrace(): Promise<void> {
  runs = [];
  loaded = Promise.resolve();
  for (const l of listeners) l(runs);
  await set(IDB_KEY, []).catch(() => { /* why: the in-memory trace is already cleared; IndexedDB unavailable means nothing was stored */ });
}

/** One line per run, for the palette report. */
export function formatTraceReport(list: AgentRun[] = runs): string {
  if (!list.length) return "—";
  return list
    .map((r) => {
      const ms = Math.max(0, r.endedAt - r.startedAt);
      const tools = r.steps.filter((st) => st.kind === "tool").length;
      const status = r.status === "ok" ? "✓" : r.status === "aborted" ? "⏹" : "✗";
      const head = `${status} ${r.agentId} · ${r.executor ?? "—"} / ${r.model ?? "—"} · ${(ms / 1000).toFixed(1)}s · ${r.attempts}× · ${tools} tools · ${r.tokens.input}+${r.tokens.output} tok`;
      return r.status === "ok" ? head : `${head}\n   ${r.errorCode ?? "error"}: ${r.error ?? ""}`;
    })
    .join("\n");
}
