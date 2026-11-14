/**
 * Live agent eval against a real local model. Not part of the normal test
 * run (no `.test.` in the name); start it with `npm run eval:agents`.
 *
 *   LUMEN_EVAL_OLLAMA_URL   default http://localhost:11434
 *   LUMEN_EVAL_MODEL        default qwen2.5:7b (must be pulled)
 *   LUMEN_EVAL_ONLY         comma-separated case ids or agent ids
 *   LUMEN_EVAL_OUT          report directory, default eval/results
 *
 * Writes a Markdown report and the raw JSON; the test itself only fails
 * when Ollama is unreachable, so a bad score never looks like a crash.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import { EVAL_CASES } from "./fixtures";
import { runEvalCase } from "./run";
import { formatEvalReport, passed, type CaseResult } from "./score";

const url = process.env.LUMEN_EVAL_OLLAMA_URL || "http://localhost:11434";
const model = process.env.LUMEN_EVAL_MODEL || "qwen2.5:7b";
const only = (process.env.LUMEN_EVAL_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const outDir = process.env.LUMEN_EVAL_OUT || "eval/results";

describe(`agent eval — ${model} @ ${url}`, () => {
  it("runs every case and writes the report", async () => {
    const tags = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) }).catch((e: Error) => e);
    expect(tags instanceof Error ? `Ollama unreachable at ${url}: ${tags.message}` : "ok").toBe("ok");
    const names = (((await (tags as Response).json()) as { models?: Array<{ name: string }> }).models ?? []).map((m) => m.name);
    expect(names.includes(model) || names.includes(`${model}:latest`) ? "ok" : `model ${model} is not pulled (have: ${names.join(", ") || "none"}) — run: ollama pull ${model}`).toBe("ok");

    // The fake server (scripts/fake-ollama.mjs) only proves the wiring; label the report so
    // it can never be read, or compared, as a model score.
    const ver = (await fetch(`${url}/api/version`).then((r) => r.json()).catch(() => ({}))) as { lumen_fake?: boolean };
    const kind = ver.lumen_fake ? "wiring" : "model";
    const label = ver.lumen_fake ? "fake-ollama" : model;

    localStorage.setItem("lumen.ollama.baseUrl", url);
    localStorage.setItem("lumen.ollama.model", model);
    localStorage.setItem("lumen.ai.policy", "local-only");

    const results: CaseResult[] = [];
    for (const c of EVAL_CASES) {
      if (only.length && !only.includes(c.id) && !only.includes(c.agent)) {
        results.push({ id: c.id, agent: c.agent, status: "skipped", executor: null, model: null, attempts: 0, ms: 0, checks: [] });
        continue;
      }
      // Every case runs on the requested model, whatever tier it asks for.
      const r = await runEvalCase(c, { executor: "ollama", model });
      results.push(r);
      // hygiene-allow: progress output of a CLI eval run
      console.log(`${passed(r) ? "pass" : "FAIL"}  ${c.id}  ${(r.ms / 1000).toFixed(1)} s  ${r.error ?? r.checks.filter((x) => !x.ok).map((x) => x.detail).join("; ")}`);
    }

    const date = new Date().toISOString().slice(0, 10);
    const slug = label.replace(/[^\w.-]+/g, "_");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `agents-${date}-${slug}.md`), formatEvalReport(results, { model: label, url, date }));
    writeFileSync(join(outDir, `agents-${date}-${slug}.json`), JSON.stringify({ model: label, kind, url, date, results }, null, 2));
    // hygiene-allow: tells the person running the eval where the report is
    console.log(`\nReport: ${join(outDir, `agents-${date}-${slug}.md`)}`);
  }, 60 * 60 * 1000);
});
