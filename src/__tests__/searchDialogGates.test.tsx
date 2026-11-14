/**
 * SearchDialog honours the plan gates: Smart (embedding) search needs the
 * `smartSearch` capability, and each Ask-Workspace question spends one AI
 * prompt from the monthly quota. Self-hosted (no billing) stays unlocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

vi.mock("../storage/workspaceIndex", () => ({ searchWorkspace: vi.fn(async () => []) }));
vi.mock("../storage/workspace", () => ({
  isOPFSAvailable: () => true,
  readWorkspaceFile: vi.fn(async () => ""),
}));
const searchHybrid = vi.fn(async () => []);
vi.mock("../ai/semanticSearch", () => ({
  indexWorkspace: vi.fn(),
  searchHybrid: (...a: unknown[]) => searchHybrid(...(a as [])),
}));
vi.mock("../ai/embeddings", () => ({ semanticSearch: vi.fn(async () => []) }));
const chat = vi.fn(async () => "answer");
vi.mock("../ai/llm", async (orig) => ({
  ...(await orig<typeof import("../ai/llm")>()),
  chat: (...a: unknown[]) => chat(...(a as [])),
}));
vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));
type RerankItems = Array<Record<string, unknown>>;
const rerankImpl = vi.fn(async (_q: string, items: RerankItems, _o?: { signal?: AbortSignal }) =>
  items.map((i) => ({ ...i, rerankScore: 1 })),
);
vi.mock("../ai/reranker", () => ({
  rerank: (...a: unknown[]) => rerankImpl(...(a as [string, RerankItems, { signal?: AbortSignal }])),
}));

import { SearchDialog } from "../ui/SearchDialog";
import { useEntitlement, __setEntitlementEndpointForTesting } from "../billing/useEntitlement";
import { FREE_CAPS, PRO_CAPS } from "../billing/types";
import { getAiUsage, recordAiPrompt, consumeAiPrompt } from "../billing/aiQuota";
import { showAiToast } from "../ui/AiToast";
import { useAppStore } from "../store/useStore";

function setCaps(caps: typeof FREE_CAPS) {
  useEntitlement.setState({ capabilities: caps, entitlement: null, loading: false });
}
function openOn(mode: "smart" | "ai") {
  (window as unknown as { __lumenSearchMode?: string }).__lumenSearchMode = mode;
  render(<SearchDialog open onClose={() => {}} onOpenFile={() => {}} />);
}

beforeEach(async () => {
  localStorage.clear();
  useAppStore.setState({ aiKey: "sk-test" }); // a usable provider, so prompts count
  vi.clearAllMocks();
  setCaps(FREE_CAPS);
  // Ask Workspace runs the `answerer` agent (plan 5.5): a model that hands the request to the `chat` spy.
  const { registerExecutor, resetExecutors } = await import("../agents/executors");
  resetExecutors();
  registerExecutor({
    id: "ollama",
    label: "test",
    available: async () => ({ available: true }),
    supportsTools: () => false,
    supportsSchema: () => false,
    modelFor: () => "test",
    chat: async (req) => ({ content: await chat(...([req.messages, { signal: req.signal }] as unknown as [])), toolCalls: [], model: "test" }),
  });
});
afterEach(() => {
  cleanup();
  __setEntitlementEndpointForTesting(null);
  localStorage.clear();
});

describe("Smart search gate", () => {
  it("free plan with billing: shows an upgrade notice and never queries embeddings", async () => {
    __setEntitlementEndpointForTesting("https://billing.lumen.test/entitlements");
    openOn("smart");
    expect(await screen.findByTestId("upgrade-notice")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "quarterly plan" } });
    await new Promise((r) => setTimeout(r, 300));
    expect(searchHybrid).not.toHaveBeenCalled();
    expect(screen.queryByText(/Build index|Re-index/)).toBeNull();
  });

  it("Pro plan with billing: smart search runs", async () => {
    __setEntitlementEndpointForTesting("https://billing.lumen.test/entitlements");
    setCaps(PRO_CAPS);
    openOn("smart");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "quarterly plan" } });
    await waitFor(() => expect(searchHybrid).toHaveBeenCalled());
    expect(screen.queryByTestId("upgrade-notice")).toBeNull();
  });

  it("self-hosted (no billing): unlocked even on FREE caps", async () => {
    openOn("smart");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "quarterly plan" } });
    await waitFor(() => expect(searchHybrid).toHaveBeenCalled());
    expect(screen.queryByTestId("upgrade-notice")).toBeNull();
  });
});

describe("Smart search rerank", () => {
  it("aborts the stale model rerank when the query changes", async () => {
    searchHybrid.mockImplementation((async () => [
      { path: "a.md", snippet: "a", score: 1 },
      { path: "b.md", snippet: "b", score: 0.5 },
    ]) as unknown as () => Promise<never[]>);
    const signals: AbortSignal[] = [];
    rerankImpl.mockImplementationOnce((_q, _items, o) => {
      signals.push(o!.signal!);
      return new Promise(() => {}); // a long inference still in the worker
    });
    try {
      openOn("smart");
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "first" } });
      await waitFor(() => expect(signals).toHaveLength(1));
      expect(signals[0].aborted).toBe(false);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "first second" } });
      expect(signals[0].aborted).toBe(true);
    } finally {
      searchHybrid.mockImplementation(async () => []);
    }
  });
});

describe("Ask Workspace spends the AI quota", () => {
  it("charges the question itself — one prompt, when it is actually sent (the answerer agent's own prompt)", async () => {
    __setEntitlementEndpointForTesting("https://billing.lumen.test/entitlements");
    openOn("ai");
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "what changed?" } });
    expect(getAiUsage()).toBe(0); // nothing counted up front
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getAiUsage()).toBe(1));
  });
});

describe("Ask Workspace: overlapping questions", () => {
  it("a second question aborts the first, and closing still aborts the second", async () => {
    const signals: AbortSignal[] = [];
    chat.mockImplementation(
      (async (_m: unknown, o: { signal: AbortSignal }) =>
        new Promise<string>((_, reject) => {
          signals.push(o.signal);
          o.signal.addEventListener("abort", () => reject(o.signal.reason));
        })) as never,
    );
    (window as unknown as { __lumenSearchMode?: string }).__lumenSearchMode = "ai";
    const { rerender } = render(<SearchDialog open onClose={() => {}} onOpenFile={() => {}} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "first?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(signals).toHaveLength(1));
    fireEvent.change(input, { target: { value: "second?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0].aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 0)); // the first one's finally runs
    rerender(<SearchDialog open={false} onClose={() => {}} onOpenFile={() => {}} />);
    await waitFor(() => expect(signals[1].aborted).toBe(true));
    chat.mockImplementation(async () => "answer");
  });
});

describe("silent quota checks for background callers", () => {
  it("returns false without a toast when exhausted", () => {
    __setEntitlementEndpointForTesting("https://billing.lumen.test/entitlements");
    for (let i = 0; i < FREE_CAPS.aiMonthlyPrompts; i++) recordAiPrompt();
    expect(consumeAiPrompt(new Date(), { silent: true })).toBe(false);
    expect(showAiToast).not.toHaveBeenCalled();
  });
});
