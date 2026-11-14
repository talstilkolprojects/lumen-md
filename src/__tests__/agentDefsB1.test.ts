import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));
const files = new Map<string, string>();
vi.mock("../storage/workspace", () => ({
  isOPFSAvailable: () => files.size > 0,
  listWorkspace: async () => [...files.keys()].map((path) => ({ path, name: path.split("/").pop() })),
  readWorkspaceFile: async (p: string) => files.get(p) ?? "",
  writeWorkspaceFile: vi.fn(),
  workspaceHasFile: async (p: string) => files.has(p),
  isAssetName: () => false,
}));
vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));
vi.mock("../sync/git", () => ({ gitStatusSummary: vi.fn(async () => ({ entries: [{ state: "modified", path: "src/a.ts" }, { state: "added", path: "README.md" }] })) }));

import { registerExecutor, resetExecutors } from "../agents/executors";
import { runAgent } from "../agents/runtime";
import { fakeExecutor, sequence } from "./helpers/fakeExecutor";
import { normalizeTags, filterLinks, normalizeHeadings, cleanSubject, taggerAgent, linkerAgent, outlinerAgent, committerAgent } from "../agents/defs";
import { suggestTags, suggestLinks } from "../agents/commands";
import { generateOutline } from "../ai/outline";
import { generateAiCommitMessage } from "../ai/commands";
import { consumeAiPrompt } from "../billing/aiQuota";

beforeEach(() => {
  resetExecutors();
  files.clear();
  localStorage.setItem("lumen.ai.cache", "off");
});

describe("B1 helpers", () => {
  it("normalizeTags keeps Unicode tags, kebab-cases and dedupes", () => {
    expect(normalizeTags(["#Machine Learning", "machine-learning", " עברית ", "עברית", "a", "ok/path", "x".repeat(50)])).toEqual(["machine-learning", "עברית", "ok-path"]);
    expect(normalizeTags(Array.from({ length: 12 }, (_, i) => `t${i}`))).toHaveLength(7);
  });

  it("filterLinks keeps verbatim phrases that target listed notes, case-insensitively, at most 5", () => {
    const body = "We use attention in the Transformer paper.";
    const titles = ["Attention", "Transformer"];
    expect(filterLinks([{ phrase: "attention", target: "attention", reason: "r" }, { phrase: "nope", target: "Attention" }, { phrase: "Transformer", target: "Unknown" }], body, titles)).toEqual([
      { phrase: "attention", target: "Attention", reason: "r" },
    ]);
    expect(filterLinks("x", body, titles)).toEqual([]);
  });

  it("normalizeHeadings keeps paragraph starts only, clamps levels, sorts", () => {
    const text = "Intro line one\nstill intro\n\nSecond paragraph\nmore\n\nThird";
    expect(normalizeHeadings([{ level: 9, title: "C", line: 6 }, { level: 2, title: "A", line: 0 }, { level: 3, title: "mid", line: 1 }, { level: 2, title: "B", line: 3 }, { level: 2, title: "blank", line: 2 }], text)).toEqual([
      { level: 2, title: "A", line: 0 },
      { level: 2, title: "B", line: 3 },
      { level: 4, title: "C", line: 6 },
    ]);
  });

  it("cleanSubject takes the first line without quotes, at most 72 chars", () => {
    expect(cleanSubject('```\n"feat: add agents"\n\nbody\n```')).toBe("feat: add agents");
    expect(cleanSubject("x".repeat(100))).toHaveLength(72);
  });
});

describe("B1 agents end to end (fake executor)", () => {
  it("tagger: schema failure → retry → tags normalised; the workspace's tags come from its list_tags call (5.3)", async () => {
    files.set("notes/a.md", "---\ntags: [alpha, עברית]\n---\nbody");
    const ex = fakeExecutor(sequence('{"tags": []}', '{"tags": ["Alpha", "#new-topic", "עברית"]}'));
    registerExecutor(ex);
    expect(await suggestTags("some document")).toEqual(["alpha", "new-topic", "עברית"]);
    expect(ex.calls).toHaveLength(2);
    const listTags = ex.calls[0].messages.find((m) => m.role === "tool" && m.name === "list_tags");
    expect(listTags?.content).toContain('"tag":"alpha"');
    expect(listTags?.content).toContain('"tag":"עברית"');
    expect(ex.calls[0].messages[0].content).toContain('{"tags"');
    expect(taggerAgent.cache).toBe(true);
  });

  it("linker: the other notes come from its list_files call (5.3); empty list accepted; invalid suggestions retried then filtered", async () => {
    files.set("a.md", "This note mentions Attention a lot.");
    files.set("Attention.md", "Attention is all you need. More text.");
    files.set("Transformer.md", "A model architecture.");
    const ex = fakeExecutor(sequence('{"links": [{"phrase": "not in body", "target": "Attention", "reason": "x"}]}', '{"links": [{"phrase": "Attention", "target": "attention", "reason": "defines it"}, {"phrase": "Attention", "target": "Nope"}]}'));
    registerExecutor(ex);
    const links = await suggestLinks("a.md", "This note mentions Attention a lot.");
    expect(links).toEqual([{ phrase: "Attention", target: "Attention", reason: "defines it" }]);
    const listed = ex.calls[0].messages.find((m) => m.role === "tool" && m.name === "list_files");
    expect(listed?.content).toContain("Attention.md");
    expect(listed?.content).toContain("Transformer.md");
    expect(ex.calls).toHaveLength(2);
    registerExecutor(fakeExecutor(sequence('{"links": []}')));
    expect(await suggestLinks("a.md", "x")).toEqual([]);
    expect(linkerAgent.validators).toHaveLength(1);
  });

  it("outliner: numbered lines in the prompt; only paragraph-start headings survive; failure → []", async () => {
    const text = "Intro paragraph\nmore\n\nSecond part starts\nmore\n\nThird part\nend";
    const ex = fakeExecutor(sequence('{"headings": [{"level": 2, "title": "Intro", "line": 0}, {"level": 2, "title": "Second", "line": 3}, {"level": 3, "title": "bad", "line": 4}]}'));
    registerExecutor(ex);
    expect(await generateOutline(text)).toEqual([
      { level: 2, title: "Intro", line: 0 },
      { level: 2, title: "Second", line: 3 },
    ]);
    expect(ex.calls[0].messages[1].content).toContain("3: Second part starts");
    registerExecutor(fakeExecutor(sequence("not json")));
    expect(await generateOutline(text)).toEqual([]);
    expect(await generateOutline("short")).toEqual([]);
    expect(outlinerAgent.tier).toBe("small");
  });

  it("committer: a clean subject and a short body on the tiny tier, paid as its own prompt", async () => {
    const ex = fakeExecutor(sequence('"feat: add the agent runtime."\nExplanation here'));
    registerExecutor(ex);
    expect(await generateAiCommitMessage("/repo")).toBe("feat: add the agent runtime\n\nExplanation here");
    expect(ex.calls[0].tier).toBe("tiny");
    expect(ex.calls[0].messages[1].content).toContain("MODIFIED: src/a.ts");
    expect(consumeAiPrompt).toHaveBeenCalled();
    expect(committerAgent.maxRetries).toBe(1);
  });

  it("caches a validated answer and serves it without a model call", async () => {
    localStorage.removeItem("lumen.ai.cache");
    const ex = fakeExecutor(sequence('{"tags": ["cached-tag"]}'));
    registerExecutor(ex);
    const first = await runAgent(taggerAgent, { text: "doc to cache", extra: { existing: [] } });
    expect(first.status).toBe("ok");
    const second = await runAgent(taggerAgent, { text: "doc to cache", extra: { existing: [] } });
    expect(second.status).toBe("ok");
    expect(second.output).toEqual({ tags: ["cached-tag"] });
    // The context call comes first: the answer is reused only for the same tags (5.3).
    expect(second.steps.map((s) => s.kind)).toEqual(["tool", "cache"]);
    expect(ex.calls).toHaveLength(1);
    // A different input misses.
    await runAgent(taggerAgent, { text: "another doc", extra: { existing: [] } });
    expect(ex.calls).toHaveLength(2);
  });
});
