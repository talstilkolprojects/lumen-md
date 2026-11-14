import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const consumed = vi.hoisted(() => ({ n: 0 }));
vi.mock("../billing/aiQuota", () => ({
  chargeAiCommandDispatch: vi.fn(),
  consumeAiPrompt: vi.fn(() => {
    consumed.n++;
    return true;
  }),
  aiQuotaStatus: () => ({ allowed: true, limit: Infinity }),
  AiQuotaExceededError: class extends Error {},
}));

import { registerExecutor, resetExecutors } from "../agents/executors";
import { streamAgent } from "../agents/runtime";
import { checkGeneratedFile, templaterAgent } from "../agents/defs";
import { fakeExecutor, sequence } from "./helpers/fakeExecutor";

beforeEach(() => {
  resetExecutors();
  consumed.n = 0;
});

describe("B3 review fixes", () => {
  it("the templater sends the whole document, however long", () => {
    const doc = "x".repeat(40_000) + "END";
    expect(templaterAgent.user({ text: doc, extra: { templateId: "summarize" } })).toContain("END");
  });

  it("a generated .json file must parse as a whole", () => {
    expect(checkGeneratedFile("data.json", '{"name":"x"}').ok).toBe(true);
    expect(checkGeneratedFile("data.json", 'Here is the file: {"name":"x"}').ok).toBe(false);
    expect(checkGeneratedFile("package.json", '{"version":"1"}').ok).toBe(false);
  });

  it("streamAgent with an already-aborted signal sends nothing and charges nothing", async () => {
    const ex = fakeExecutor(sequence("text"));
    registerExecutor(ex);
    const ac = new AbortController();
    ac.abort();
    const chunks: string[] = [];
    const err = await (async () => {
      for await (const c of streamAgent(templaterAgent, { text: "doc", extra: { templateId: "t" } }, { signal: ac.signal, ownPrompt: true })) chunks.push(c);
    })().catch((e) => e);
    expect(err).toBeTruthy();
    expect(ex.calls).toHaveLength(0);
    expect(consumed.n).toBe(0);
  });
});
