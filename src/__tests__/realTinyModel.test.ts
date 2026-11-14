/**
 * Plan 7.2: the real-tiny-model run — its structural judge, its report, and
 * the clean skip when no model can be had (no Ollama, no registry), the
 * model digest (7.2.3) and the Hebrew smoke test (7.2.2). The run itself
 * needs a model: `npm run ci:real-model` (and `-- --hebrew-smoke`).
 */
import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { judgeRun, judgeTurn } from "../agents/eval/structure";
import { formatRealReport } from "../agents/eval/real.eval";
import { getAgent } from "../agents/registry";
import "../agents/defs";
import type { AgentDefinition, AgentInput } from "../agents/types";
import { HEBREW_SMOKE_MODEL, HEBREW_SMOKE_PROMPTS, digestMismatch, findModel, formatHebrewSmokeReport, hebrewShare, judgeHebrewAnswer, normalizeDigest, stripThinking } from "../../scripts/lib/real-model.mjs";

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

// ── 7.2.2 / 7.2.3: the Hebrew smoke test and the model digest ─────────────

describe("the model digest (7.2.3)", () => {
  const tags = { models: [{ name: "qwen3:0.6b", digest: "7df6b6e09427" }, { name: "mistral:latest", digest: "sha256:abc" }] };

  it("finds the model with or without :latest and normalises the digest", () => {
    expect(findModel(tags, "qwen3:0.6b")?.digest).toBe("7df6b6e09427");
    expect(findModel(tags, "mistral")?.name).toBe("mistral:latest");
    expect(findModel(tags, "llama3")).toBeNull();
    expect(normalizeDigest("7DF6B6E09427")).toBe("sha256:7df6b6e09427");
    expect(normalizeDigest(" sha256:abc ")).toBe("sha256:abc");
    expect(normalizeDigest(undefined)).toBe("");
  });

  it("no pin: the run goes on; a pin that matches goes on; any other build stops it", () => {
    expect(digestMismatch(findModel(tags, "qwen3:0.6b"), "")).toBeNull();
    expect(digestMismatch(findModel(tags, "qwen3:0.6b"), "sha256:7df6b6e09427")).toBeNull();
    expect(digestMismatch(findModel(tags, "qwen3:0.6b"), "sha256:0000")).toMatch(/pinned digest is sha256:0000, but the local model is sha256:7df6b6e09427/);
    expect(digestMismatch({ name: "x" }, "sha256:0000")).toMatch(/reported no digest/);
  });

  it("the report names the digest the run used", () => {
    const md = formatRealReport([], { model: "qwen3:0.6b", url: "u", date: "2026-11-14", ms: 0, maxTokens: 64, digest: "sha256:7df6" });
    expect(md).toContain("· digest sha256:7df6 ·");
    expect(formatRealReport([], { model: "m", url: "u", date: "d", ms: 0, maxTokens: 64 })).not.toContain("digest");
  });
});

describe("the Hebrew smoke test (7.2.2)", () => {
  it("runs DictaLM 3.0 1.7B, the build in the model catalogue", () => {
    expect(HEBREW_SMOKE_MODEL).toBe("hf.co/dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF");
    expect(HEBREW_SMOKE_PROMPTS.length).toBeGreaterThanOrEqual(3);
    for (const p of HEBREW_SMOKE_PROMPTS) expect(hebrewShare(p.prompt), p.id).toBeGreaterThan(0.9);
  });

  it("a Hebrew answer passes; English, empty, a lone reasoning block, or a wrong fact fails", () => {
    const capital = HEBREW_SMOKE_PROMPTS.find((p) => p.id === "he-capital")!;
    const sentence = HEBREW_SMOKE_PROMPTS.find((p) => p.id === "he-sentence")!;
    expect(judgeHebrewAnswer(capital, "<think>The capital of France is Paris.</think>\nפריז")).toMatchObject({ ok: true });
    expect(judgeHebrewAnswer(sentence, "היום שמשי וחם, עם רוח קלה מהים.")).toMatchObject({ ok: true });
    expect(judgeHebrewAnswer(sentence, "It is sunny today.")).toMatchObject({ ok: false, detail: "0% Hebrew letters (needs 60%)" });
    expect(judgeHebrewAnswer(sentence, "   ")).toMatchObject({ ok: false, detail: "empty answer" });
    expect(judgeHebrewAnswer(sentence, "<think>still thinking")).toMatchObject({ ok: false, detail: "empty answer" });
    expect(judgeHebrewAnswer(capital, "לונדון")).toMatchObject({ ok: false, detail: "none of פריז / פאריז in the answer" });
    expect(stripThinking("<think>a</think> b <think>c")).toBe("b");
    expect(hebrewShare("שלום world")).toBeCloseTo(4 / 9);
  });

  it("the report counts the prompts and keeps the answers on one line", () => {
    const md = formatHebrewSmokeReport(
      [
        { id: "he-1", ok: true, detail: "100% Hebrew letters", answer: "פריז", ms: 1200 },
        { id: "he-2", ok: false, detail: "0% Hebrew letters (needs 60%)", answer: "a|b\nc", ms: 300 },
      ],
      { model: HEBREW_SMOKE_MODEL, url: "u", date: "2026-11-14", ms: 1500, digest: "sha256:d1" },
    );
    expect(md).toContain("**1/2 prompts** answered in Hebrew — FAILED.");
    expect(md).toContain("digest sha256:d1");
    expect(md).toContain("| he-2 | FAIL | 0.3 s | 0% Hebrew letters (needs 60%) | a\\|b c |");
  });
});

describe("scripts/real-tiny-model.mjs against a fake Ollama (digest pin, Hebrew smoke)", () => {
  const script = join(__dirname, "..", "..", "scripts", "real-tiny-model.mjs");
  let server: Server;
  let base = "";
  const chats: Array<{ model: string; think?: boolean; prompt: string }> = [];
  const answers: Record<string, string> = { "he-capital": "<think>Paris.</think>פריז", "he-sentence": "היום מעונן חלקית ונעים.", "he-sum": "חמש" };

  const start = () =>
    new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        let body = "";
        req.on("data", (c: Buffer) => (body += c.toString()));
        req.on("end", () => {
          res.setHeader("Content-Type", "application/json");
          if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: HEBREW_SMOKE_MODEL, digest: "d1ct4" }] }));
          if (req.url === "/api/chat") {
            const j = JSON.parse(body) as { model: string; think?: boolean; messages: Array<{ content: string }> };
            const prompt = j.messages[0].content;
            chats.push({ model: j.model, think: j.think, prompt });
            const item = HEBREW_SMOKE_PROMPTS.find((p) => p.prompt === prompt);
            return res.end(JSON.stringify({ message: { role: "assistant", content: answers[item?.id ?? ""] ?? "" } }));
          }
          res.statusCode = 404;
          res.end("{}");
        });
      });
      server.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  const run = (extra: string[], env: Record<string, string> = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string; out: string }>((resolve) => {
      const out = mkdtempSync(join(tmpdir(), "lumen-real-he-"));
      const p = spawn(process.execPath, [script, "--url", base, "--out", out, ...extra], { env: { PATH: dirname(process.execPath), ...env } });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      p.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      p.on("close", (status) => resolve({ status, stdout, stderr, out }));
    });

  it("--hebrew-smoke: every prompt answered in Hebrew → exit 0, a report with the digest", async () => {
    await start();
    try {
      const r = await run(["--hebrew-smoke"]);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`real-model: ${HEBREW_SMOKE_MODEL} digest sha256:d1ct4`);
      expect(r.stdout).toContain(`real-model: Hebrew smoke ${HEBREW_SMOKE_PROMPTS.length}/${HEBREW_SMOKE_PROMPTS.length}`);
      expect(chats.map((c) => c.model)).toEqual(HEBREW_SMOKE_PROMPTS.map(() => HEBREW_SMOKE_MODEL));
      expect(chats.every((c) => c.think === false)).toBe(true);
      const date = new Date().toISOString().slice(0, 10);
      const md = readFileSync(join(r.out, `real-hebrew-${date}-hf.co_dicta-il_DictaLM-3.0-1.7B-Thinking-GGUF.md`), "utf8");
      expect(md).toContain(`**${HEBREW_SMOKE_PROMPTS.length}/${HEBREW_SMOKE_PROMPTS.length} prompts** answered in Hebrew.`);
      expect(md).toContain("digest sha256:d1ct4");

      // An English answer fails the smoke test.
      answers["he-sentence"] = "Partly cloudy.";
      expect((await run(["--hebrew-smoke"])).status).toBe(1);

      // A pinned digest that is not the local build stops the run before any prompt.
      chats.length = 0;
      const pinned = await run(["--hebrew-smoke"], { LUMEN_REAL_MODEL_DIGEST: "sha256:0ther" });
      expect(pinned.status).toBe(1);
      expect(pinned.stderr).toContain("the pinned digest is sha256:0ther, but the local model is sha256:d1ct4");
      expect(chats).toEqual([]);
      expect((await run(["--hebrew-smoke", "--digest", "d1ct4"])).stdout).toContain("digest sha256:d1ct4");
    } finally {
      await new Promise((r) => server.close(r));
    }
  }, 60_000);

  it("--hebrew-smoke without Ollama: exit 0 and a 'skipped' report of its own", async () => {
    const out = mkdtempSync(join(tmpdir(), "lumen-real-he-"));
    const r = spawnSync(process.execPath, [script, "--hebrew-smoke", "--url", "http://127.0.0.1:9", "--out", out], { encoding: "utf8", env: { PATH: dirname(process.execPath) } });
    expect(r.status).toBe(0);
    expect(readFileSync(join(out, "real-hebrew-skipped.md"), "utf8")).toMatch(/^# Hebrew smoke test — skipped/);
  });
});
