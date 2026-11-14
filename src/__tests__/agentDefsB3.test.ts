import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import { registerExecutor, resetExecutors } from "../agents/executors";
import { runAgent, streamAgent, AgentRunError } from "../agents/runtime";
import { fakeExecutor, reply, sequence } from "./helpers/fakeExecutor";
import { writerAgent, templaterAgent, builderSpecAgent, builderFileAgent, checkGeneratedFile } from "../agents/defs";

beforeEach(() => {
  resetExecutors();
  localStorage.setItem("lumen.ai.cache", "off");
});

describe("writer / templater", () => {
  it("streams deltas through streamAgent", async () => {
    registerExecutor(
      fakeExecutor(async (req) => {
        req.onDelta?.("Hel");
        req.onDelta?.("lo");
        return reply("Hello");
      }),
    );
    const out: string[] = [];
    for await (const c of streamAgent(writerAgent, { text: "say hi" })) out.push(c);
    expect(out).toEqual(["Hel", "lo"]);
  });

  it("yields the whole answer once when the executor cannot stream", async () => {
    registerExecutor(fakeExecutor(sequence("Whole answer")));
    const out: string[] = [];
    for await (const c of streamAgent(writerAgent, { text: "x" })) out.push(c);
    expect(out).toEqual(["Whole answer"]);
  });

  it("throws AgentRunError on an empty answer, without retrying streamed text", async () => {
    const ex = fakeExecutor(sequence("   "));
    registerExecutor(ex);
    await expect((async () => {
      for await (const _c of streamAgent(templaterAgent, { text: "x", extra: { templateId: "t" } })) void _c;
    })()).rejects.toBeInstanceOf(AgentRunError);
    expect(ex.calls).toHaveLength(1);
    expect(writerAgent.maxRetries).toBe(0);
    expect(templaterAgent.maxRetries).toBe(0);
  });
});

describe("builder", () => {
  it("spec: schema-checked, unsafe paths rejected and retried", async () => {
    const bad = { name: "my-app", description: "d", features: ["f"], techStack: ["js"], fileStructure: ["../evil.js"] };
    const good = { ...bad, fileStructure: ["index.html", "app.js"] };
    const ex = fakeExecutor(sequence('{"name":"Bad Name"}', JSON.stringify(bad), JSON.stringify(good)));
    registerExecutor(ex);
    const run = await runAgent(builderSpecAgent, { text: "a todo app" });
    expect(run.status).toBe("ok");
    expect(run.output).toEqual(good);
    expect(ex.calls[2].messages[1].content).toContain("unsafe file paths");
  });

  it("file: checked by type", async () => {
    expect(checkGeneratedFile("a.json", "{nope").ok).toBe(false);
    expect(checkGeneratedFile("package.json", '{"version":"1"}').ok).toBe(false);
    expect(checkGeneratedFile("package.json", '{"name":"x"}')).toEqual({ ok: true });
    expect(checkGeneratedFile("index.html", "<div>hi</div>").ok).toBe(false);
    expect(checkGeneratedFile("index.html", "<!DOCTYPE html><html></html>")).toEqual({ ok: true });
    expect(checkGeneratedFile("a.js", "  ").ok).toBe(false);
    registerExecutor(fakeExecutor(sequence("```json\n{\"name\":\"x\"}\n```")));
    const run = await runAgent(builderFileAgent, { text: "make package.json", extra: { path: "package.json" } });
    expect(run.output).toBe('{"name":"x"}');
  });
});
