import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../agents/executors/ollama", async (orig) => ({
  ...(await orig<object>()),
  refreshOllama: vi.fn(async () => ({ models: [{ name: "qwen2.5:7b", params: 7, family: "qwen2" }] })),
}));
vi.mock("../ai/modelManager", async (orig) => ({
  ...(await orig<object>()),
  detectHardware: vi.fn(async () => ({ webgpu: true, f16: true, maxBufferMB: 2048, deviceMemoryGB: 8, cores: 8, mobile: false })),
}));

const confirm = vi.hoisted(() => ({ fn: vi.fn(async () => true) }));
vi.mock("../ui/PromptDialog", () => ({ uiConfirm: (...a: unknown[]) => confirm.fn(...(a as [])) }));

import { refreshOllama } from "../agents/executors/ollama";
import { pickExecutor, registerExecutor, resetExecutors, setPreferredExecutor, withPreference, preferredExecutor } from "../agents/executors";
import { AiSettingsPanel } from "../ui/AiSettingsPanel";
import { clearTrace, recordRun } from "../agents/trace";
import type { AgentRun } from "../agents/types";
import { fakeExecutor, sequence } from "./helpers/fakeExecutor";
import type { Executor } from "../agents/types";

function fake(id: Executor["id"], available: boolean): Executor {
  return { ...fakeExecutor(sequence("x")), id, available: async () => (available ? { available: true } : { available: false, reason: "offline" }) };
}

beforeEach(() => {
  localStorage.clear();
  resetExecutors();
});

describe("preferred executor", () => {
  it("moves the preference to the front only when the agent allows it", () => {
    expect(withPreference(["ollama", "webllm", "chat"], "chat")).toEqual(["chat", "ollama", "webllm"]);
    expect(withPreference(["ollama", "chat"], "webllm")).toEqual(["ollama", "chat"]);
    expect(withPreference(["ollama", "chat"], null)).toEqual(["ollama", "chat"]);
  });

  it("pickExecutor honours the stored preference and falls back when it is unavailable", async () => {
    registerExecutor(fake("ollama", true));
    registerExecutor(fake("webllm", true));
    registerExecutor(fake("chat", true));
    setPreferredExecutor("webllm");
    expect(preferredExecutor()).toBe("webllm");
    expect((await pickExecutor()).executor?.id).toBe("webllm");
    registerExecutor(fake("webllm", false));
    expect((await pickExecutor()).executor?.id).toBe("ollama");
    setPreferredExecutor(null);
    expect(localStorage.getItem("lumen.ai.executor")).toBeNull();
  });
});

describe("AiSettingsPanel", () => {
  it("shows availability, hardware and installed models; writes the same keys the runtime reads", async () => {
    registerExecutor(fake("ollama", true));
    registerExecutor(fake("webllm", false));
    registerExecutor(fake("chat", false));
    render(<AiSettingsPanel open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("exec-status-ollama").textContent).toBe("Available"));
    expect(screen.getByTestId("exec-status-webllm").textContent).toContain("offline");
    await waitFor(() => expect(screen.getByText("Installed: qwen2.5:7b")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("hw-card").textContent).toContain("WebGPU ready"));

    fireEvent.click(screen.getByLabelText(/Local first/));
    await waitFor(() => expect(localStorage.getItem("lumen.ai.policy")).toBe("local-first"));
    fireEvent.click(screen.getByLabelText(/Model in the browser/));
    await waitFor(() => expect(localStorage.getItem("lumen.ai.executor")).toBe("webllm"));
    fireEvent.click(screen.getByLabelText(/^Automatic/));
    await waitFor(() => expect(localStorage.getItem("lumen.ai.executor")).toBeNull());

    const [ollamaUrl] = screen.getAllByPlaceholderText("http://localhost:11434");
    fireEvent.change(ollamaUrl, { target: { value: "http://127.0.0.1:11434" } });
    fireEvent.change(screen.getByPlaceholderText("http://localhost:8010/v2/check"), { target: { value: "http://localhost:8010/v2/check" } });
    for (const b of screen.getAllByText("Save")) fireEvent.click(b);
    await waitFor(() => expect(localStorage.getItem("lumen.ollama.baseUrl")).toBe("http://127.0.0.1:11434"));
    await waitFor(() => expect(localStorage.getItem("lumen.grammar.endpoint")).toBe("http://localhost:8010/v2/check"));
  });

  it("names a custom-licence Ollama model in the picker and confirms it before saving", async () => {
    vi.mocked(refreshOllama).mockResolvedValue({ models: [{ name: "qwen2.5:7b", params: 7, family: "qwen2" }, { name: "llama3.1:8b", params: 8, family: "llama" }] } as never);
    registerExecutor(fake("ollama", true));
    const { container } = render(<AiSettingsPanel open onClose={() => {}} />);
    await waitFor(() => expect(container.querySelector('option[value="llama3.1:8b"]')?.getAttribute("label")).toBe("llama3.1:8b · Llama 3.1 Community License"));
    expect(container.querySelector('option[value="qwen2.5:7b"]')?.getAttribute("label")).toBeNull();
    const model = screen.getByPlaceholderText("qwen2.5:7b");
    fireEvent.change(model, { target: { value: "llama3.1:8b" } });
    confirm.fn.mockResolvedValueOnce(false);
    fireEvent.click(screen.getAllByText("Save")[0]);
    await waitFor(() => expect(confirm.fn).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem("lumen.ollama.model")).toBeNull();
    confirm.fn.mockResolvedValueOnce(true);
    fireEvent.click(screen.getAllByText("Save")[0]);
    await waitFor(() => expect(localStorage.getItem("lumen.ollama.model")).toBe("llama3.1:8b"));
    vi.mocked(refreshOllama).mockResolvedValue({ models: [{ name: "qwen2.5:7b", params: 7, family: "qwen2" }] } as never);
  });

  it("buttons hand off to the existing commands", async () => {
    const ids: string[] = [];
    const on = (e: Event) => ids.push((e as CustomEvent).detail.id);
    window.addEventListener("lumen-run-command", on);
    const onClose = vi.fn();
    render(<AiSettingsPanel open onClose={onClose} />);
    fireEvent.click(await screen.findByText("AI: Recent Agent Runs"));
    expect(ids).toEqual(["ai.trace"]);
    expect(onClose).toHaveBeenCalled();
    window.removeEventListener("lumen-run-command", on);
  });

  it("recent runs: the ten newest, newest first", async () => {
    await clearTrace();
    for (let i = 0; i < 12; i++) {
      await recordRun({ id: `r${i}`, agentId: `agent${i}`, executor: "ollama", status: "ok", startedAt: i, endedAt: i, attempts: 1, steps: [], suggestions: [], tokens: { input: 0, output: 0, estimated: true } } as unknown as AgentRun);
    }
    render(<AiSettingsPanel open onClose={() => {}} />);
    const section = (await screen.findByText("Recent agent runs")).closest("section")!;
    await waitFor(() => expect(section.querySelectorAll("li").length).toBe(10));
    const items = [...section.querySelectorAll("li strong")].map((el) => el.textContent);
    expect(items).toEqual(["agent11", "agent10", "agent9", "agent8", "agent7", "agent6", "agent5", "agent4", "agent3", "agent2"]);
    await clearTrace();
  });

  it("does not store a research address the browser can't use", async () => {
    render(<AiSettingsPanel open onClose={() => {}} />);
    fireEvent.change(await screen.findByPlaceholderText("http://localhost:8787"), { target: { value: "not a url" } });
    for (const b of screen.getAllByText("Save")) fireEvent.click(b);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("not a url"));
    expect(localStorage.getItem("lumen.research.endpoint")).toBeNull();
  });
});
