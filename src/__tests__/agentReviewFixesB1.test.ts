import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const quota = vi.hoisted(() => ({ allowed: true, consumed: 0, dispatched: 0 }));
vi.mock("../billing/aiQuota", () => ({
  chargeAiCommandDispatch: vi.fn(() => {
    quota.dispatched++;
  }),
  consumeAiPrompt: vi.fn(() => {
    quota.consumed++;
    return quota.allowed;
  }),
  aiQuotaStatus: () => ({ allowed: quota.allowed, limit: 10 }),
  AiQuotaExceededError: class extends Error {},
}));
const chatCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../ai/llm", async (orig) => ({
  ...(await orig<object>()),
  getActiveProvider: () => "openai",
  chat: vi.fn(async (_m: unknown, opts: Record<string, unknown>) => {
    chatCalls.push(opts);
    (opts.chargeHook as (() => void) | undefined)?.();
    (opts.onRoute as ((p: string, m: string) => void) | undefined)?.("ollama", "qwen2.5:7b");
    return "feat: ok";
  }),
}));

import { registerExecutor, resetExecutors } from "../agents/executors";
import { chatExecutor } from "../agents/executors/chatExecutor";
import { runAgent } from "../agents/runtime";
import { checkTaskList, cleanSubject, committerAgent, taggerAgent, CONVENTIONAL } from "../agents/defs";
import { fakeExecutor, sequence } from "./helpers/fakeExecutor";
import type { AgentDefinition } from "../agents/types";

const agent: AgentDefinition = { id: "t", description: "", system: "s", user: (i) => i.text ?? "", validators: [{ name: "v", check: (o) => (o === "good" ? { ok: true } : { ok: false, reason: "bad" }) }] };

beforeEach(() => {
  resetExecutors();
  quota.allowed = true;
  quota.consumed = 0;
  quota.dispatched = 0;
  chatCalls.length = 0;
  localStorage.setItem("lumen.ai.cache", "off");
});

describe("quota is charged at dispatch, once per run", () => {
  it("a run cancelled before the first request spends nothing", async () => {
    registerExecutor(fakeExecutor(sequence("good")));
    const ac = new AbortController();
    ac.abort();
    const run = await runAgent(agent, { text: "x" }, { ownPrompt: true, signal: ac.signal });
    expect(run.status).toBe("aborted");
    expect(quota.consumed).toBe(0);
  });

  it("native executors are charged once across retries", async () => {
    registerExecutor(fakeExecutor(sequence("bad", "bad", "good")));
    const run = await runAgent(agent, { text: "x" }, { ownPrompt: true });
    expect(run.status).toBe("ok");
    expect(run.attempts).toBe(3);
    expect(quota.consumed).toBe(1);
  });

  it("the chat adapter is charged only when chat() dispatches (a local NO_KEY / rate-limit failure spends nothing)", async () => {
    registerExecutor(fakeExecutor(() => Promise.reject(new Error("NO_KEY")), { id: "chat" }));
    const run = await runAgent({ ...agent, executorPreference: ["chat"], maxRetries: 0 }, { text: "x" }, { ownPrompt: true });
    expect(run.status).toBe("failed");
    expect(quota.consumed).toBe(0);
  });

  it("at the monthly limit nothing goes out", async () => {
    quota.allowed = false;
    const ex = fakeExecutor(sequence("good"));
    registerExecutor(ex);
    const run = await runAgent(agent, { text: "x" }, { ownPrompt: true });
    expect(run.errorCode).toBe("quota");
    expect(ex.calls).toHaveLength(0);
  });
});

describe("chat adapter routing", () => {
  it("does not pin the resolved model (light routing and local reroute keep working), passes the charge hook, reports the answering model", async () => {
    expect(chatExecutor.modelFor("tiny")).toBe("gpt-4o-mini");
    let charged = 0;
    const res = await chatExecutor.chat({ messages: [{ role: "user", content: "x" }], model: chatExecutor.modelFor("small"), tier: "small", charge: () => charged++ });
    expect(chatCalls[0].model).toBeUndefined();
    expect(chatCalls[0].tier).toBe("light");
    expect(chatCalls[0].prepaid).toBe(false);
    expect(charged).toBe(1);
    expect(res.model).toBe("qwen2.5:7b");
    await chatExecutor.chat({ messages: [{ role: "user", content: "x" }], model: "gpt-4.1", tier: "small" });
    expect(chatCalls[1].model).toBe("gpt-4.1");
    expect(chatCalls[1].prepaid).toBe(true);
  });
});

describe("cache hits keep the executor in the trace", () => {
  it("records the executor that keyed the cache", async () => {
    localStorage.removeItem("lumen.ai.cache");
    registerExecutor(fakeExecutor(sequence('{"tags": ["a-tag"]}')));
    await runAgent(taggerAgent, { text: "cache me", extra: { existing: [] } });
    const second = await runAgent(taggerAgent, { text: "cache me", extra: { existing: [] } });
    expect(second.steps.map((s) => s.kind)).toEqual(["tool", "cache"]); // its list_tags context call, then the hit
    expect(second.executor).toBe("ollama");
  });
});

describe("cached answers pass the language check", () => {
  it("an English answer cached for Hebrew input (before the check) is not reused", async () => {
    localStorage.removeItem("lumen.ai.cache");
    const he = "פגישת צוות: דנה תשלח את ההצעה ללקוח עד יום חמישי, יואב יבדוק את הבאג.";
    const english = "Dana will send the proposal to the client by Thursday and Yoav checks the bug.";
    const base: AgentDefinition = { id: "lang-cache", description: "", system: "s", user: (i) => i.text ?? "", cache: true };
    const ex = fakeExecutor(sequence(english, "דנה תשלח את ההצעה ללקוח עד יום חמישי"));
    registerExecutor(ex);
    // An entry written without the check (as before it existed).
    expect((await runAgent({ ...base, language: "any" }, { text: he })).status).toBe("ok");
    const run = await runAgent(base, { text: he });
    expect(run.steps.map((s) => s.kind)).not.toContain("cache");
    expect(ex.calls.length).toBe(2);
    expect(run.output).toContain("דנה");
  });
});

describe("stricter text validators", () => {
  it("tasker: every non-blank line is an unchecked task", () => {
    expect(checkTaskList("- [ ] a (Dana)\n\n* [ ] b").ok).toBe(true);
    expect(checkTaskList("Here are the items:\n- [ ] a").ok).toBe(false);
    expect(checkTaskList("- [x] done").ok).toBe(false);
    expect(checkTaskList("").ok).toBe(false);
  });

  it("committer: skips a preamble, requires a conventional type, drops the trailing period", async () => {
    expect(cleanSubject("Here is the commit message:\n\nfeat(agents): add runtime.")).toBe("feat(agents): add runtime");
    expect(CONVENTIONAL.test("Here is the commit message:")).toBe(false);
    const v = committerAgent.validators![0];
    expect((await v.check("Here is the commit message:", { text: "" })).ok).toBe(false);
    expect((await v.check("fix: handle empty diff", { text: "" })).ok).toBe(true);
  });
});
