/**
 * Plan 5.11: approving an agent's change.
 *  - A change to the open document — saved or not — lands in its live text
 *    (through CodeMirror: Undo takes it back), never in the file under it.
 *  - Nothing changes before the approval.
 *  - A change whose text moved underneath is refused with the reason; the
 *    replaced text is relocated when it is still there exactly once, an
 *    insertion into a changed text is refused.
 *  - Several changes computed on the same text (one run) can be approved
 *    in any order: offsets are mapped through the approvals before them.
 *  - Suggesting mode: the approval is written as a tracked change
 *    attributed to the agent.
 *  - A real run: replace_range stages with the fingerprint of the run's
 *    document, and the approval applies it to the live document.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import type { AgentDefinition, ChangeProposal, Executor, ExecutorRequest, ExecutorResponse } from "../agents/types";

const storeState = { aiKey: null as string | null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null };
vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => storeState } }));
vi.mock("../ai/ollamaProvider", () => ({ isOllamaAvailable: async () => false, getBaseUrl: () => "http://localhost:11434", chatOllama: vi.fn(), chatOllamaStream: vi.fn() }));
vi.mock("../ai/localLlm", () => ({ localLlmAvailable: () => ({ available: false }), chatLocal: vi.fn(), chatLocalStream: vi.fn(), onLocalLlmProgress: () => () => {} }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../ui/PromptDialog", () => ({ uiConfirm: vi.fn(async () => false) }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

const files = new Map<string, string>();
const writes: string[] = [];
vi.mock("../storage/workspace", () => ({
  isOPFSAvailable: () => true,
  listWorkspace: async () => [...files.keys()].map((path) => ({ path, name: path.split("/").pop() })),
  readWorkspaceFile: async (p: string) => {
    if (!files.has(p)) throw new Error("ENOENT");
    return files.get(p)!;
  },
  writeWorkspaceFile: async (p: string, c: string) => {
    writes.push(p);
    files.set(p, c);
  },
  workspaceHasFile: async (p: string) => files.has(p),
  isAssetName: () => false,
}));
vi.mock("../storage/workspaceIndex", () => ({ searchWorkspace: async () => [], ensureIndex: async () => {}, indexedFiles: () => [] }));

import { approveStagedChange, clearStagedChanges, listStagedChanges, mapRange, rangeContext, rejectStagedChange, setDocumentApplier, stageChange, textFingerprint } from "../agents/staging";
import { createDocumentApplier, minimalEdit, type DocumentHost } from "../agents/documentApplier";
import { resolveAll } from "../editor/suggesting";
import { runAgent } from "../agents/runtime";
import { registerExecutor, resetExecutors } from "../agents/executors";
import { clearTrace } from "../agents/trace";
import { pickTools } from "../agents/tools";
import { setDocumentKeyProvider } from "../agents/docKey";

const views: EditorView[] = [];

/** The document key of the active document in `editor()` (`docKey.ts`). */
const ACTIVE = "doc-active";

/** The open document in a real CodeMirror view (with history), plus other tabs. */
function editor(initial: string, opts: { path?: string | null; suggesting?: boolean; tabs?: Array<{ id: string; path: string | null; text: string; key?: string }> } = {}) {
  const view = new EditorView({ state: EditorState.create({ doc: initial, extensions: [history()] }) });
  views.push(view);
  const tabs = opts.tabs ?? [];
  const state = { suggesting: !!opts.suggesting, key: ACTIVE, undoable: true };
  const host: DocumentHost = {
    active: () => ({ path: opts.path ?? null, text: view.state.doc.toString(), key: state.key }),
    tabs: () => tabs,
    editActive: (e) => (view.dispatch({ changes: e, userEvent: state.undoable ? "agent.apply" : "agent.apply.noHistory", annotations: state.undoable ? [] : [Transaction.addToHistory.of(false)] }), state.undoable),
    setTab: (id, text) => {
      tabs.find((t) => t.id === id)!.text = text;
    },
    suggesting: () => state.suggesting,
  };
  setDocumentApplier(createDocumentApplier(host));
  const text = () => view.state.doc.toString();
  /** The user types (a normal edit, in the undo history). */
  const type = (from: number, to: number, insert: string) => view.dispatch({ changes: { from, to, insert }, userEvent: "input.type" });
  return { view, host, tabs, text, type, state };
}

/** Stage a range change the way replace_range + the runtime do it on `doc` (surroundings, fingerprint, document key). */
function proposeRange(doc: string, from: number, to: number, after: string, meta: { path?: string | null; runId?: string; agentId?: string; docKey?: string | null } = {}) {
  const docKey = meta.docKey === null ? undefined : (meta.docKey ?? ACTIVE);
  const proposal: ChangeProposal = { kind: "range", path: meta.path ?? null, from, to, before: doc.slice(from, to), after, summary: "s", context: rangeContext(doc, from, to), basis: textFingerprint(doc), docKey };
  return stageChange(proposal, { tool: "replace_range", runId: meta.runId ?? "run1", agentId: meta.agentId ?? "proofreader" });
}

beforeEach(async () => {
  clearStagedChanges();
  files.clear();
  writes.length = 0;
  resetExecutors();
  await clearTrace();
});
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  resetExecutors();
  setDocumentKeyProvider(null);
});

describe("approving a change to the open document", () => {
  it("applies it to the live text of an unsaved document, and Undo takes it back", async () => {
    const doc = "Hello wrld, again.\n";
    const ed = editor(doc);
    const c = proposeRange(doc, 6, 10, "world");
    expect(ed.text()).toBe(doc); // proposing changes nothing
    const done = await approveStagedChange(c.id);
    expect(done).toMatchObject({ status: "applied", appliedTo: "document" });
    expect(ed.text()).toBe("Hello world, again.\n");
    expect(writes).toEqual([]); // the live text, not a file
    undo(ed.view);
    expect(ed.text()).toBe(doc);
  });

  it("writes nothing before approval, and nothing when the change is rejected", async () => {
    const doc = "alpha beta\n";
    const ed = editor(doc, { path: "notes/a.md" });
    files.set("notes/a.md", doc);
    const c = proposeRange(doc, 0, 5, "ALPHA", { path: "notes/a.md" });
    expect(listStagedChanges()).toHaveLength(1);
    expect(rejectStagedChange(c.id)?.status).toBe("rejected");
    expect(ed.text()).toBe(doc);
    expect(files.get("notes/a.md")).toBe(doc);
    expect(writes).toEqual([]);
  });

  it("refuses a change whose text moved underneath, with the reason", async () => {
    const doc = "keep this line\nfix teh typo\n";
    const ed = editor(doc);
    const c = proposeRange(doc, 19, 22, "the");
    ed.type(15, doc.length, "rewritten by the user\n"); // the text the agent changed is gone
    const done = await approveStagedChange(c.id);
    expect(done).toMatchObject({ status: "conflict", conflict: "doc-changed" });
    expect(done.error).toMatch(/changed since/);
    expect(ed.text()).toBe("keep this line\nrewritten by the user\n");
  });

  it("finds a change again by its surroundings when the user's edits moved it; refuses it when they changed them", async () => {
    const doc = "one two\n";
    const ed = editor(doc);
    const insert = proposeRange(doc, 8, 8, "three\n");
    const replace = proposeRange(doc, 4, 7, "2");
    ed.type(0, 0, "zero "); // shifts everything by 5
    expect(await approveStagedChange(insert.id)).toMatchObject({ status: "applied" });
    expect(ed.text()).toBe("zero one two\nthree\n");
    ed.type(9, 12, "TWO"); // the user rewrites the word the agent wanted to change
    expect(await approveStagedChange(replace.id)).toMatchObject({ status: "conflict", conflict: "doc-changed" });
    expect(ed.text()).toBe("zero one TWO\nthree\n");
  });

  it("maps offsets through earlier approvals, so one run's changes can be approved in any order", async () => {
    const doc = "one two three four";
    const ed = editor(doc);
    const a = proposeRange(doc, 4, 7, "2"); // "two"
    const end = proposeRange(doc, 18, 18, "!"); // an insertion at the end
    const b = proposeRange(doc, 8, 13, "3"); // "three"
    const both = proposeRange(doc, 4, 13, "2 and 3"); // overlaps a and b
    expect(await approveStagedChange(a.id)).toMatchObject({ status: "applied" });
    expect(await approveStagedChange(end.id)).toMatchObject({ status: "applied" });
    expect(await approveStagedChange(b.id)).toMatchObject({ status: "applied" });
    expect(ed.text()).toBe("one 2 3 four!");
    expect(await approveStagedChange(both.id)).toMatchObject({ status: "conflict", conflict: "overlap" });
    expect(ed.text()).toBe("one 2 3 four!");
  });

  it("in suggesting mode, records the approval as a tracked change by the agent", async () => {
    const doc = "Hello wrld.\n";
    const ed = editor(doc, { suggesting: true });
    const c = proposeRange(doc, 6, 10, "world", { agentId: "proofreader" });
    expect(await approveStagedChange(c.id)).toMatchObject({ status: "applied", asSuggestion: true });
    expect(ed.text()).toContain("{~~wrld~>world~~}");
    expect(ed.text()).toContain("{>>@AI proofreader<<}");
    expect(resolveAll(ed.text(), "accept")).toBe("Hello world.\n");
    expect(resolveAll(ed.text(), "reject")).toBe(doc);
  });

  it("puts a write_file to the open document into its live text, and refuses it over unsaved edits", async () => {
    files.set("notes/a.md", "old\n");
    const ed = editor("old\n", { path: "notes/a.md" });
    const c = stageChange({ kind: "file", path: "notes/a.md", before: "old\n", after: "new\n", summary: "s" }, { tool: "write_file" });
    expect(await approveStagedChange(c.id)).toMatchObject({ status: "applied", appliedTo: "document" });
    expect(ed.text()).toBe("new\n");
    expect(files.get("notes/a.md")).toBe("old\n"); // saving the document writes it
    ed.type(0, 0, "mine ");
    const stale = stageChange({ kind: "file", path: "notes/a.md", before: "new\n", after: "agent\n", summary: "s" }, { tool: "write_file" });
    expect(await approveStagedChange(stale.id)).toMatchObject({ status: "conflict", conflict: "open-unsaved" });
    expect(ed.text()).toBe("mine new\n");
  });

  it("applies a change for another open tab to that tab's text", async () => {
    const ed = editor("active doc\n", { path: "a.md", tabs: [{ id: "b.md", path: "b.md", text: "x y\n" }] });
    const c = proposeRange("x y\n", 2, 3, "z", { path: "b.md" });
    expect(await approveStagedChange(c.id)).toMatchObject({ status: "applied", appliedTo: "tab" });
    expect(ed.tabs[0].text).toBe("x z\n");
    expect(ed.text()).toBe("active doc\n");
    expect(writes).toEqual([]);
  });

  it("applies a change for an untitled document only to that document, even when another one holds the same text", async () => {
    // Two untitled documents made from the same template; the run worked on the one now in a background tab.
    const template = "# Weekly notes\nTODO: fill in\n";
    const ed = editor(template, { tabs: [{ id: "Untitled 2.md", path: null, text: template, key: "doc-source" }] });
    const c = proposeRange(template, 15, 28, "Shipped the review panel", { docKey: "doc-source" });
    expect(await approveStagedChange(c.id)).toMatchObject({ status: "applied", appliedTo: "tab" });
    expect(ed.tabs[0].text).toBe("# Weekly notes\nShipped the review panel\n");
    expect(ed.text()).toBe(template); // the active document is not the one the run worked on
  });

  it("refuses a change for an untitled document that is no longer open, or that does not say which document it was for", async () => {
    const doc = "same text\n";
    const ed = editor(doc);
    const closed = proposeRange(doc, 0, 4, "SAME", { docKey: "doc-closed" });
    expect(await approveStagedChange(closed.id)).toMatchObject({ status: "conflict", conflict: "not-open" });
    const unbound = proposeRange(doc, 0, 4, "SAME", { docKey: null });
    expect(await approveStagedChange(unbound.id)).toMatchObject({ status: "conflict", conflict: "not-open" });
    expect(ed.text()).toBe(doc);
  });

  it("says when the edit went in without an undo history (Preview / WYSIWYG)", async () => {
    const doc = "Hello wrld.\n";
    const ed = editor(doc);
    ed.state.undoable = false;
    const c = proposeRange(doc, 6, 10, "world");
    const done = await approveStagedChange(c.id);
    expect(done).toMatchObject({ status: "applied", appliedTo: "document", noUndo: true });
    expect(ed.text()).toBe("Hello world.\n");
    ed.state.undoable = true;
    const next = proposeRange(ed.text(), 0, 5, "Hi");
    expect((await approveStagedChange(next.id)).noUndo).toBeUndefined();
  });

  it("writes a change for a document that is not open to its workspace file", async () => {
    editor("active\n", { path: "a.md" });
    files.set("other.md", "abc\n");
    const file = stageChange({ kind: "file", path: "new.md", before: null, after: "hi\n", summary: "s" }, { tool: "write_file" });
    expect(await approveStagedChange(file.id)).toMatchObject({ status: "applied", appliedTo: "file" });
    expect(files.get("new.md")).toBe("hi\n");
    // Two changes computed on the same text, a few characters apart: the second is mapped through the first.
    const range = proposeRange("abc\n", 0, 1, "A", { path: "other.md" });
    const near = proposeRange("abc\n", 2, 3, "C", { path: "other.md" });
    expect(await approveStagedChange(range.id)).toMatchObject({ status: "applied", appliedTo: "file" });
    expect(await approveStagedChange(near.id)).toMatchObject({ status: "applied", appliedTo: "file" });
    expect(files.get("other.md")).toBe("AbC\n");
    const gone = proposeRange("x\n", 0, 1, "y", { path: "deleted.md" });
    expect(await approveStagedChange(gone.id)).toMatchObject({ status: "conflict", conflict: "file-changed", error: "the file no longer exists" });
  });
});

describe("a real run", () => {
  function fakeExecutor(script: (req: ExecutorRequest, n: number) => ExecutorResponse): Executor {
    let n = 0;
    return {
      id: "ollama",
      label: "fake",
      available: async () => ({ available: true }),
      supportsTools: () => false,
      supportsSchema: () => false,
      modelFor: (tier) => `fake-${tier}`,
      async chat(req) {
        return script(req, ++n);
      },
    };
  }
  const reply = (content: string): ExecutorResponse => ({ content, toolCalls: [], model: "fake-small" });

  it("stages replace_range with the run document's fingerprint; only the approval changes the live document", async () => {
    const doc = "# Title\nSome txet here.\n";
    const ed = editor(doc);
    registerExecutor(
      fakeExecutor((_req, n) =>
        n === 1 ? reply(JSON.stringify({ tool: "replace_range", args: { startLine: 2, text: "Some text here.", expected: "Some txet here." } })) : reply(JSON.stringify({ final: "fixed" })),
      ),
    );
    const def: AgentDefinition = { id: "proofreader", description: "t", system: "s", user: () => "go", tools: pickTools("replace_range"), requires: ["write"], language: "any", maxRetries: 0 };
    // The editor's key for the active document when the run starts.
    setDocumentKeyProvider(() => ed.state.key);
    const pending = runAgent(def, { text: doc }, { grants: ["write"], document: doc });
    ed.state.key = "doc-switched-to-mid-run"; // the run keeps the document it started on
    const run = await pending;
    ed.state.key = ACTIVE;
    expect(run.status).toBe("ok");
    const [change] = listStagedChanges({ runId: run.id });
    expect(change).toMatchObject({ kind: "range", basis: textFingerprint(doc), docKey: ACTIVE, agentId: "proofreader", status: "pending" });
    expect(ed.text()).toBe(doc); // the run proposed; nothing changed
    expect(await approveStagedChange(change.id)).toMatchObject({ status: "applied", appliedTo: "document" });
    expect(ed.text()).toBe("# Title\nSome text here.\n");
  });
});

describe("helpers", () => {
  it("mapRange shifts ranges after an edit and refuses overlaps", () => {
    const edit = { from: 4, to: 7, length: 1 };
    expect(mapRange(0, 3, edit)).toEqual({ from: 0, to: 3 });
    expect(mapRange(8, 13, edit)).toEqual({ from: 6, to: 11 });
    expect(mapRange(4, 4, edit)).toEqual({ from: 4, to: 4 });
    expect(mapRange(5, 9, edit)).toBeNull();
  });

  it("minimalEdit trims the common prefix and suffix without splitting a surrogate pair", () => {
    expect(minimalEdit("abcdef", "abXYef")).toEqual({ from: 2, to: 4, insert: "XY" });
    expect(minimalEdit("same", "same")).toEqual({ from: 4, to: 4, insert: "" });
    const e = minimalEdit("a😀b", "a😃b");
    expect("a😀b".slice(0, e.from) + e.insert + "a😀b".slice(e.to)).toBe("a😃b");
    expect(e.insert).toBe("😃");
  });
});
