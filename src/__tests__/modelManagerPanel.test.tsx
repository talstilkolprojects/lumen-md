/**
 * Plan 5.7 — the model manager in the AI settings: an Ollama pull from the
 * panel with progress (a fake fetch streaming /api/pull NDJSON), and the AI
 * mode in the panel changing the local model of the next agent run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));
vi.mock("../agents/executors/ollama", async (orig) => ({
  ...(await orig<object>()),
  refreshOllama: vi.fn(async () => ({ models: [{ name: "qwen2.5:7b", params: 7, family: "qwen2" }] })),
}));
const hwState = vi.hoisted(() => ({ webgpu: true }));
vi.mock("../ai/modelManager", async (orig) => ({
  ...(await orig<object>()),
  detectHardware: vi.fn(async () =>
    hwState.webgpu
      ? { webgpu: true, f16: true, maxBufferMB: 2048, deviceMemoryGB: 8, cores: 8, mobile: false }
      : { webgpu: false, f16: false, maxBufferMB: null, deviceMemoryGB: 8, cores: 8, mobile: false, reason: "no-webgpu" },
  ),
}));

const confirm = vi.hoisted(() => ({ fn: vi.fn(async () => true) }));
vi.mock("../ui/PromptDialog", () => ({ uiConfirm: (...a: unknown[]) => confirm.fn(...(a as [])) }));

import { refreshOllama } from "../agents/executors/ollama";
import { registerExecutor, resetExecutors } from "../agents/executors";
import { runAgent } from "../agents/runtime";
import { clearTrace } from "../agents/trace";
import { AiSettingsPanel } from "../ui/AiSettingsPanel";
import type { AgentDefinition } from "../agents/types";
import { fakeExecutor, sequence } from "./helpers/fakeExecutor";

/** A fetch whose /api/pull body is streamed by the test, one NDJSON record at a time. */
function fakePullFetch() {
  const enc = new TextEncoder();
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const requests: Array<{ url: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith("/api/pull")) return new Response("{}", { status: 404 });
    requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c;
        init?.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  });
  return {
    fetchMock,
    requests,
    push: (record: unknown) => ctl.enqueue(enc.encode(JSON.stringify(record) + "\n")),
    end: () => ctl.close(),
  };
}

beforeEach(async () => {
  localStorage.clear();
  resetExecutors();
  hwState.webgpu = true;
  await clearTrace();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetExecutors();
});

describe("model manager — Ollama pull from the panel", () => {
  it("streams the pull's progress, then refreshes the installed list", async () => {
    const f = fakePullFetch();
    vi.stubGlobal("fetch", f.fetchMock);
    registerExecutor(fakeExecutor(sequence("x")));
    render(<AiSettingsPanel open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Installed: qwen2.5:7b")).toBeTruthy());
    const listedBefore = vi.mocked(refreshOllama).mock.calls.length;

    fireEvent.change(screen.getByPlaceholderText("qwen3:4b"), { target: { value: "qwen3:4b" } });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.requests[0].url).toMatch(/\/api\/pull$/);
    expect(f.requests[0].body).toEqual({ model: "qwen3:4b", stream: true });

    f.push({ status: "pulling manifest" });
    await waitFor(() => expect(screen.getByTestId("ollama-pull-status").textContent).toBe("Downloading qwen3:4b: pulling manifest"));
    f.push({ status: "pulling aaa", digest: "sha256:aaa", total: 2 * 1024 ** 3, completed: 1024 ** 3 });
    f.push({ status: "pulling bbb", digest: "sha256:bbb", total: 2 * 1024 ** 3, completed: 0 });
    await waitFor(() => expect(screen.getByTestId("ollama-pull-status").textContent).toBe("Downloading qwen3:4b: 25% · 1.0 GB / 4.0 GB"));
    expect((screen.getByTestId("ollama-pull-progress") as HTMLProgressElement).value).toBeCloseTo(0.25);
    // While it runs: no second pull, a Cancel instead.
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();

    f.push({ status: "pulling aaa", digest: "sha256:aaa", total: 2 * 1024 ** 3, completed: 2 * 1024 ** 3 });
    f.push({ status: "pulling bbb", digest: "sha256:bbb", total: 2 * 1024 ** 3, completed: 2 * 1024 ** 3 });
    await waitFor(() => expect(screen.getByTestId("ollama-pull-status").textContent).toContain("100%"));
    vi.mocked(refreshOllama).mockResolvedValue({ models: [{ name: "qwen2.5:7b", params: 7, family: "qwen2" }, { name: "qwen3:4b", params: 4, family: "qwen3" }] } as never);
    f.push({ status: "verifying sha256 digest" });
    f.push({ status: "success" });
    f.end();

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("qwen3:4b is installed"));
    expect(screen.queryByTestId("ollama-pull-progress")).toBeNull();
    await waitFor(() => expect(screen.getByText("Installed: qwen2.5:7b, qwen3:4b")).toBeTruthy());
    expect(vi.mocked(refreshOllama).mock.calls.length).toBeGreaterThan(listedBefore);
    vi.mocked(refreshOllama).mockResolvedValue({ models: [{ name: "qwen2.5:7b", params: 7, family: "qwen2" }] } as never);
  });

  it("shows Ollama's error record as a failure, not as installed", async () => {
    const f = fakePullFetch();
    vi.stubGlobal("fetch", f.fetchMock);
    render(<AiSettingsPanel open onClose={() => {}} />);
    fireEvent.change(await screen.findByPlaceholderText("qwen3:4b"), { target: { value: "nope:1b" } });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(f.requests).toHaveLength(1));
    f.push({ status: "pulling manifest" });
    f.push({ error: "pull model manifest: file does not exist" });
    f.end();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Download failed: Ollama: pull model manifest: file does not exist"));
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  });

  it("a double click starts one download, not two", async () => {
    const f = fakePullFetch();
    vi.stubGlobal("fetch", f.fetchMock);
    render(<AiSettingsPanel open onClose={() => {}} />);
    fireEvent.change(await screen.findByPlaceholderText("qwen3:4b"), { target: { value: "qwen3:4b" } });
    const button = screen.getByRole("button", { name: "Download" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(f.requests).toHaveLength(1));
    f.push({ status: "success" });
    f.end();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("qwen3:4b is installed"));
    expect(f.requests).toHaveLength(1);
  });

  it("names a custom-licence model and downloads it only after confirmation", async () => {
    const f = fakePullFetch();
    vi.stubGlobal("fetch", f.fetchMock);
    confirm.fn.mockClear();
    render(<AiSettingsPanel open onClose={() => {}} />);
    fireEvent.change(await screen.findByPlaceholderText("qwen3:4b"), { target: { value: "llama3.1:8b" } });
    confirm.fn.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(confirm.fn).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(confirm.fn.mock.calls[0])).toContain("Llama 3.1 Community License");
    expect(f.requests).toHaveLength(0);
    confirm.fn.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.requests[0].body).toEqual({ model: "llama3.1:8b", stream: true });
    f.push({ status: "success" });
    f.end();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("llama3.1:8b is installed"));
  });

  it("waits for an edited Ollama address to be saved before downloading", async () => {
    const f = fakePullFetch();
    vi.stubGlobal("fetch", f.fetchMock);
    render(<AiSettingsPanel open onClose={() => {}} />);
    fireEvent.change(await screen.findByPlaceholderText("qwen3:4b"), { target: { value: "qwen3:4b" } });
    const [address] = screen.getAllByPlaceholderText("http://localhost:11434");
    await waitFor(() => expect((address as HTMLInputElement).value).not.toBe(""));
    fireEvent.change(address, { target: { value: "http://127.0.0.1:11434" } });
    expect((screen.getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByText("Save")[0]);
    await waitFor(() => expect((screen.getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("Cancel stops the download without an error", async () => {
    const f = fakePullFetch();
    vi.stubGlobal("fetch", f.fetchMock);
    render(<AiSettingsPanel open onClose={() => {}} />);
    fireEvent.change(await screen.findByPlaceholderText("qwen3:4b"), { target: { value: "qwen3:8b" } });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(f.requests).toHaveLength(1));
    f.push({ status: "pulling aaa", digest: "sha256:aaa", total: 100, completed: 10 });
    await waitFor(() => expect(screen.getByTestId("ollama-pull-status").textContent).toContain("10%"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("ollama-pull-progress")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  });
});

describe("model manager — AI mode in the panel", () => {
  const agent: AgentDefinition = { id: "m", description: "mode", system: "sys", user: (i) => i.text ?? "", tier: "small" };

  it("a mode chosen in the panel changes the model of the next run", async () => {
    registerExecutor(fakeExecutor(sequence("ok")));
    render(<AiSettingsPanel open onClose={() => {}} />);

    expect((await runAgent(agent, { text: "a" })).model).toBe("fake-small");

    fireEvent.click(await screen.findByLabelText(/^Economy/));
    await waitFor(() => expect(localStorage.getItem("lumen.ai.mode")).toBe("economy"));
    expect((await runAgent(agent, { text: "b" })).model).toBe("fake-tiny");

    fireEvent.click(screen.getByLabelText(/^Quality/));
    await waitFor(() => expect(localStorage.getItem("lumen.ai.mode")).toBe("quality"));
    expect((await runAgent(agent, { text: "c" })).model).toBe("fake-medium");

    fireEvent.click(screen.getByLabelText(/^Balanced/));
    await waitFor(() => expect(localStorage.getItem("lumen.ai.mode")).toBeNull());
    expect((await runAgent(agent, { text: "d" })).model).toBe("fake-small");
  });

  it("the cloud chat executor keeps its own routing: the mode does not shift its tier", async () => {
    localStorage.setItem("lumen.ai.mode", "economy");
    const seen: string[] = [];
    registerExecutor(
      fakeExecutor(sequence("ok"), {
        id: "chat",
        modelFor: (tier) => {
          seen.push(tier);
          return `chat-${tier}`;
        },
      }),
    );
    const run = await runAgent({ ...agent, executorPreference: ["chat"] }, { text: "e" });
    expect(run.model).toBe("chat-small");
    expect(seen.every((x) => x === "small")).toBe(true);
  });
});

describe("model manager — no WebGPU on Firefox / Linux", () => {
  it("names the gap and the WASM fallback", async () => {
    hwState.webgpu = false;
    vi.stubGlobal("navigator", { ...navigator, userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0" });
    render(<AiSettingsPanel open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("hw-card").textContent).toBe("No WebGPU in this browser (Firefox · Linux). Use Ollama or a WebGPU browser."));
    expect(screen.getByTestId("hw-gap").textContent).toBe("Speech and search run on WASM.");
  });
});
