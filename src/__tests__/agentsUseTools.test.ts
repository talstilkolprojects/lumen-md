/**
 * Plan 5.3: every agent uses its tools through the runtime.
 *  - Each of the 13 agents declares the plan's tools, and a fake-model run
 *    of its eval case makes the expected tool call, which the runtime
 *    executes against an in-memory workspace (5.3.1–5.3.3).
 *  - Context calls: the runtime fetches what an agent always needs through
 *    the same tool path, once per run, and the model sees the results.
 *  - Small models are held to a JSON Schema on every turn: the protocol's
 *    (a call to one of the agent's tools, or the final answer) (5.3.5).
 *  - A streaming agent's tools are context only; its answer still streams.
 *  - callTool runs one tool under the same rules, for commands.
 *  - The builder proposes all files at once, or none (5.3.2).
 */
import { installEvalWeb } from "./helpers/evalWeb";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../storage/workspace", async (orig) => {
  const m = (await import("./helpers/evalVault")).workspaceModule(await orig()) as { writeWorkspaceFile: (p: string, c: string) => Promise<void> };
  return { ...m, writeWorkspaceFile: vi.fn(m.writeWorkspaceFile) };
});
vi.mock("../sync/git", async (orig) => (await import("./helpers/evalVault")).gitModule(await orig()));
vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));
vi.mock("../ai/llm", async (orig) => ({ ...(await orig<object>()), chat: vi.fn(async () => "generated text") }));

import "../agents/defs";
import { getAgent } from "../agents/registry";
import { callTool, runAgent } from "../agents/runtime";
import { registerExecutor, resetExecutors } from "../agents/executors";
import { EVAL_CASES, type EvalCase } from "../agents/eval/fixtures";
import { scoreCases } from "../agents/eval/score";
import { toolCheck } from "../agents/eval/run";
import { clearStagedChanges, listStagedChanges } from "../agents/staging";
import { writeWorkspaceFile } from "../storage/workspace";
import type { AgentDefinition, AgentTool, ExecutorRequest, ExecutorResponse } from "../agents/types";
import { fakeExecutor, reply } from "./helpers/fakeExecutor";
import { resetVault, vaultFiles as vault } from "./helpers/evalVault";
import { scriptedAnswer } from "../agents/eval/scripted";

beforeEach(() => {
  resetExecutors();
  clearStagedChanges();
  resetVault();
  vi.mocked(writeWorkspaceFile).mockClear();
  localStorage.setItem("lumen.ai.cache", "off");
  // The researcher's web (plan 5.4): a stubbed research service.
  installEvalWeb();
});

/** The plan's tools per agent (5.3.1–5.3.3). */
const PLAN: Record<string, string[]> = {
  tagger: ["list_tags"],
  linker: ["search_workspace", "list_files"],
  outliner: ["get_document"],
  diagrammer: ["validate_mermaid"],
  tasker: ["get_document"],
  translator: ["get_document"],
  charter: ["csv_parse", "validate_echarts"],
  committer: ["git_diff"],
  writer: ["get_selection"],
  templater: ["get_selection"],
  "builder-spec": ["list_files"],
  proofreader: ["get_document"],
  stylist: ["read_file", "list_files"],
  // Plan 5.4: the research agent's loop (web and library).
  researcher: ["search_web", "fetch_page", "extract_quotes", "search_workspace", "read_file"],
};

const scriptedModel = (c: EvalCase) => (req: ExecutorRequest): ExecutorResponse => scriptedAnswer(c, req);

describe("every agent declares the plan's tools", () => {
  it.each(Object.entries(PLAN))("%s", (id, tools) => {
    const def = getAgent(id)!;
    expect(def, id).toBeTruthy();
    expect(def.tools?.map((t) => t.name)).toEqual(expect.arrayContaining(tools));
    expect(def.maxSteps, `${id} sets its own maxSteps (5.3.4)`).toBeGreaterThan(0);
    for (const c of def.context?.({ text: "x", extra: { repo: "repo" } } as never) ?? []) expect(def.tools!.map((t) => t.name)).toContain(c.tool);
  });

  it("the eval covers all 14 agents (13 + researcher), each with an expected tool call", () => {
    const covered = new Set(EVAL_CASES.map((c) => c.agent));
    for (const id of Object.keys(PLAN)) expect(covered, id).toContain(id);
    for (const c of EVAL_CASES) {
      // A case outside the plan's 13 is for an agent with no tools (the formulator, plan 4.11).
      if (!(c.agent in PLAN)) {
        expect(c.tool, c.id).toBeUndefined();
        expect(getAgent(c.agent)?.tools ?? [], c.id).toEqual([]);
        continue;
      }
      expect(c.tool, c.id).toBeDefined();
      expect(PLAN[c.agent], c.id).toContain(c.tool!.name === "get_headings" ? "get_document" : c.tool!.name);
    }
  });
});

describe("a fake-model run of each eval case makes its tool call through the runtime", () => {
  it.each(EVAL_CASES.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const ex = fakeExecutor(scriptedModel(c), { supportsSchema: () => true, supportsTools: () => true });
    registerExecutor(ex);
    const def = getAgent(c.agent)!;
    // Started like the eval starts it: a research question is meant to be sent; other inputs are the document.
    const run = await runAgent(def, c.input, {
      ...(c.run?.inputMayLeave ? { inputMayLeave: true, consentNetwork: () => true } : { document: c.input.text }),
      selection: c.input.selection,
      grants: c.run?.grants,
    });
    expect(run.error ?? "", c.id).toBe("");
    expect(run.status).toBe("ok");
    const tool = toolCheck(c, run.steps);
    expect(tool.detail, c.id).toBe(c.tool ? `called ${c.tool.name}` : "no tool call expected");
    for (const check of await scoreCases(run.output, c.checks)) expect(check.ok, `${c.id}: ${check.detail}`).toBe(true);
    if (!def.tools?.length) return; // no tools: nothing offered, nothing more to check
    if (def.streaming) {
      // Context only: the model is offered no tools and may stream.
      expect(ex.calls.every((r) => !r.tools && !r.schema)).toBe(true);
      expect(run.steps.find((s) => s.kind === "tool")?.detail).toMatch(/^context/);
    } else if ((def.tier ?? "small") === "small" || def.tier === "tiny") {
      // Every turn held to the protocol's schema; no native tools.
      for (const r of ex.calls) {
        expect(r.tools).toBeUndefined();
        const names = ((r.schema as { anyOf: Array<{ properties: { tool?: { enum: string[] } } }> }).anyOf ?? []).flatMap((b) => b.properties.tool?.enum ?? []);
        expect(names).toEqual(expect.arrayContaining(def.tools!.map((t) => t.name)));
      }
    } else {
      expect(ex.calls[0].tools?.map((t) => t.name)).toEqual(def.tools!.map((t) => t.name));
    }
  });
});

describe("context calls", () => {
  const upper: AgentTool = { name: "upper", description: "upper", scope: "read", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, run: vi.fn(async (a: Record<string, unknown>) => String(a.text).toUpperCase()) };

  it("run once per run, through the tool path, and the model sees them as its own calls", async () => {
    const ex = fakeExecutor((_req, n) => reply(n === 1 ? "not json" : '{"final": "done"}'), { supportsSchema: () => true });
    registerExecutor(ex);
    const def: AgentDefinition<{ text: string }, string> = { id: "ctx", description: "", system: "s", user: () => "u", tools: [upper], context: (i) => [{ tool: "upper", args: { text: i.text } }], maxRetries: 1, validators: [{ name: "v", check: (o) => (o === "done" ? { ok: true } : { ok: false, reason: "r" }) }] };
    const run = await runAgent(def, { text: "abc" });
    expect(run.status).toBe("ok");
    expect(upper.run).toHaveBeenCalledTimes(1); // not again on the retry
    for (const r of ex.calls) {
      const res = r.messages.find((m) => m.role === "tool" && m.name === "upper");
      expect(res?.content).toContain('"result":"ABC"');
      expect(r.messages.find((m) => m.role === "assistant" && m.toolCalls?.[0]?.name === "upper")).toBeTruthy();
    }
    expect(run.steps.filter((s) => s.kind === "tool")).toEqual([expect.objectContaining({ label: "upper", ok: true, detail: expect.stringMatching(/^context/) })]);
  });

  it("a context call to a tool the agent does not have is refused like any other call", async () => {
    registerExecutor(fakeExecutor(() => reply('{"final": "x"}')));
    const run = await runAgent({ id: "bad", description: "", system: "s", user: () => "u", tools: [upper], context: () => [{ tool: "write_file", args: { path: "a.md", content: "x" } }] }, {});
    expect(run.steps[0]).toMatchObject({ kind: "tool", label: "write_file", ok: false });
    expect(listStagedChanges()).toEqual([]);
  });
});

describe("callTool", () => {
  it("runs one tool under the runtime's rules", async () => {
    expect(await callTool<{ files: string[] }>("list_files", { prefix: "journal/" })).toMatchObject({ files: ["journal/a.md", "journal/b.md"], total: 2 });
    expect(await callTool("list_files", { modifiedSince: 1500, withModified: true })).toMatchObject({ files: ["journal/a.md", "journal/b.md"], modified: { "journal/a.md": 2000 } });
    await expect(callTool("read_file", { path: 7 })).rejects.toMatchObject({ code: "bad-args" });
    // A write tool needs the scope, and then only stages.
    await expect(callTool("write_file", { path: "x.md", content: "x" })).rejects.toMatchObject({ code: "denied" });
    await callTool("write_file", { path: "x.md", content: "x" }, { grants: ["write"], agentId: "builder" });
    expect(listStagedChanges()).toMatchObject([{ path: "x.md", agentId: "builder", status: "pending" }]);
    expect(vault.has("x.md")).toBe(false);
  });
});

describe("builder: all files or none (5.3.2)", () => {
  const spec = { name: "pomodoro", description: "d", features: ["f"], techStack: ["js"], fileStructure: ["index.html", "app.js", "style.css"] };
  const files: Record<string, string> = { "index.html": "<!doctype html>\n<html><body><p>hi</p></body></html>", "app.js": "console.log('hi');", "style.css": "body { margin: 0; }" };
  const builder = (broken?: string) =>
    fakeExecutor((req) => {
      const sys = req.messages[0].content;
      if (/product architect/i.test(sys)) return reply(JSON.stringify(spec), req.model);
      const path = /File to generate: (\S+)/.exec(req.messages.map((m) => m.content).join("\n"))?.[1];
      // The architecture, test and docs stages run through their agents too (plan 5.5).
      if (!path) return reply("generated text", req.model);
      return reply(path === broken ? "" : files[path], req.model);
    });
  const projectFiles = () => [...vault.keys()].filter((p) => p.startsWith("pomodoro/")).sort();

  it("a finished product is written to the workspace at once", async () => {
    registerExecutor(builder());
    const { createProduct } = await import("../ai/productAgent");
    const res = await createProduct("a pomodoro timer");
    expect(res.success).toBe(true);
    expect(projectFiles()).toEqual([...res.files.keys()].sort());
    expect(vault.get("pomodoro/app.js")).toBe(files["app.js"]);
  });

  it("a builder that fails midway leaves 0 files (review: #241 — written, not staged without a review screen)", async () => {
    registerExecutor(builder("app.js"));
    const { createProduct } = await import("../ai/productAgent");
    const res = await createProduct("a pomodoro timer");
    expect(res.success).toBe(false);
    expect(projectFiles()).toEqual([]);
    expect(writeWorkspaceFile).not.toHaveBeenCalled();
    expect(listStagedChanges({ all: true })).toEqual([]);
  });

  it("if a write fails partway, the files already written are put back", async () => {
    registerExecutor(builder());
    vault.set("pomodoro/index.html", "the user's own page");
    let n = 0;
    vi.mocked(writeWorkspaceFile).mockImplementation(async (p: string, c: string) => {
      if (p.startsWith("pomodoro/") && c !== "the user's own page" && ++n === 3) throw new Error("disk full");
      vault.set(p, c);
    });
    const { createProduct } = await import("../ai/productAgent");
    const res = await createProduct("a pomodoro timer");
    vi.mocked(writeWorkspaceFile).mockReset();
    expect(res.success).toBe(false);
    expect(projectFiles()).toEqual(["pomodoro/index.html"]);
    expect(vault.get("pomodoro/index.html")).toBe("the user's own page");
  });
});

describe("digest through the tools", () => {
  it("lists every changed note page by page and reads long notes whole (review: #241)", async () => {
    const { toolDigestIO, writeDigest } = await import("../agents/defs/digester");
    for (let i = 0; i < 1200; i++) vault.set(`many/n${String(i).padStart(4, "0")}.md`, `# Note ${i}\nbody`);
    vault.set("long/big.md", `# Big\n${"x".repeat(60_000)}\n- [ ] the task at the very end`);
    const io = toolDigestIO({ callTool: (n, a) => callTool(n, a), readOwn: async (p) => vault.get(p)!, write: async (p, b) => void vault.set(p, b), since: 500, now: Date.UTC(2026, 9, 18), folder: "Digests" });
    expect((await io.list()).filter((e) => e.path.startsWith("many/"))).toHaveLength(1200);
    expect(await io.read("long/big.md")).toBe(vault.get("long/big.md"));
    const res = await writeDigest(io, { since: 500, now: Date.UTC(2026, 9, 18), lang: "en", folder: "Digests", formatDate: () => "d" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.body).toContain("the task at the very end");
  });
});

describe("protocol schema and committer output", () => {
  it("a JSON-ReAct turn is one of the agent's tools with its args, or the final answer", async () => {
    const { protocolSchema } = await import("../agents/protocol");
    const { validateSchema } = await import("../agents/schema");
    const tools = getAgent("charter")!.tools!;
    const schema = protocolSchema(tools, getAgent("charter")!.outputSchema);
    expect(validateSchema({ tool: "csv_parse", args: { text: "a,b\n1,2" } }, schema)).toEqual([]);
    expect(validateSchema({ final: { series: [{ type: "bar", data: [1] }] } }, schema)).toEqual([]);
    expect(validateSchema({ tool: "write_file", args: { path: "x", content: "y" } }, schema).length).toBeGreaterThan(0); // not its tool
    expect(validateSchema({ tool: "csv_parse", args: { text: "x", bogus: 1 } }, schema).length).toBeGreaterThan(0); // bad args
    expect(validateSchema({ final: { series: [] } }, schema).length).toBeGreaterThan(0); // final must match the agent's schema
    expect(validateSchema("prose", schema).length).toBeGreaterThan(0);
  });

  it("commitMessage keeps a clean subject and at most four short body lines", async () => {
    const { commitMessage } = await import("../agents/defs");
    expect(commitMessage("```\nfeat(x): add y.\n\nWhy: because.\n- detail one\n```")).toBe("feat(x): add y\n\nWhy: because.\n- detail one");
    expect(commitMessage("fix: z")).toBe("fix: z");
    expect(commitMessage(["fix: z", "", "1", "2", "3", "4", "5"].join("\n")).split("\n")).toHaveLength(6);
  });
});

describe("response cache and context", () => {
  it("an answer is reused only while the context is the same (review: #241)", async () => {
    localStorage.setItem("lumen.ai.cache", "on");
    const ex = fakeExecutor(() => reply('{"tags": ["kubernetes", "devops"]}'), { supportsSchema: () => false });
    registerExecutor(ex);
    const tagger = getAgent("tagger")!;
    const input = { text: "Kubernetes schedules containers across a cluster." };
    expect((await runAgent(tagger, input)).status).toBe("ok");
    const again = await runAgent(tagger, input);
    expect(again.steps.some((s) => s.kind === "cache")).toBe(true);
    expect(ex.calls).toHaveLength(1);
    // A new tag in the workspace: list_tags returns something else, so the model is asked again.
    vault.set("notes/new.md", "---\ntags: [platform-engineering]\n---\nnew");
    window.dispatchEvent(new CustomEvent("lumen-workspace-changed", { detail: { kind: "structure" } })); // as a save announces it
    const fresh = await runAgent(tagger, input);
    expect(fresh.steps.some((s) => s.kind === "cache")).toBe(false);
    expect(ex.calls).toHaveLength(2);
    localStorage.setItem("lumen.ai.cache", "off");
  });
});
