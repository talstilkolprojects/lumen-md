/**
 * Plan 0.15 — agents/runtime cases that its other suites leave open: the
 * input key a retry patch is bound to (golden FNV-1a values), the
 * same-script check on Hebrew input, the language instruction in the system
 * prompt, and the error runAgentOrThrow raises. Uses a registered fake
 * executor only; no module mocks.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition, Executor, ExecutorRequest, ExecutorResponse } from "../agents/types";
import { AgentRunError, DEFAULT_MAX_STEPS, inputKeyOf, runAgent, runAgentOrThrow, sameScript } from "../agents/runtime";
import { registerExecutor, resetExecutors } from "../agents/executors";

const reply = (content: string): ExecutorResponse => ({ content, toolCalls: [], model: "fake", usage: { inputTokens: 1, outputTokens: 1, estimated: true } });

function fake(script: (req: ExecutorRequest, n: number) => ExecutorResponse): Executor & { calls: ExecutorRequest[] } {
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
  };
}

const HE_LONG = "זה טקסט ארוך בעברית שכתוב כדי לבדוק את השפה של התשובה";
const EN_LONG = "This is a long English answer that has far more than twenty letters in it";

describe("agents/runtime (mutation cases)", () => {
  beforeEach(() => resetExecutors());
  afterEach(() => resetExecutors());

  it("keys an input with FNV-1a of the agent id and its user text", () => {
    const def: AgentDefinition = { id: "tagger", description: "", system: "s", user: (i) => i.text ?? "" };
    expect(inputKeyOf(def, { text: "שלום עולם" })).toBe("77577s-g");
    const throwing: AgentDefinition = { id: "tagger", description: "", system: "s", user: () => { throw new Error("x"); } };
    expect(inputKeyOf(throwing, { text: "fallback" })).toBe("1bkl8hr-f");
    expect(inputKeyOf({ ...throwing, id: "x" }, {})).toBe("1qjbdl1-2");
    expect(inputKeyOf(def, { text: "a" })).not.toBe(inputKeyOf(def, { text: "b" }));
  });

  it("checks the script of an answer to Hebrew input", () => {
    expect(sameScript("hello there", EN_LONG)).toEqual({ ok: true });
    expect(sameScript(HE_LONG, "short ok")).toEqual({ ok: true });
    expect(sameScript(HE_LONG, HE_LONG)).toEqual({ ok: true });
    const bad = sameScript(HE_LONG, EN_LONG);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.reason).toBe("the input is Hebrew but the answer is 0% Hebrew");
      expect(bad.hint).toContain("Hebrew");
    }
    // Code, tags and JSON keys are not prose.
    expect(sameScript(HE_LONG, "```js\nconst somethingVeryLongInEnglish = 1;\n``` `inlineCodeIsNotProse` <span>tag</span>")).toEqual({ ok: true });
    expect(sameScript(HE_LONG, { summaryInEnglishKey: "שלום", anotherVeryLongEnglishKey: "עולם" })).toEqual({ ok: true });
    // 2 Hebrew letters of 13 + 10 = 8.7%: too little; 4 of 24 = 16.7%: enough.
    expect(sameScript(HE_LONG, "שלabcdefghij klmnopqrstu").ok).toBe(false);
    expect(sameScript(HE_LONG, "שלוםabcdefghij klmnopqrst").ok).toBe(true);
    const twelve = sameScript(HE_LONG, "שלab cdefghijklmnopqrstuvw");
    expect(twelve.ok ? "" : twelve.reason).toBe("the input is Hebrew but the answer is 8% Hebrew");
  });

  it("tells the model which language to answer in", async () => {
    const ex = fake(() => reply("ok"));
    registerExecutor(ex);
    const def: AgentDefinition = { id: "t", description: "", system: "SYS", user: (i) => i.text ?? "" };
    await runAgent(def, { text: HE_LONG });
    await runAgent(def, { text: "plain English" });
    await runAgent({ ...def, language: "any" }, { text: HE_LONG });
    await runAgent({ ...def, language: () => "any" }, { text: HE_LONG });
    const sys = ex.calls.map((c) => c.messages[0].content);
    expect(sys[0]).toContain("The user's text is in Hebrew");
    expect(sys[1]).toContain("same language as the user's text");
    expect(sys[1]).not.toContain("in Hebrew");
    expect(sys[2]).toBe("SYS");
    expect(sys[3]).toBe("SYS");
  });

  it("raises the run's error from runAgentOrThrow, and returns the output when it succeeds", async () => {
    registerExecutor(fake(() => reply("not json")));
    const def: AgentDefinition<{ text: string }, { a: number }> = {
      id: "j",
      description: "",
      system: "s",
      user: (i) => i.text,
      outputSchema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] },
    };
    const err = await runAgentOrThrow(def, { text: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRunError);
    expect((err as AgentRunError).message.length).toBeGreaterThan(0);
    resetExecutors();
    registerExecutor(fake(() => reply('{"a":1}')));
    expect(await runAgentOrThrow(def, { text: "x" })).toEqual({ a: 1 });
    expect(DEFAULT_MAX_STEPS).toBe(8);
  });
});
