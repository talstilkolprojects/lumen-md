/**
 * agents/runtime: the rules its other suites leave unpinned (train 5's
 * mutation run left runtime.ts at 41.3 %). Each case asserts what a run
 * does — the tool results the model reads next, the steps, the critic's
 * suggestions, the output — through a registered fake executor and real
 * modules only (no module mocks).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition, AgentTool, Executor, ExecutorId, ExecutorRequest, ExecutorResponse } from "../agents/types";
import { runAgent, runAgentOrThrow, sameLanguage, sameScript } from "../agents/runtime";
import { registerExecutor, resetExecutors } from "../agents/executors";
import { setModelCritic } from "../agents/critic";
import { onAgentAnswer } from "../agents/suggestions";
import { clearStagedChanges, listStagedChanges } from "../agents/staging";
import { clearAiOutputs, recentAiTexts } from "../ai/authorship";

const reply = (content: string): ExecutorResponse => ({ content, toolCalls: [], model: "fake", usage: { inputTokens: 1, outputTokens: 1, estimated: true } });
type Script = (req: ExecutorRequest, n: number) => ExecutorResponse | Promise<ExecutorResponse>;

function fake(script: Script, over: Partial<Executor> & { id?: ExecutorId } = {}): Executor & { calls: ExecutorRequest[] } {
  const calls: ExecutorRequest[] = [];
  return {
    id: "ollama",
    label: "fake",
    calls,
    available: async () => ({ available: true }),
    supportsTools: () => false,
    supportsSchema: () => false,
    modelFor: (tier) => `fake-${tier}`,
    async chat(req) {
      calls.push(req);
      return script(req, calls.length);
    },
    ...over,
  };
}

/** The tool-result messages the model was given in a request. */
const toolBodies = (req: ExecutorRequest) => req.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content) as { tool: string; result?: unknown; error?: string });

const tool = (name: string, run: AgentTool["run"], extra: Partial<AgentTool> = {}): AgentTool => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
  scope: "read",
  run,
  ...extra,
});

const base: AgentDefinition = { id: "rules", description: "", system: "SYS", user: (i) => i.text ?? "", language: "any" };
const LONG_EN = "This sentence is plain English prose for the runtime test. ".repeat(120); // 7,080 chars
const FR = "Bonjour, je voudrais savoir comment fonctionne cette application et pourquoi elle est si lente aujourd'hui.";
const EN = "Hello, I would like to know how this application works and why it is so slow today for everyone here.";

describe("agents/runtime rules", () => {
  beforeEach(() => {
    resetExecutors();
    clearStagedChanges();
    clearAiOutputs();
    setModelCritic(null);
  });
  afterEach(() => {
    resetExecutors();
    setModelCritic(null);
  });

  it("records a model step whole up to 200 characters, with its real duration", async () => {
    const answer = "x".repeat(200);
    registerExecutor(fake(() => reply(answer)));
    const run = await runAgent(base, { text: "q" });
    const model = run.steps.find((s) => s.kind === "model")!;
    expect(model.detail).toBe(answer);
    expect(model.ms).toBeGreaterThanOrEqual(0);
    expect(model.ms).toBeLessThan(60_000);
    resetExecutors();
    registerExecutor(fake(() => reply("y".repeat(201))));
    const longer = await runAgent(base, { text: "q" });
    expect(longer.steps.find((s) => s.kind === "model")!.detail).toBe(`${"y".repeat(200)}… [1 more chars]`);
  });

  it("marks an answer as AI output only when the run succeeds", async () => {
    registerExecutor(fake(() => reply("the distinctive answer text")));
    await runAgent(base, { text: "q" });
    expect(recentAiTexts()).toContain("the distinctive answer text");
  });

  it("taints the run with the sources a tool names, and only then", async () => {
    const web = tool("fetch_page", async () => ({ text: "page" }), { untrusted: async () => ["web:example.org"] });
    const own = tool("read_note", async () => ({ text: "mine" }));
    registerExecutor(fake(() => reply("done")));
    const tainted = await runAgent({ ...base, tools: [web], context: () => [{ tool: "fetch_page" }] }, { text: "q" });
    expect(tainted.untrusted).toEqual(["web:example.org"]);
    const clean = await runAgent({ ...base, tools: [own], context: () => [{ tool: "read_note" }] }, { text: "q" });
    expect(clean.untrusted).toBeUndefined();
  });

  it("delimits untrusted context results and passes trusted ones as they are", async () => {
    const web = tool("fetch_page", async () => ({ text: "page" }), { untrusted: async () => ["web:example.org"] });
    const own = tool("read_note", async () => ({ text: "mine" }));
    const ex = fake(() => reply("done"));
    registerExecutor(ex);
    const run = await runAgent({ ...base, tools: [web, own], context: () => [{ tool: "fetch_page" }, { tool: "read_note" }] }, { text: "q" });
    const [pageMsg, noteMsg] = ex.calls[0].messages.filter((m) => m.role === "tool");
    expect(pageMsg.content).toContain("web:example.org");
    expect(() => JSON.parse(pageMsg.content)).toThrow();
    expect(JSON.parse(noteMsg.content)).toEqual({ tool: "read_note", result: { text: "mine" } });
    const ctxSteps = run.steps.filter((s) => s.kind === "tool");
    expect(ctxSteps[0].detail).toContain("untrusted: web:example.org");
    expect(ctxSteps[1].detail).not.toContain("untrusted");
  });

  it("tells the model a privacy block apart from a plain tool failure", async () => {
    const blocked = tool("web_search", async () => {
      const e = new Error("no consent for the web");
      e.name = "PrivacyBlockedError";
      throw e;
    });
    const broken = tool("broken", async () => {
      throw new Error("boom");
    });
    const ex = fake(() => reply("done"));
    registerExecutor(ex);
    await runAgent({ ...base, tools: [blocked, broken], context: () => [{ tool: "web_search" }, { tool: "broken" }] }, { text: "q" });
    const [b, p] = toolBodies(ex.calls[0]);
    expect(b.error).toBe("blocked: no consent for the web. Answer without the web, or tell the user that web research needs their consent.");
    expect(p.error).toBe("boom");
  });

  it("gives tools the caller's selection over the input's, even when it is empty", async () => {
    const peek = tool("peek", async (_a, ctx) => ({ selection: ctx.selection ?? null }));
    const ex = fake(() => reply("done"));
    registerExecutor(ex);
    await runAgent({ ...base, tools: [peek], context: () => [{ tool: "peek" }] }, { text: "q", selection: "from input" }, { selection: "" });
    expect(toolBodies(ex.calls[0])[0].result).toEqual({ selection: "" });
  });

  it("stages a write in a tainted run only when the user approves it", async () => {
    const write = tool(
      "write_file",
      async (_a, ctx) => ctx.stage!({ kind: "file", path: "a.md", before: null, after: "x", summary: "s" }),
      { scope: "write" },
    );
    const def: AgentDefinition = { ...base, tools: [write], context: () => [{ tool: "write_file" }] };
    const asked: string[] = [];
    const ex = fake(() => reply("done"));
    registerExecutor(ex);
    const denied = await runAgent(def, { text: "q" }, { grants: ["write"], untrusted: ["web:evil.example"], consentUntrusted: (r) => (asked.push(r.tool), false) });
    expect(toolBodies(ex.calls[0])[0].error).toMatch(/^denied: The user did not approve this call/);
    expect(denied.staged).toBeUndefined();
    expect(listStagedChanges({ runId: denied.id })).toHaveLength(0);
    const approved = await runAgent(def, { text: "q" }, { grants: ["write"], untrusted: ["web:evil.example"], consentUntrusted: (r) => (asked.push(r.tool), true) });
    expect(toolBodies(ex.calls[1])[0].error).toBeUndefined();
    expect(approved.staged).toHaveLength(1);
    expect(listStagedChanges({ runId: approved.id })).toHaveLength(1);
    expect(asked).toEqual(["write_file", "write_file"]);
  });

  it("asks for Hebrew when exactly half the input's letters are Hebrew", async () => {
    const ex = fake(() => reply("ok"));
    registerExecutor(ex);
    await runAgent({ ...base, language: "input" }, { text: "שלom" });
    expect(ex.calls[0].messages[0].content).toContain("The user's text is in Hebrew.");
  });

  it("accepts an answer to Hebrew input that is exactly 15% Hebrew", () => {
    const he = "זה טקסט ארוך בעברית שכתוב כדי לבדוק את השפה של התשובה";
    expect(sameScript(he, "שלו abcdefghijklmnopq")).toEqual({ ok: true });
    expect(sameScript(he, "של abcdefghijklmnopqr").ok).toBe(false);
  });

  it("rejects an answer in another language of the same script, not one in another script", async () => {
    expect(await sameLanguage(FR, EN)).toEqual({ ok: false, reason: "the input is French but the answer is English", hint: "Answer in French, the language of the user's text." });
    expect(await sameLanguage(FR, FR)).toEqual({ ok: true });
    expect(await sameLanguage("Здравствуйте, я хотел бы узнать, как работает это приложение и почему оно такое медленное.", EN)).toEqual({ ok: true });
  });

  it("runs a split document part by part and announces only the whole answer", async () => {
    const answers: string[] = [];
    const off = onAgentAnswer((e) => answers.push(e.run.id));
    const ex = fake((req) => reply(`answer to ${req.messages[1].content.slice(0, 6)}`));
    registerExecutor(ex);
    const text = "first part.\n\nsecond part.";
    const run = await runAgent({ ...base, splittable: true }, { text }, { patch: { split: 12 } });
    off();
    expect(run.status).toBe("ok");
    expect(run.output).toBe("answer to first\n\nanswer to second");
    expect(run.steps.map((s) => s.label)).toEqual(["part 1/2", "part 2/2"]);
    expect(answers).toEqual([run.id]);
  });

  it("fails a split run when a part fails, as failed and not aborted", async () => {
    registerExecutor(fake((_req, n) => reply(n === 1 ? "fine" : "")));
    const run = await runAgent({ ...base, splittable: true, maxRetries: 0 }, { text: "first part.\n\nsecond part." }, { patch: { split: 12 } });
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("empty");
    expect(run.error).toMatch(/^part 2\/2: /);
  });

  it("offers to split a long input on every kind of failure, counting the selection too", async () => {
    const def: AgentDefinition = { ...base, splittable: true, maxRetries: 0 };
    const ids = (r: { suggestions: { id: string }[] }) => r.suggestions.map((s) => s.id);
    registerExecutor(fake(() => reply("")));
    expect(ids(await runAgent(def, { text: LONG_EN }))).toContain("split-input");
    // 4,200 + 2,400 = 6,600 characters: a long input (> 6,000), longer than a part (> 4,000).
    expect(ids(await runAgent(def, { text: "t".repeat(4200), selection: "s".repeat(2400) }))).toContain("split-input");
    resetExecutors();
    const loop = tool("loop", async () => ({ again: true }));
    registerExecutor(fake(() => reply('{"tool": "loop", "args": {}}')));
    const looping = await runAgent({ ...def, tools: [loop], maxSteps: 1 }, { text: LONG_EN });
    expect(looping.error).toBe("no final answer after 1 steps");
    expect(ids(looping)).toContain("split-input");
    resetExecutors();
    registerExecutor(fake(() => reply("an answer")));
    const rejected = await runAgent({ ...def, validators: [{ name: "never", check: () => ({ ok: false, reason: "no" }) }] }, { text: LONG_EN });
    expect(rejected.errorCode).toBe("validation");
    expect(ids(rejected)).toContain("split-input");
  });

  it("lists each skipped executor's reason, an empty one as given", async () => {
    registerExecutor(fake(() => reply("x"), { available: async () => ({ available: false, reason: "" as never }) }));
    const run = await runAgent(base, { text: "q" }, { executor: "ollama" });
    expect(run.errorCode).toBe("no-executor");
    expect(run.steps[0].detail).toBe("ollama: ");
  });

  it("switches to the executor a patch names, with the model it pins", async () => {
    const first = fake(() => reply("from ollama"));
    const second = fake(() => reply("from webllm"), { id: "webllm" });
    registerExecutor(first);
    registerExecutor(second);
    const run = await runAgent(base, { text: "q" }, { patch: { executor: "webllm", model: "" } });
    expect(run.executor).toBe("webllm");
    expect(run.output).toBe("from webllm");
    expect(first.calls).toHaveLength(0);
    expect(second.calls[0].model).toBe("");
  });

  it("holds a small cloud model's tool turns to the protocol schema instead of native tools", async () => {
    const ex = fake(() => reply('{"final": "ok"}'), { id: "chat", supportsSchema: () => true, supportsTools: () => true });
    registerExecutor(ex);
    const run = await runAgent({ ...base, tier: "small", tools: [tool("t", async () => 1)] }, { text: "q" }, { executor: "chat" });
    expect(run.output).toBe("ok");
    expect(ex.calls[0].tools).toBeUndefined();
    expect(ex.calls[0].schema).toBeDefined();
  });

  it("gives an invalid tool call one retry, and asks the user after a second in a row", async () => {
    const need = tool("need", async (a) => a, { parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } });
    const def: AgentDefinition = { ...base, tools: [need] };
    registerExecutor(fake((_r, n) => reply(n === 1 ? '{"tool": "need", "args": {}}' : '{"final": "recovered"}')));
    const once = await runAgent(def, { text: "q" });
    expect(once.status).toBe("ok");
    expect(once.output).toBe("recovered");
    resetExecutors();
    registerExecutor(fake(() => reply('{"tool": "need", "args": {}}')));
    const twice = await runAgent(def, { text: "q" });
    expect(twice.errorCode).toBe("tool-args");
    expect(twice.suggestions.map((s) => s.id)).toEqual(["clarify-tool"]);
  });

  it("streams deltas only for a streaming agent", async () => {
    const ex = fake(() => reply("ok"));
    registerExecutor(ex);
    await runAgent(base, { text: "q" }, { onDelta: () => undefined });
    await runAgent({ ...base, streaming: true }, { text: "q" }, { onDelta: () => undefined });
    expect(ex.calls[0].onDelta).toBeUndefined();
    expect(ex.calls[1].onDelta).toBeTypeOf("function");
  });

  it("records a failing model call as a failed step", async () => {
    registerExecutor(
      fake(() => {
        throw new Error("kaput");
      }),
    );
    const run = await runAgent({ ...base, maxRetries: 0 }, { text: "q" });
    expect(run.status).toBe("failed");
    expect(run.steps[0]).toMatchObject({ kind: "model", label: "ollama", ok: false, detail: "kaput" });
  });

  it("keeps a parser's empty error message as the run's error", async () => {
    registerExecutor(fake(() => reply("anything")));
    const def: AgentDefinition = { ...base, maxRetries: 0, parse: () => { throw new Error(""); } };
    const run = await runAgent(def, { text: "q" });
    expect(run.errorCode).toBe("parse");
    expect(run.steps.find((s) => s.kind === "validate")!.detail).toBe("");
    const err = await runAgentOrThrow(def, { text: "q" }).catch((e: Error) => e);
    expect((err as Error).message).toBe("");
  });

  it("records the critic and the retry it asked for, at no cost", async () => {
    registerExecutor(fake((_r, n) => reply(n === 1 ? "" : "second try")));
    const run = await runAgent({ ...base, maxRetries: 1 }, { text: "q" });
    expect(run.output).toBe("second try");
    const [critic, retry] = run.steps.filter((s) => s.kind === "critic" || s.kind === "retry");
    expect(critic).toMatchObject({ kind: "critic", ms: 0, ok: true, detail: "empty answer" });
    expect(retry).toMatchObject({ kind: "retry", ms: 0, ok: true, label: "attempt 2" });
  });

  it("gives the model critic's own retry one attempt past the limit", async () => {
    setModelCritic(async () => ({ retry: { promptSuffix: "say it plainly" }, suggestions: [], diagnosis: "model" }));
    const ex = fake((_r, n) => reply(n === 1 ? "" : "plain"));
    registerExecutor(ex);
    const run = await runAgent({ ...base, maxRetries: 0 }, { text: "q" });
    expect(run.output).toBe("plain");
    expect(run.steps.find((s) => s.kind === "retry")).toMatchObject({ ok: true, label: "attempt 2 (model critic)", detail: "say it plainly" });
    expect(ex.calls[1].messages[1].content).toBe("q\n\nsay it plainly");
  });
});
