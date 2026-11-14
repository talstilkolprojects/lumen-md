/**
 * Plan W4.31 — tool-call reliability on real local models: the 200 probes
 * (toolProbes.ts) through the runtime on each model, with the real tools'
 * descriptions and schemas. Not part of the normal test run:
 * `npm run eval:tool-calls` (it sets LUMEN_EVAL_TOOLCALLS=1); also a step of
 * `npm run models:day`.
 *
 *   LUMEN_EVAL_OLLAMA_URL   default http://localhost:11434
 *   LUMEN_EVAL_MODELS       comma-separated, default qwen2.5:7b,gemma3:12b (must be pulled)
 *   LUMEN_EVAL_OUT          report directory, default eval/results
 *
 * Target: ≥ 95 % valid calls (a schema-valid call to the right tool) on
 * both models. Nothing is executed: the offered tools only record the call.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import { ALL_TOOLS } from "../tools";
import { PROBE_TOOLS, TOOL_PROBES } from "./toolProbes";
import { runProbe, summarize, type ProbeResult, type ProbeSummary } from "./toolCalls";

const url = process.env.LUMEN_EVAL_OLLAMA_URL || "http://localhost:11434";
const models = (process.env.LUMEN_EVAL_MODELS || "qwen2.5:7b,gemma3:12b").split(",").map((s) => s.trim()).filter(Boolean);
const outDir = process.env.LUMEN_EVAL_OUT || "eval/results";

// skip-reason: an opt-in eval against a real local model (LUMEN_EVAL_TOOLCALLS=1), not a unit test | task: W4.31 | until: 2027-05-12
describe.skipIf(!process.env.LUMEN_EVAL_TOOLCALLS)(`tool-call eval — ${models.join(", ")} @ ${url}`, () => {
  it("runs the 200 probes on every model and writes the report", async () => {
    // privacy-ledger: the local Ollama the eval was pointed at (loopback by default)
    const tags = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) }).catch((e: Error) => e);
    expect(tags instanceof Error ? `Ollama unreachable at ${url}: ${tags.message}` : "ok").toBe("ok");
    const names = (((await (tags as Response).json()) as { models?: Array<{ name: string }> }).models ?? []).map((m) => m.name);
    for (const m of models) expect(names.includes(m) || names.includes(`${m}:latest`) ? "ok" : `model ${m} is not pulled — run: ollama pull ${m}`).toBe("ok");
    // privacy-ledger: the same local Ollama
    const ver = (await fetch(`${url}/api/version`).then((r) => r.json()).catch(() => ({}))) as { lumen_fake?: boolean };

    localStorage.setItem("lumen.ollama.baseUrl", url);
    localStorage.setItem("lumen.ai.policy", "local-only");
    // The real tools' descriptions and schemas (the probe specs are their copies).
    const specs = PROBE_TOOLS.map((p) => {
      const real = ALL_TOOLS.find((t) => t.name === p.name);
      return real ? { name: real.name, description: real.description, parameters: real.parameters } : p;
    });

    const report: Record<string, ProbeSummary> = {};
    const rows: Record<string, ProbeResult[]> = {};
    for (const model of models) {
      localStorage.setItem("lumen.ollama.model", model);
      rows[model] = [];
      for (const p of TOOL_PROBES) {
        const r = await runProbe(p, specs, { executorId: "ollama", model });
        rows[model].push(r);
        // hygiene-allow: progress output of a CLI eval run
        console.log(`${r.valid ? "ok  " : "FAIL"}  ${model}  ${r.id}  ${r.ms} ms${r.recovered ? "  (recovered)" : ""}${r.error ? `  ${r.error}` : ""}`);
      }
      report[model] = summarize(rows[model]);
    }

    const date = new Date().toISOString().slice(0, 10);
    const kind = ver.lumen_fake ? "wiring" : "model";
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `tool-calls-${date}.json`), JSON.stringify({ kind, url, date, target: 0.95, models: report, rows }, null, 2));
    const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
    const md = [
      `# Tool-call reliability — ${date}${kind === "wiring" ? " (WIRING RUN, fake Ollama: not a model score)" : ""}`,
      "",
      "Valid = a schema-valid call to the right tool, after the runtime's repair and its one retry (plan W4.31, target ≥ 95 %).",
      "",
      "| Model | Valid | Hebrew | English | Right arguments | Passed the old parser | Recovered | Retried | Asked the user | p50 |",
      "|---|---|---|---|---|---|---|---|---|---|",
      ...Object.entries(report).map(([m, s]) => `| ${m} | ${s.valid}/${s.total} (${pct(s.share)}) | ${s.byLang.he.valid}/${s.byLang.he.total} | ${s.byLang.en.valid}/${s.byLang.en.total} | ${s.argsMatch} | ${s.before} | ${s.recovered} | ${s.retried} | ${s.askedUser} | ${s.p50Ms} ms |`),
    ].join("\n");
    writeFileSync(join(outDir, `tool-calls-${date}.md`), md + "\n");
    // hygiene-allow: tells the person running the eval where the report is
    console.log(`\n${md}\n\nReport: ${join(outDir, `tool-calls-${date}.md`)}`);
  }, 4 * 60 * 60 * 1000);
});
