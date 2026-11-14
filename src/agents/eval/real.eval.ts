/**
 * Real tiny model run (plan 7.2): every agent once against a real local
 * model — qwen3:0.6b on Ollama by default (Apache-2.0, tool calling, ~523 MB),
 * temperature 0, seed 42, no thinking phase, at most 64 tokens a turn — and
 * judged on structure (`structure.ts`): tool names and arguments against
 * the JSON Schema, the answer's format. Not on wording.
 *
 * Started by `npm run ci:real-model` (scripts/real-tiny-model.mjs), which
 * finds or starts Ollama, pulls the model, and skips cleanly when it can't.
 * Skipped unless LUMEN_REAL_MODEL is set, so `npm run eval:agents` doesn't
 * run it.
 *
 *   LUMEN_REAL_MODEL       the model (e.g. qwen3:0.6b) — required
 *   LUMEN_REAL_OLLAMA_URL  default http://127.0.0.1:11434
 *   LUMEN_EVAL_OUT         report directory, default eval/results
 *   LUMEN_REAL_MAX_TOKENS  default 64
 */

import { describe, it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));
vi.mock("../../storage/workspace", async (orig) => (await import("../../__tests__/helpers/evalVault")).workspaceModule(await orig()));
vi.mock("../../sync/git", async (orig) => (await import("../../__tests__/helpers/evalVault")).gitModule(await orig()));

import { EVAL_CASES } from "./fixtures";
import { runEvalCase } from "./run";
import { judgeRun } from "./structure";
import { getAgent } from "../registry";
import { getExecutor, registerExecutor } from "../executors";
import type { ExecutorResponse } from "../types";

const model = process.env.LUMEN_REAL_MODEL || "";
const url = process.env.LUMEN_REAL_OLLAMA_URL || "http://127.0.0.1:11434";
const outDir = process.env.LUMEN_EVAL_OUT || "eval/results";
const maxTokens = Number(process.env.LUMEN_REAL_MAX_TOKENS || 64);

interface RealResult {
  id: string;
  agent: string;
  ok: boolean;
  detail: string;
  turns: number;
  ms: number;
}

export function formatRealReport(results: RealResult[], meta: { model: string; url: string; date: string; ms: number; maxTokens: number }): string {
  const agents = [...new Set(results.map((r) => r.agent))];
  const agentOk = agents.filter((a) => results.filter((r) => r.agent === a).every((r) => r.ok));
  return [
    `# Real tiny model — ${meta.model}`,
    "",
    `${meta.date} · ${meta.url} · temperature 0 · seed 42 · ≤ ${meta.maxTokens} tokens a turn · ${(meta.ms / 1000).toFixed(1)} s in all`,
    "",
    `**${agentOk.length}/${agents.length} agents** returned output of the right shape (${results.filter((r) => r.ok).length}/${results.length} cases).`,
    "",
    "| case | agent | shape | turns | time | detail |",
    "|---|---|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${r.agent} | ${r.ok ? "ok" : "FAIL"} | ${r.turns} | ${(r.ms / 1000).toFixed(1)} s | ${r.detail.replace(/\|/g, "\\|")} |`),
    "",
  ].join("\n");
}

describe.skipIf(!model)(`real tiny model — ${model} @ ${url}`, () => {
  it("every agent returns output of the right shape", async () => {
    const tags = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) }).catch((e: Error) => e);
    expect(tags instanceof Error ? `Ollama unreachable at ${url}: ${tags.message}` : "ok").toBe("ok");

    localStorage.setItem("lumen.ollama.baseUrl", url);
    localStorage.setItem("lumen.ollama.model", model);
    localStorage.setItem("lumen.ai.policy", "local-only");
    (await import("../../__tests__/helpers/evalWeb")).installEvalWeb();

    // The real Ollama executor, pinned: temperature 0, a fixed seed, no thinking, ≤ maxTokens.
    const base = getExecutor("ollama");
    expect(base, "the Ollama executor is registered").toBeTruthy();
    let turns: ExecutorResponse[] = [];
    registerExecutor({
      ...base!,
      chat: async (req) => {
        const res = await base!.chat({ ...req, temperature: 0, seed: 42, think: false, maxTokens: Math.min(req.maxTokens ?? maxTokens, maxTokens) });
        turns.push(res);
        return res;
      },
    });

    const results: RealResult[] = [];
    const t0 = Date.now();
    for (const c of EVAL_CASES) {
      turns = [];
      const started = Date.now();
      const r = await runEvalCase(c, { executor: "ollama", model });
      const verdict = judgeRun(getAgent(c.agent)!, turns);
      results.push({ id: c.id, agent: c.agent, ok: verdict.ok, detail: verdict.ok ? verdict.detail : `${verdict.detail}${r.error ? ` (run: ${r.error})` : ""}`, turns: turns.length, ms: Date.now() - started });
      // hygiene-allow: progress output of a CLI run
      console.log(`${verdict.ok ? "ok  " : "FAIL"}  ${c.id}  ${verdict.detail}`);
    }
    const ms = Date.now() - t0;
    const date = new Date().toISOString().slice(0, 10);
    const slug = model.replace(/[^\w.-]+/g, "_");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `real-${date}-${slug}.md`), formatRealReport(results, { model, url, date, ms, maxTokens }));
    writeFileSync(join(outDir, `real-${date}-${slug}.json`), JSON.stringify({ model, url, date, ms, maxTokens, results }, null, 2));

    const agents = new Set(EVAL_CASES.map((c) => c.agent));
    expect(agents.size, "every agent has a case").toBeGreaterThanOrEqual(14);
    expect(results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.detail}`)).toEqual([]);
  }, 30 * 60 * 1000);
});
