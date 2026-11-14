/**
 * Plan 5.1 (T2): the runtime enforces each tool's scope.
 *   write    → the change is staged for approval, never written; the call
 *              and the staged id are in the trace.
 *   network  → under local-only it is blocked (and recorded as blocked in
 *              the privacy ledger) unless the user consented to the call;
 *              with consent, or under a cloud policy, it goes out through
 *              the ledger, which records it.
 * Plus: argument schemas are enforced before a tool runs, and cancelling
 * a run stops its tools and withdraws what it staged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentDefinition, Executor, ExecutorRequest, ExecutorResponse } from "../agents/types";

const storeState = { aiKey: null as string | null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null };
vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => storeState } }));
vi.mock("../ai/ollamaProvider", () => ({ isOllamaAvailable: async () => false, getBaseUrl: () => "http://localhost:11434", chatOllama: vi.fn(), chatOllamaStream: vi.fn() }));
vi.mock("../ai/localLlm", () => ({ localLlmAvailable: () => ({ available: false }), chatLocal: vi.fn(), chatLocalStream: vi.fn(), onLocalLlmProgress: () => () => {} }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../ui/PromptDialog", () => ({ uiConfirm: vi.fn(async () => false) }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

const files = new Map<string, string>();
vi.mock("../storage/workspace", () => ({
  isOPFSAvailable: () => true,
  listWorkspace: async () => [...files.keys()].map((path) => ({ path, name: path.split("/").pop() })),
  readWorkspaceFile: async (p: string) => {
    if (!files.has(p)) throw new Error("ENOENT");
    return files.get(p)!;
  },
  writeWorkspaceFile: async (p: string, c: string) => void files.set(p, c),
  workspaceHasFile: async (p: string) => files.has(p),
  isAssetName: () => false,
}));
vi.mock("../storage/workspaceIndex", () => ({ searchWorkspace: async () => [], ensureIndex: async () => {}, indexedFiles: () => [] }));

import { runAgent } from "../agents/runtime";
import { registerExecutor, resetExecutors } from "../agents/executors";
import { clearTrace, listRuns, loadTrace } from "../agents/trace";
import { defineTool } from "../agents/tools/define";
import { pickTools } from "../agents/tools";
import { approveStagedChange, clearStagedChanges, getStagedChange, listStagedChanges } from "../agents/staging";
import { __resetLedger, ledgerEntries } from "../ai/privacyLedger";
import { setAiPolicy } from "../ai/policy";
import { grantWebConsent, revokeWebConsent } from "../research/consent";

type Script = (req: ExecutorRequest, n: number) => ExecutorResponse | Promise<ExecutorResponse>;

function fakeExecutor(script: Script): Executor & { calls: ExecutorRequest[] } {
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
const reply = (content: string): ExecutorResponse => ({ content, toolCalls: [], model: "fake-small" });
const call = (tool: string, args: Record<string, unknown>) => reply(JSON.stringify({ tool, args }));
const final = (answer: string) => reply(JSON.stringify({ final: answer }));
/** The last tool result; an untrusted one (plan 2.7) arrives between ⟪untrusted⟫ delimiters around the JSON. */
const lastToolResult = (req: ExecutorRequest) => {
  const c = req.messages[req.messages.length - 1].content;
  return JSON.parse(c.slice(c.indexOf("{"), c.lastIndexOf("}") + 1)) as { tool: string; result?: unknown; error?: string };
};

/** An agent that calls the scripted tools, then answers. */
function agent(toolNames: string[], requires: AgentDefinition["requires"] = []): AgentDefinition {
  return { id: "t", description: "test", system: "sys", user: () => "go", tools: pickTools(...toolNames), requires, language: "any", maxRetries: 0 };
}

const ENDPOINT = "https://research.example.com";
let net: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  resetExecutors();
  await clearTrace();
  clearStagedChanges();
  files.clear();
  localStorage.clear();
  __resetLedger();
  localStorage.setItem("lumen.research.endpoint", ENDPOINT);
  localStorage.setItem("lumen.research.provider", "searxng");
  net = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/search")) return Response.json({ results: [{ title: "Lumen docs", url: "https://lumen.example/docs", snippet: "local-first" }] });
    return Response.json({ finalUrl: "https://lumen.example/docs", status: 200, title: "Docs", text: "Lumen keeps every note on your device. Nothing leaves it." });
  });
  vi.stubGlobal("fetch", net);
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetExecutors();
});

describe("write tools", () => {
  it("stage the change for approval instead of writing, and the trace shows it", async () => {
    files.set("notes/a.md", "old");
    registerExecutor(fakeExecutor((req, n) => (n === 1 ? call("write_file", { path: "notes/a.md", content: "new" }) : (expect(lastToolResult(req).result).toMatchObject({ staged: true }), final("proposed")))));
    const run = await runAgent(agent(["write_file"], ["write"]), {}, { grants: ["write"] });
    expect(run.status).toBe("ok");
    expect(files.get("notes/a.md")).toBe("old"); // not written
    const [change] = listStagedChanges();
    expect(change).toMatchObject({ kind: "file", path: "notes/a.md", before: "old", after: "new", tool: "write_file", runId: run.id, agentId: "t", status: "pending" });
    expect(run.staged).toEqual([change.id]);
    const step = run.steps.find((s) => s.kind === "tool")!;
    expect(step).toMatchObject({ label: "write_file", ok: true });
    expect(step.detail).toContain(`staged ${change.id}`);
    await loadTrace();
    expect(listRuns()[0]).toMatchObject({ id: run.id, staged: [change.id] });
    // Only the approval writes.
    await approveStagedChange(change.id);
    expect(files.get("notes/a.md")).toBe("new");
  });

  it("stage replace_range on the open document, never touching it", async () => {
    registerExecutor(fakeExecutor((_req, n) => (n === 1 ? call("replace_range", { startLine: 1, text: "# Better title", expected: "# Title" }) : final("ok"))));
    const document = "# Title\nbody";
    const run = await runAgent(agent(["get_document", "replace_range"]), {}, { grants: ["write"], document, path: "doc.md" });
    expect(run.status).toBe("ok");
    expect(getStagedChange(run.staged![0])).toMatchObject({ kind: "range", from: 0, to: 7, before: "# Title", after: "# Better title", path: "doc.md" });
  });

  it("must return the receipt of what they staged; a write tool that does not is an error and its proposal is withdrawn", async () => {
    const rogue = defineTool({
      name: "rogue_write",
      description: "stages, then reports something else",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      scope: "write",
      run: async (_a, c) => (c.stage!({ kind: "file", path: "x.md", before: null, after: "x", summary: "x" }), { ok: true }),
    });
    let err = "";
    registerExecutor(fakeExecutor((req, n) => (n === 1 ? call("rogue_write", {}) : ((err = lastToolResult(req).error ?? ""), final("x")))));
    const run = await runAgent({ id: "r", description: "", system: "s", user: () => "u", tools: [rogue], language: "any" }, {}, { grants: ["write"] });
    expect(err).toMatch(/^failed: "rogue_write" did not return its staged change/);
    expect(listStagedChanges()).toHaveLength(0);
    expect(run.staged).toBeUndefined();
  });

  it("are refused without the write grant, and nothing is staged", async () => {
    registerExecutor(fakeExecutor((req, n) => (n === 1 ? call("set_frontmatter", { set: { a: 1 } }) : (expect(lastToolResult(req).error).toContain("permission"), final("no")))));
    const run = await runAgent(agent(["set_frontmatter"]), {}, { document: "x" });
    expect(run.steps.find((s) => s.kind === "tool")?.ok).toBe(false);
    expect(listStagedChanges()).toHaveLength(0);
    expect(run.staged).toBeUndefined();
  });
});

describe("argument schemas", () => {
  it("are enforced before a tool runs; numeric strings are coerced", async () => {
    const spy = vi.fn(async (a: Record<string, unknown>) => ({ got: a }));
    const tool = defineTool({ name: "probe", description: "probe tool", parameters: { type: "object", properties: { n: { type: "integer", minimum: 1 } }, required: ["n"], additionalProperties: false }, run: spy });
    const results: Array<{ result?: unknown; error?: string }> = [];
    registerExecutor(
      fakeExecutor((req, n) => {
        if (n > 1) results.push(lastToolResult(req));
        return n === 1 ? call("probe", { n: "zero" }) : n === 2 ? call("probe", { n: "3" }) : final("done");
      }),
    );
    const def: AgentDefinition = { id: "p", description: "", system: "s", user: () => "u", tools: [tool], language: "any" };
    await runAgent(def, {});
    expect(results[0].error).toMatch(/^bad-args: \$\.n must be integer/);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual({ n: 3 });
  });
});

describe("network tools", () => {
  it("are blocked under local-only without consent, before anything is sent, and the ledger records the block", async () => {
    setAiPolicy("local-only");
    const consent = vi.fn(() => false);
    let toolResult: { error?: string } = {};
    registerExecutor(fakeExecutor((req, n) => (n === 1 ? call("search_web", { query: "lumen privacy" }) : ((toolResult = lastToolResult(req)), final("offline")))));
    const run = await runAgent(agent(["search_web"]), {}, { grants: ["network"], consentNetwork: consent, document: "SECRET DOC" });
    expect(run.status).toBe("ok");
    expect(consent).toHaveBeenCalledWith({ tool: "search_web", host: "research.example.com", sends: "the search query", what: "search-query", credential: undefined, args: { query: "lumen privacy" } });
    expect(net).not.toHaveBeenCalled();
    expect(toolResult.error).toMatch(/^blocked: Blocked by the local-only AI policy/);
    expect(run.steps.find((s) => s.kind === "tool")).toMatchObject({ label: "search_web", ok: false });
    expect(ledgerEntries()).toEqual([expect.objectContaining({ host: "research.example.com", category: "research", decision: "blocked", policy: "local-only", bytesOut: 0 })]);
  });

  it("go out under local-only on the user's consent, send only the query, and are recorded", async () => {
    setAiPolicy("local-only");
    let toolResult: { result?: unknown } = {};
    registerExecutor(fakeExecutor((req, n) => (n === 1 ? call("search_web", { query: "lumen privacy", count: "2" }) : ((toolResult = lastToolResult(req)), final("found")))));
    const run = await runAgent(agent(["search_web"]), {}, { grants: ["network"], consentNetwork: () => true, document: "SECRET DOC" });
    expect(run.status).toBe("ok");
    expect(net).toHaveBeenCalledTimes(1);
    const [url, init] = net.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ENDPOINT}/search`);
    expect(JSON.parse(String(init.body))).toMatchObject({ provider: "searxng", query: "lumen privacy", count: 2 });
    expect(String(init.body)).not.toContain("SECRET");
    expect(toolResult.result).toMatchObject({ provider: "searxng", results: [{ title: "Lumen docs" }] });
    expect(run.steps.find((s) => s.kind === "tool")?.detail).toContain("consent");
    expect(ledgerEntries()).toEqual([expect.objectContaining({ host: "research.example.com", method: "POST", category: "research", decision: "allowed", consent: true, policy: "local-only", status: 200 })]);
    expect(ledgerEntries()[0].bytesOut).toBeGreaterThan(0);
  });

  it("ask for every call under local-only — the one-time research consent does not count (owner's decision, plan 15.10 (8))", async () => {
    setAiPolicy("local-only");
    grantWebConsent(); // given earlier to research.ask: not consent for agents
    const { uiConfirm } = await import("../ui/PromptDialog");
    const ask = vi.mocked(uiConfirm);
    ask.mockClear();
    registerExecutor(fakeExecutor((_req, n) => (n % 2 === 1 ? call("fetch_page", { url: "https://lumen.example/docs" }) : final("x"))));
    ask.mockResolvedValueOnce(false);
    await runAgent(agent(["fetch_page"]), {}, { grants: ["network"] });
    expect(net).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0].message).toContain("lumen.example");
    expect(ask.mock.calls[0][0].message).toContain("fetch_page");
    ask.mockResolvedValueOnce(true);
    await runAgent(agent(["fetch_page"]), {}, { grants: ["network"] });
    expect(ask).toHaveBeenCalledTimes(2); // asked again: a yes is for one call
    expect(net).toHaveBeenCalledWith(`${ENDPOINT}/extract?url=${encodeURIComponent("https://lumen.example/docs")}`, expect.anything());
    expect(ledgerEntries().map((e) => [e.decision, e.consent ?? false])).toEqual([
      ["blocked", false],
      ["allowed", true],
    ]);
    revokeWebConsent();
  });

  it("need no consent when the policy allows the cloud, and are still recorded", async () => {
    setAiPolicy("cloud");
    const consent = vi.fn(() => false);
    registerExecutor(fakeExecutor((_req, n) => (n === 1 ? call("search_web", { query: "q" }) : final("x"))));
    // (Under `cloud` the runtime skips local executors unless one is forced.)
    await runAgent(agent(["search_web"]), {}, { grants: ["network"], consentNetwork: consent, executor: "ollama" });
    expect(consent).not.toHaveBeenCalled();
    expect(net).toHaveBeenCalledTimes(1);
    expect(ledgerEntries()).toEqual([expect.objectContaining({ decision: "allowed", category: "research", policy: "cloud" })]);
    expect(ledgerEntries()[0].consent).toBeUndefined();
  });

  it("are refused without the network grant — no consent asked, nothing recorded", async () => {
    setAiPolicy("local-first");
    const consent = vi.fn(() => true);
    let err = "";
    registerExecutor(fakeExecutor((req, n) => (n === 1 ? call("search_web", { query: "q" }) : ((err = lastToolResult(req).error ?? ""), final("x")))));
    await runAgent(agent(["search_web"]), {}, { consentNetwork: consent });
    expect(err).toContain('needs the "network" permission');
    expect(consent).not.toHaveBeenCalled();
    expect(net).not.toHaveBeenCalled();
    expect(ledgerEntries()).toHaveLength(0);
  });

  it("fail clearly when no research service is configured", async () => {
    setAiPolicy("local-only");
    localStorage.removeItem("lumen.research.endpoint");
    const consent = vi.fn(() => true);
    let err = "";
    registerExecutor(fakeExecutor((req, n) => (n === 1 ? call("search_web", { query: "q" }) : ((err = lastToolResult(req).error ?? ""), final("x")))));
    await runAgent(agent(["search_web"]), {}, { grants: ["network"], consentNetwork: consent });
    expect(err).toMatch(/^failed: The research service isn't configured/);
    expect(consent).not.toHaveBeenCalled();
    expect(ledgerEntries()).toHaveLength(0);
  });

  it("fetch_page keeps the page in the run so extract_quotes can quote it with offsets", async () => {
    setAiPolicy("local-first");
    let quotes: unknown;
    registerExecutor(
      fakeExecutor((req, n) => {
        if (n === 1) return call("fetch_page", { url: "https://lumen.example/docs", maxChars: 200 });
        if (n === 2) return call("extract_quotes", { url: "https://lumen.example/docs", quotes: ["every note on your device", "Lumen uploads notes"] });
        quotes = lastToolResult(req).result;
        return final("cited");
      }),
    );
    const run = await runAgent(agent(["fetch_page", "extract_quotes"]), {}, { grants: ["network"] });
    expect(run.status).toBe("ok");
    expect(quotes).toMatchObject({
      source: "https://lumen.example/docs",
      found: 1,
      quotes: [
        { quote: "every note on your device", found: true, exact: "every note on your device", start: 12, end: 37 },
        { quote: "Lumen uploads notes", found: false },
      ],
    });
  });
});

describe("cancellation", () => {
  it("stops a network tool mid-request and ends the run as aborted", async () => {
    setAiPolicy("local-first");
    const ctrl = new AbortController();
    net.mockImplementation(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          ctrl.abort();
        }),
    );
    registerExecutor(fakeExecutor((_req, n) => (n === 1 ? call("fetch_page", { url: "https://lumen.example/docs" }) : final("never"))));
    const run = await runAgent(agent(["fetch_page"]), {}, { grants: ["network"], signal: ctrl.signal });
    expect(run.status).toBe("aborted");
    expect(run.steps.filter((s) => s.kind === "model")).toHaveLength(1);
  });

  it("withdraws what a cancelled run staged", async () => {
    const ctrl = new AbortController();
    registerExecutor(
      fakeExecutor(async (_req, n) => {
        if (n === 1) return call("write_file", { path: "a.md", content: "x" });
        ctrl.abort();
        throw new DOMException("aborted", "AbortError");
      }),
    );
    const run = await runAgent(agent(["write_file"]), {}, { grants: ["write"], signal: ctrl.signal });
    expect(run.status).toBe("aborted");
    expect(run.staged).toHaveLength(1);
    expect(getStagedChange(run.staged![0])).toMatchObject({ status: "rejected", error: "the run was cancelled" });
    expect(listStagedChanges()).toHaveLength(0);
    expect(files.has("a.md")).toBe(false);
  });

  it("the consent names the research service as recipient, the visited page, and a forwarded search key (review: #205)", async () => {
    setAiPolicy("local-only");
    const { describeNetworkCall } = await import("../agents/network");
    const { getTool } = await import("../agents/tools");
    const page = await describeNetworkCall(getTool("fetch_page")!, { name: "fetch_page", args: { url: "https://lumen.example/docs" } } as never);
    expect(page).toMatchObject({ host: "research.example.com", visits: "lumen.example", what: "page-address" });
    localStorage.setItem("lumen.research.provider", "brave");
    const { setSecret } = await import("../lib/secretStore");
    setSecret("lumen.research.searchKey", "BSA-test");
    const search = await describeNetworkCall(getTool("search_web")!, { name: "search_web", args: { query: "q" } } as never);
    expect(search).toMatchObject({ host: "research.example.com", credential: "Brave Search", sends: expect.stringContaining("API key") });
    const { uiConfirm } = await import("../ui/PromptDialog");
    const ask = vi.mocked(uiConfirm);
    ask.mockClear();
    ask.mockResolvedValueOnce(false);
    registerExecutor(fakeExecutor((_req, n) => (n % 2 === 1 ? call("search_web", { query: "q" }) : final("x"))));
    await runAgent(agent(["search_web"]), {}, { grants: ["network"] });
    const message = ask.mock.calls[0][0].message as string;
    expect(message).toContain("research.example.com");
    expect(message).toContain("Brave Search");
    setSecret("lumen.research.searchKey", "");
    localStorage.removeItem("lumen.research.provider");
  });

  it("shows exactly what a call sends, instead of promising that no note text leaves the device", async () => {
    setAiPolicy("local-only");
    const { uiConfirm } = await import("../ui/PromptDialog");
    const ask = vi.mocked(uiConfirm);
    ask.mockClear();
    ask.mockResolvedValueOnce(false);
    // A query the agent built from the open note.
    const query = "Dr. Levi diagnosis March appointment notes";
    registerExecutor(fakeExecutor((_req, n) => (n % 2 === 1 ? call("search_web", { query }) : final("x"))));
    await runAgent(agent(["search_web"]), {}, { grants: ["network"] });
    const message = ask.mock.calls[0][0].message as string;
    expect(message).toContain(`“${query}”`);
    expect(message).toContain("may have included text from your notes");
    expect(message).not.toMatch(/Nothing from your notes/i);
    const { sentValue } = await import("../agents/network");
    expect(sentValue({ what: "page-address", args: { url: "https://x.example/p" } })).toBe("https://x.example/p");
    // The whole value, however long (review on #241 / #205): nothing is sent that the prompt did not show.
    expect(sentValue({ what: "search-query", args: { query: "a".repeat(400) } })).toBe("a".repeat(400));
    const longUrl = `https://x.example/p?${"q=1&".repeat(400)}secret=yes`;
    expect(sentValue({ what: "page-address", args: { url: longUrl } })).toBe(longUrl);
  });

  it("sends with exactly the service and settings the prompt described, even if they change while it is open (review on #205)", async () => {
    setAiPolicy("local-only");
    localStorage.setItem("lumen.research.provider", "searxng");
    const shown: string[] = [];
    // While the dialog is open, another tab switches to Brave with a key and to another service.
    const consent = vi.fn(async (req: { host: string; credential?: string }) => {
      shown.push(`${req.host} ${req.credential ?? "no key"}`);
      localStorage.setItem("lumen.research.endpoint", "https://evil.example");
      localStorage.setItem("lumen.research.provider", "brave");
      const { setSecret } = await import("../lib/secretStore");
      setSecret("lumen.research.searchKey", "BSA-undisclosed");
      return true;
    });
    registerExecutor(fakeExecutor((_req, n) => (n === 1 ? call("search_web", { query: "lumen" }) : final("x"))));
    await runAgent(agent(["search_web"]), {}, { grants: ["network"], consentNetwork: consent });
    expect(shown).toEqual(["research.example.com no key"]);
    expect(net).toHaveBeenCalledTimes(1);
    const [url, init] = net.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ENDPOINT}/search`);
    expect(String(init.body)).not.toContain("BSA-undisclosed");
    expect(String(init.body)).toContain("searxng");
    const { setSecret } = await import("../lib/secretStore");
    setSecret("lumen.research.searchKey", "");
  });

  it("an approved call's fetch reaches only that research service", async () => {
    setAiPolicy("local-only");
    const { openNetworkGate } = await import("../agents/network");
    const { getTool } = await import("../agents/tools");
    const gate = await openNetworkGate(getTool("search_web")!, { id: "c", name: "search_web", args: { query: "q" } }, () => true);
    expect(gate.bound.endpoint).toBe(ENDPOINT);
    await expect(gate.fetch("https://evil.example/search")).rejects.toMatchObject({ code: "denied" });
    await gate.fetch(`${ENDPOINT}/search`, { method: "POST", body: "{}" });
    expect(net).toHaveBeenCalledWith(`${ENDPOINT}/search`, expect.anything());
  });
});
