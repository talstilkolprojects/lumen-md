/**
 * Plan 7.2: the real-tiny-model run — its structural judge, its report, and
 * the clean skip when no model can be had (no Ollama, no registry). The run
 * itself needs a model: `npm run ci:real-model` (nightly workflow).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { judgeRun, judgeTurn } from "../agents/eval/structure";
import { formatRealReport } from "../agents/eval/real.eval";
import { getAgent } from "../agents/registry";
import "../agents/defs";
import type { AgentDefinition, AgentInput } from "../agents/types";

const agent = (id: string) => getAgent(id) as AgentDefinition<AgentInput, unknown>;
const turn = (content: string, toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []) => ({ content, toolCalls });

describe("structural judge", () => {
  it("a tool turn: an offered tool with arguments that pass its schema", () => {
    expect(judgeTurn(agent("researcher"), turn('{"tool": "search_web", "args": {"query": "roses"}}'))).toMatchObject({ ok: true, kind: "tool" });
    expect(judgeTurn(agent("researcher"), turn('{"tool": "write_file", "args": {}}'))).toMatchObject({ ok: false, detail: expect.stringContaining('unknown tool "write_file"') });
    expect(judgeTurn(agent("researcher"), turn('{"tool": "search_web", "args": {"count": 3}}'))).toMatchObject({ ok: false, detail: expect.stringContaining("search_web") });
    // Native tool calls; numbers sent as strings are coerced first, like the runtime does.
    expect(judgeTurn(agent("researcher"), turn("", [{ id: "1", name: "search_web", args: { query: "q", count: "2" } }]))).toMatchObject({ ok: true });
  });

  it("a final turn: JSON for an agent with an output schema, text otherwise; a cut-off turn is judged by its start", () => {
    expect(judgeTurn(agent("tagger"), turn('{"final": {"tags": ["a"]}}'))).toMatchObject({ ok: true, kind: "final" });
    expect(judgeTurn(agent("tagger"), turn('{"final": "just some prose"}'))).toMatchObject({ ok: false });
    expect(judgeTurn(agent("tagger"), turn('{"final": {"tags": ["a", "b'))).toMatchObject({ ok: true });
    expect(judgeTurn(agent("completer"), turn("<think>hmm</think> fox jumps"))).toMatchObject({ ok: true, kind: "final" });
    expect(judgeTurn(agent("completer"), turn("<think>still thinking"))).toMatchObject({ ok: false, detail: "empty answer" });
  });

  it("a run passes only when every turn has the right shape", () => {
    expect(judgeRun(agent("researcher"), [])).toMatchObject({ ok: false });
    expect(judgeRun(agent("researcher"), [turn('{"tool": "search_web", "args": {"query": "q"}}'), turn('{"final": {"report": "x"}}')])).toMatchObject({ ok: true, detail: "tool → final" });
    expect(judgeRun(agent("researcher"), [turn('{"tool": "search_web", "args": {"query": "q"}}'), turn("prose, no JSON")])).toMatchObject({ ok: false });
  });

  it("the report counts agents and cases", () => {
    const md = formatRealReport(
      [
        { id: "a-1", agent: "a", ok: true, detail: "tool → final", turns: 2, ms: 900 },
        { id: "b-1", agent: "b", ok: false, detail: "x|y", turns: 1, ms: 100 },
      ],
      { model: "qwen3:0.6b", url: "u", date: "2026-10-24", ms: 1000, maxTokens: 64 },
    );
    expect(md).toContain("**1/2 agents** returned output of the right shape (1/2 cases).");
    expect(md).toContain("| b-1 | b | FAIL | 1 | 0.1 s | x\\|y |");
  });
});

describe("scripts/real-tiny-model.mjs skips cleanly without a model", () => {
  const script = join(__dirname, "..", "..", "scripts", "real-tiny-model.mjs");
  const run = (env: Record<string, string>) => {
    const out = mkdtempSync(join(tmpdir(), "lumen-real-"));
    // No Ollama on PATH (only node's own directory) and nothing listening on the URL.
    const r = spawnSync(process.execPath, [script, "--url", "http://127.0.0.1:9", "--out", out], { encoding: "utf8", env: { PATH: dirname(process.execPath), ...env } });
    return { r, out };
  };

  it("no Ollama: exit 0, a 'skipped' report that says why", () => {
    const { r, out } = run({});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("real-model: skipped");
    const report = join(out, "real-skipped.md");
    expect(existsSync(report)).toBe(true);
    expect(readFileSync(report, "utf8")).toMatch(/\*\*Skipped:\*\* Ollama is not running at http:\/\/127\.0\.0\.1:9/);
  });

  it("LUMEN_REAL_MODEL_REQUIRED=1 (the nightly job, model cached): a skip fails", () => {
    expect(run({ LUMEN_REAL_MODEL_REQUIRED: "1" }).r.status).toBe(1);
  });
});
