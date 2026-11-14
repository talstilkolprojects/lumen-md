/**
 * Plan W2.18 — "draw me": the local model's Mermaid is checked (editable
 * type, real parser) and a bad answer goes back with the error; the agent
 * runs only on this device's executors, never the cloud chat, even when
 * one is forced.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: true, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import { registerExecutor, resetExecutors } from "../agents/executors";
import { runAgent } from "../agents/runtime";
import { fakeExecutor, sequence } from "./helpers/fakeExecutor";
import { drawAgent, drawDiagram, editableValidator, LOCAL_EXECUTORS } from "../canvas/drawAgent";

beforeEach(() => {
  resetExecutors();
  localStorage.setItem("lumen.ai.cache", "off");
});

describe("draw me (W2.18)", () => {
  it("returns the clean diagram from a fenced answer", async () => {
    const ex = fakeExecutor(sequence('הנה:\n```mermaid\nflowchart TD\n  A["בקשה"] --> B["אישור"]\n```'));
    registerExecutor(ex);
    const r = await drawDiagram("תהליך בקשה ואישור");
    expect(r).toEqual({ ok: true, code: 'flowchart TD\n  A["בקשה"] --> B["אישור"]', executor: "ollama" });
    expect(String(ex.calls[0].messages[0].content)).toContain("Hebrew stays Hebrew");
  });

  it("a non-editable type or a syntax error goes back to the model with the reason", async () => {
    const ex = fakeExecutor(sequence("mindmap\n  root((x))", "flowchart TD\n  A[שלום --> B", 'flowchart TD\n  A["שלום"] --> B["עולם"]'));
    registerExecutor(ex);
    const run = await runAgent(drawAgent, { text: "x" });
    expect(run.status).toBe("ok");
    expect(ex.calls).toHaveLength(3);
    expect(JSON.stringify(ex.calls[1].messages)).toContain("can't be edited on the canvas");
  });

  it("runs only on local executors: with only the cloud chat there is no executor, even if forced", async () => {
    expect(LOCAL_EXECUTORS).toEqual(["ollama", "webllm"]);
    const cloud = fakeExecutor(sequence("flowchart TD\n  A --> B"), { id: "chat" });
    registerExecutor(cloud);
    const run = await runAgent(drawAgent, { text: "x" }, { executor: "chat" });
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("no-executor");
    expect(cloud.calls).toHaveLength(0);
    expect(await drawDiagram("x")).toMatchObject({ ok: false, code: "no-local-model" });
  });

  it("the editable-type check on its own", () => {
    expect(editableValidator.check("sequenceDiagram\n  A->>B: x", { text: "" })).toEqual({ ok: true });
    expect(editableValidator.check("gantt\n  title x", { text: "" })).toMatchObject({ ok: false });
    expect(editableValidator.check("", { text: "" })).toMatchObject({ ok: false, reason: "no Mermaid diagram in the answer" });
  });
});
