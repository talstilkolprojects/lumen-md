/**
 * Plan 5.11: the review panel for changes agents propose, its logic
 * (agents/review.ts) and the always-on part (hooks/useAgentReview.ts,
 * agents/reviewBridge.ts).
 *
 * Component tests stand in for the acceptance e2e where a browser is not
 * needed: an agent's change is never written without approval, approving
 * on an unsaved document applies it, a change whose file moved underneath
 * is refused with an explanation, and a cancelled run's proposals leave
 * the panel as they are withdrawn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import type { RefObject } from "react";

const files = new Map<string, string>();
const writes: string[] = [];
vi.mock("../storage/workspace", () => ({
  isOPFSAvailable: () => true,
  readWorkspaceFile: async (p: string) => {
    if (!files.has(p)) throw new Error("ENOENT");
    return files.get(p)!;
  },
  writeWorkspaceFile: async (p: string, c: string) => {
    writes.push(p);
    files.set(p, c);
  },
  workspaceHasFile: async (p: string) => files.has(p),
}));
vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));

import { AgentReviewPanel } from "../ui/AgentReviewPanel";
import { clearStagedChanges, discardRunChanges, getStagedChange, rangeContext, setDocumentApplier, stageChange, textFingerprint } from "../agents/staging";
import { createDocumentApplier } from "../agents/documentApplier";
import { approvalOrder, approveAll, inlineDiff, lineDiffRows, rejectAll, reviewModel } from "../agents/review";
import { useAgentReview } from "../hooks/useAgentReview";
import { editorDocumentHost, trackDocumentKeys } from "../agents/reviewBridge";
import { currentDocumentKey, setDocumentKeyProvider } from "../agents/docKey";
import { createDocumentKeys } from "../agents/documentKeys";
import { useAppStore } from "../store/useStore";
import { showAiToast } from "../ui/AiToast";
import type { EditorHandle } from "../editor/Editor";
import type { StagedChange } from "../agents/types";

let keys: ReturnType<typeof trackDocumentKeys> | null = null;

/** The store's active document (no editor mounted unless a view is given), wired the way the review bridge wires it. */
function openDocument(content: string, workspaceName: string | null = null, view: EditorView | null = null, extraTabs: Array<{ id: string; content: string; workspaceName?: string | null; dirty?: boolean }> = []) {
  keys?.stop();
  useAppStore.setState({
    doc: { name: workspaceName ?? "Untitled.md", content, workspaceName, dirty: true },
    openTabs: [
      { id: workspaceName ?? "Untitled.md", name: workspaceName ?? "Untitled.md", content, workspaceName, dirty: true },
      ...extraTabs.map((t) => ({ id: t.id, name: t.id, content: t.content, workspaceName: t.workspaceName ?? null, dirty: t.dirty ?? false })),
    ],
    suggestingMode: false,
  });
  keys = trackDocumentKeys();
  setDocumentKeyProvider(keys.active);
  const ref = { current: view ? ({ getView: () => view, insertText: () => {}, focus: () => {} } as EditorHandle) : null } as RefObject<EditorHandle | null>;
  setDocumentApplier(createDocumentApplier(editorDocumentHost(ref, keys)));
  return ref;
}

/** Select a tab the way the tab strip does (App.tsx `onSelect`). */
function selectTab(id: string) {
  const target = useAppStore.getState().openTabs.find((t) => t.id === id)!;
  useAppStore.getState().openTab({ name: target.name, content: target.content, workspaceName: target.workspaceName ?? null });
}

/** What replace_range + the runtime stage on `doc`: surroundings, fingerprint and the active document's key. */
function proposeRange(doc: string, from: number, to: number, after: string, meta: { runId?: string; agentId?: string; path?: string | null } = {}) {
  return stageChange(
    {
      kind: "range",
      path: meta.path ?? null,
      from,
      to,
      before: doc.slice(from, to),
      after,
      summary: `Replace “${doc.slice(from, to)}”`,
      context: rangeContext(doc, from, to),
      basis: textFingerprint(doc),
      docKey: currentDocumentKey(),
    },
    { tool: "replace_range", runId: meta.runId ?? "run_a", agentId: meta.agentId ?? "proofreader" },
  );
}

const content = () => useAppStore.getState().doc.content;
const card = (c: StagedChange) => screen.getByTestId(`agent-change-${c.id}`);

beforeEach(() => {
  clearStagedChanges();
  files.clear();
  writes.length = 0;
  vi.mocked(showAiToast).mockClear();
});
afterEach(() => {
  setDocumentApplier(null);
  setDocumentKeyProvider(null);
  keys?.stop();
  keys = null;
});

describe("AgentReviewPanel", () => {
  it("lists proposals by run with their diffs; nothing is written until Approve, which applies to the unsaved document", async () => {
    const doc = "Hello wrld.\n";
    openDocument(doc);
    files.set("notes/b.md", "one\ntwo\n");
    const range = proposeRange(doc, 6, 10, "world");
    const file = stageChange({ kind: "file", path: "notes/b.md", before: "one\ntwo\n", after: "one\n2\n", summary: "Overwrite notes/b.md" }, { tool: "write_file", runId: "run_a", agentId: "proofreader" });
    render(<AgentReviewPanel open onClose={() => {}} />);

    expect(screen.getAllByTestId("agent-review-group")).toHaveLength(1);
    expect(screen.getByText("Proposed by proofreader")).toBeTruthy();
    const inline = within(card(range)).getByTestId("agent-change-inline");
    expect(inline.querySelector("del")?.textContent).toBe("wrld");
    expect(inline.querySelector("ins")?.textContent).toBe("world");
    const lines = within(card(file)).getByTestId("agent-change-lines");
    expect([...lines.querySelectorAll("[data-op]")].map((el) => `${el.getAttribute("data-op")}:${el.textContent?.slice(1)}`)).toEqual(["eq:one", "del:two", "add:2"]);

    // Shown, not written.
    expect(content()).toBe(doc);
    expect(writes).toEqual([]);

    fireEvent.click(within(card(range)).getByTestId("agent-change-approve"));
    await waitFor(() => expect(card(range).getAttribute("data-status")).toBe("applied"));
    expect(content()).toBe("Hello world.\n");
    expect(useAppStore.getState().doc.dirty).toBe(true);
    // No source editor is mounted (Preview / WYSIWYG): the panel does not promise Undo.
    expect(within(card(range)).getByTestId("agent-change-outcome").textContent).toBe("Applied to the document, not saved yet. Undo can't take it back in this view.");
    expect(files.get("notes/b.md")).toBe("one\ntwo\n"); // the other proposal is still waiting
    expect(card(file).getAttribute("data-status")).toBe("pending");
  });

  it("shows a change that only removes the final newline, with git's marker", () => {
    openDocument("open\n", "open.md");
    const c = stageChange({ kind: "file", path: "notes/eol.md", before: "last line\n", after: "last line", summary: "s" }, { tool: "write_file" });
    render(<AgentReviewPanel open onClose={() => {}} />);
    const lines = within(card(c)).getByTestId("agent-change-lines");
    expect([...lines.querySelectorAll("[data-op]")].map((el) => el.getAttribute("data-op"))).toEqual(["del", "add"]);
    expect(within(lines).getByTestId("agent-change-no-eol").textContent).toBe("No newline at end of file");
  });

  it("Reject writes nothing and says so", async () => {
    files.set("a.md", "x\n");
    openDocument("open\n", "open.md");
    const c = stageChange({ kind: "file", path: "a.md", before: "x\n", after: "y\n", summary: "s" }, { tool: "write_file", agentId: "builder" });
    render(<AgentReviewPanel open onClose={() => {}} />);
    fireEvent.click(within(card(c)).getByTestId("agent-change-reject"));
    await waitFor(() => expect(card(c).getAttribute("data-status")).toBe("rejected"));
    expect(within(card(c)).getByTestId("agent-change-outcome").textContent).toBe("Rejected — nothing was written.");
    expect(files.get("a.md")).toBe("x\n");
    expect(writes).toEqual([]);
  });

  it("refuses, with an explanation, a change whose file changed underneath", async () => {
    files.set("notes/c.md", "agent saw this\n");
    openDocument("open\n", "open.md");
    const c = stageChange({ kind: "file", path: "notes/c.md", before: "agent saw this\n", after: "agent wrote this\n", summary: "s" }, { tool: "write_file" });
    files.set("notes/c.md", "someone else wrote this\n");
    render(<AgentReviewPanel open onClose={() => {}} />);
    fireEvent.click(within(card(c)).getByTestId("agent-change-approve"));
    await waitFor(() => expect(card(c).getAttribute("data-status")).toBe("conflict"));
    expect(within(card(c)).getByTestId("agent-change-outcome").textContent).toBe("Not written: the file changed after the agent proposed this.");
    expect(files.get("notes/c.md")).toBe("someone else wrote this\n");
  });

  it("Approve all applies every change of a run to the live document; Reject all rejects the rest", async () => {
    const doc = "one two three\n";
    openDocument(doc);
    proposeRange(doc, 0, 3, "1");
    proposeRange(doc, 8, 13, "3");
    proposeRange(doc, 4, 7, "2");
    render(<AgentReviewPanel open onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("agent-review-approve-all"));
    await waitFor(() => expect(content()).toBe("1 2 3\n"));
    expect(screen.getByTestId("agent-review-empty")).toBeTruthy();

    const later = proposeRange("1 2 3\n", 0, 1, "uno", { runId: "run_b" });
    await waitFor(() => expect(screen.getByTestId("agent-review-reject-all")).toBeTruthy());
    fireEvent.click(screen.getByTestId("agent-review-reject-all"));
    await waitFor(() => expect(getStagedChange(later.id)?.status).toBe("rejected"));
    expect(content()).toBe("1 2 3\n");
  });

  it("follows the queue live: a cancelled run's proposals leave the pending list as withdrawn", async () => {
    const doc = "abc\n";
    openDocument(doc);
    render(<AgentReviewPanel open onClose={() => {}} />);
    expect(screen.getByTestId("agent-review-empty")).toBeTruthy();
    let c!: StagedChange;
    act(() => {
      c = proposeRange(doc, 0, 1, "A", { runId: "run_cancel" });
    });
    expect(within(card(c)).getByTestId("agent-change-approve")).toBeTruthy();
    act(() => {
      discardRunChanges("run_cancel");
    });
    expect(card(c).getAttribute("data-status")).toBe("rejected");
    expect(within(card(c)).queryByTestId("agent-change-approve")).toBeNull();
    expect(within(card(c)).getByTestId("agent-change-outcome").textContent).toBe("Withdrawn: the run was cancelled.");
    expect(screen.getByTestId("agent-review-empty")).toBeTruthy();
    expect(content()).toBe(doc);
  });
});

describe("editorDocumentHost (the store and the editor)", () => {
  it("goes through CodeMirror when the source editor shows the document, so Undo takes the change back", async () => {
    const doc = "teh end\n";
    const view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [history(), EditorView.updateListener.of((u) => u.docChanged && useAppStore.getState().setContent(u.state.doc.toString()))],
      }),
    });
    openDocument(doc, null, view);
    const { approveStagedChange } = await import("../agents/staging");
    const c = proposeRange(doc, 0, 3, "the");
    const done = await approveStagedChange(c.id);
    expect(done).toMatchObject({ status: "applied", appliedTo: "document" });
    expect(done.noUndo).toBeUndefined();
    expect(view.state.doc.toString()).toBe("the end\n");
    expect(content()).toBe("the end\n");
    undo(view);
    expect(content()).toBe(doc);
    view.destroy();
  });

  it("applies a change for a background tab to that tab's text", async () => {
    openDocument("active\n", "a.md");
    useAppStore.setState((s) => ({ openTabs: [...s.openTabs, { id: "b.md", name: "b.md", content: "x y\n", workspaceName: "b.md", dirty: false }] }));
    const { approveStagedChange } = await import("../agents/staging");
    const c = proposeRange("x y\n", 2, 3, "z", { path: "b.md" });
    expect(await approveStagedChange(c.id)).toMatchObject({ status: "applied", appliedTo: "tab" });
    expect(useAppStore.getState().openTabs.find((t) => t.id === "b.md")).toMatchObject({ content: "x z\n", dirty: true });
    expect(content()).toBe("active\n");
    expect(writes).toEqual([]);
  });

  it("keeps a background tab's approved change unsaved when the tab is selected, so autosave writes it", async () => {
    openDocument("active\n", "a.md", null, [{ id: "b.md", workspaceName: "b.md", content: "x y\n" }]);
    const { approveStagedChange } = await import("../agents/staging");
    const c = proposeRange("x y\n", 2, 3, "z", { path: "b.md" });
    expect(await approveStagedChange(c.id)).toMatchObject({ status: "applied", appliedTo: "tab" });
    selectTab("b.md");
    expect(useAppStore.getState().doc).toMatchObject({ workspaceName: "b.md", content: "x z\n", dirty: true });
    selectTab("a.md");
    expect(useAppStore.getState().openTabs.find((t) => t.id === "b.md")).toMatchObject({ content: "x z\n", dirty: true });
  });

  it("applies a change for an untitled document to that document after switching to another one made from the same template", async () => {
    const template = "# Weekly notes\nTODO: fill in\n";
    openDocument(template, null, null, [{ id: "Untitled 2.md", content: template }]);
    const { approveStagedChange } = await import("../agents/staging");
    const c = proposeRange(template, 15, 28, "Shipped the review panel"); // the run worked on "Untitled.md"
    selectTab("Untitled 2.md");
    expect(await approveStagedChange(c.id)).toMatchObject({ status: "applied", appliedTo: "tab" });
    expect(content()).toBe(template); // the active document is untouched
    selectTab("Untitled.md");
    expect(useAppStore.getState().doc).toMatchObject({ content: "# Weekly notes\nShipped the review panel\n", dirty: true });
    // Switching away and back does not lose the document: a second change still lands.
    const again = proposeRange(content(), 0, 1, "##");
    selectTab("Untitled 2.md");
    selectTab("Untitled.md");
    expect(await approveStagedChange(again.id)).toMatchObject({ status: "applied", appliedTo: "document" });
    expect(content()).toBe("## Weekly notes\nShipped the review panel\n");
  });

  it("refuses a change for an untitled document that was closed, even when one with the same name and text is open now", async () => {
    const template = "# Draft\n";
    openDocument(template, null, null, [{ id: "other.md", workspaceName: "other.md", content: "other\n" }]);
    const { approveStagedChange } = await import("../agents/staging");
    const c = proposeRange(template, 2, 7, "Plan");
    selectTab("other.md");
    useAppStore.getState().closeTab("Untitled.md");
    useAppStore.getState().openTab({ name: "Untitled.md", content: template, workspaceName: null });
    expect(await approveStagedChange(c.id)).toMatchObject({ status: "conflict", conflict: "not-open" });
    expect(content()).toBe(template);
  });
});

describe("document keys", () => {
  const state = (doc: { name: string; content: string; loadId?: number; workspaceName?: string | null }, tabs: Array<{ id: string; content: string }>) => ({ doc, openTabs: tabs });

  it("follow a document across tab switches and saving it into the workspace; a new document gets a new key", () => {
    const k = createDocumentKeys();
    k.observe(state({ name: "Untitled.md", content: "a", loadId: 1 }, [{ id: "Untitled.md", content: "a" }, { id: "b.md", content: "b" }]));
    const a = k.active();
    k.observe(state({ name: "Untitled.md", content: "a!", loadId: 1 }, [{ id: "Untitled.md", content: "a!" }, { id: "b.md", content: "b" }])); // typing
    expect(k.active()).toBe(a);
    k.observe(state({ name: "b.md", workspaceName: "b.md", content: "b", loadId: 2 }, [{ id: "Untitled.md", content: "a!" }, { id: "b.md", content: "b" }])); // switch to b
    const b = k.active();
    expect(b).not.toBe(a);
    expect(k.tab("Untitled.md")).toBe(a);
    k.observe(state({ name: "Untitled.md", content: "a!", loadId: 3 }, [{ id: "Untitled.md", content: "a!" }, { id: "b.md", content: "b" }])); // back: a new load of the same tab
    expect(k.active()).toBe(a);
    k.observe(state({ name: "notes/a.md", workspaceName: "notes/a.md", content: "a!", loadId: 3 }, [{ id: "notes/a.md", content: "a!" }, { id: "b.md", content: "b" }])); // saved into the workspace
    expect(k.active()).toBe(a);
    k.observe(state({ name: "notes/a.md", workspaceName: "notes/a.md", content: "", loadId: 4 }, [{ id: "notes/a.md", content: "" }, { id: "b.md", content: "b" }])); // a different document loaded in place
    expect(k.active()).not.toBe(a);
    expect(k.tab("b.md")).toBe(b);
  });
});

describe("useAgentReview", () => {
  it("registers the applier, counts what waits, and announces a burst once with a Review action", async () => {
    openDocument("abc\n");
    setDocumentApplier(null);
    setDocumentKeyProvider(null);
    const open = vi.fn();
    const ref = { current: null } as RefObject<EditorHandle | null>;
    const { result } = renderHook(() => useAgentReview(ref, open));
    // The hook loads the bridge on its own; it then gives runs the active document's key.
    await waitFor(() => expect(currentDocumentKey()).toBeDefined());
    act(() => {
      proposeRange("abc\n", 0, 1, "A", { runId: "r1", agentId: "writer" });
      proposeRange("abc\n", 2, 3, "C", { runId: "r1", agentId: "writer" });
    });
    await waitFor(() => expect(result.current).toBe(2));
    await waitFor(() => expect(showAiToast).toHaveBeenCalledTimes(1));
    const [message, , opts] = vi.mocked(showAiToast).mock.calls[0];
    expect(message).toBe("writer proposed 2 changes. Nothing is written until you approve them.");
    opts?.action?.onClick();
    expect(open).toHaveBeenCalled();
    // The applier it registered applies to the store's document.
    const { approveStagedChange, listStagedChanges } = await import("../agents/staging");
    await approveAll(listStagedChanges(), approveStagedChange);
    expect(content()).toBe("AbC\n");
    await waitFor(() => expect(result.current).toBe(0));
  });
});

describe("review logic", () => {
  const base = { tool: "replace_range", status: "pending" as const, summary: "s", path: null, before: "", after: "" };
  const range = (id: string, from: number, createdAt: number, extra: Partial<StagedChange> = {}) => ({ ...base, kind: "range" as const, id, from, to: from, createdAt, ...extra }) as StagedChange;

  it("groups pending changes by run (oldest first) and lists settled ones newest first", () => {
    const list = [range("a", 0, 1, { runId: "r1", agentId: "x" }), range("b", 5, 2, { runId: "r2" }), range("c", 9, 3, { runId: "r1" }), range("d", 1, 4, { status: "applied" }), range("e", 1, 5, { status: "conflict" })];
    const m = reviewModel(list);
    expect(m.pendingCount).toBe(3);
    expect(m.pending.map((g) => [g.key, g.changes.map((c) => c.id)])).toEqual([["r1", ["a", "c"]], ["r2", ["b"]]]);
    expect(m.settled.map((c) => c.id)).toEqual(["e", "d"]);
  });

  it("approves file changes first, then ranges from the end of the text backwards", () => {
    const file = { ...base, kind: "file", id: "f", path: "p", createdAt: 9 } as StagedChange;
    expect(approvalOrder([range("a", 0, 1), range("b", 10, 2), file, range("c", 5, 3)]).map((c) => c.id)).toEqual(["f", "b", "c", "a"]);
  });

  it("rejectAll rejects only pending changes", () => {
    const a = stageChange({ kind: "file", path: "a", before: null, after: "a", summary: "s" }, { tool: "write_file" });
    const b = stageChange({ kind: "file", path: "b", before: null, after: "b", summary: "s" }, { tool: "write_file" });
    expect(rejectAll([a, b, { ...b, status: "applied" } as StagedChange])).toBe(2);
  });

  it("lineDiffRows keeps context around changes and collapses the rest", () => {
    const rows = lineDiffRows("a\nb\nc\nd\ne\nf\ng\n", "a\nb\nc\nD\ne\nf\ng\n", 1);
    expect(rows).toEqual([
      { op: "gap", skipped: 2 },
      { op: "eq", text: "c", a: 3, b: 3 },
      { op: "del", text: "d", a: 4, b: undefined },
      { op: "add", text: "D", a: undefined, b: 4 },
      { op: "eq", text: "e", a: 5, b: 5 },
      { op: "gap", skipped: 2 },
    ]);
    expect(lineDiffRows(null, "new\n")).toEqual([{ op: "add", text: "new", a: undefined, b: 1 }]);
  });

  it("lineDiffRows shows a change of only the final newline, marked like git's \"No newline at end of file\"", () => {
    expect(lineDiffRows("abc\n", "abc")).toEqual([
      { op: "del", text: "abc", a: 1, b: undefined },
      { op: "add", text: "abc", a: undefined, b: 1, noEol: true },
    ]);
    expect(lineDiffRows("x\nabc", "x\nabc\n")).toEqual([
      { op: "eq", text: "x", a: 1, b: 1 },
      { op: "del", text: "abc", a: 2, b: undefined, noEol: true },
      { op: "add", text: "abc", a: undefined, b: 2 },
    ]);
    expect(lineDiffRows("same\n", "same\n")).toEqual([{ op: "gap", skipped: 1 }]); // nothing changed
    // Only the line endings changed (LF → CRLF): a change, with the CR shown as ^M.
    expect(lineDiffRows("a\n", "a\r\n")).toEqual([
      { op: "del", text: "a", a: 1, b: undefined },
      { op: "add", text: "a^M", a: undefined, b: 1 },
    ]);
  });

  it("inlineDiff reads like a tracked change: removed words, then added ones", () => {
    expect(inlineDiff("the quick fox", "the slow fox")).toEqual([
      { op: "eq", text: "the " },
      { op: "del", text: "quick" },
      { op: "add", text: "slow" },
      { op: "eq", text: " fox" },
    ]);
    expect(inlineDiff("", "שלום")).toEqual([{ op: "add", text: "שלום" }]);
    expect(inlineDiff("כתוב שגיאה כאן", "כתוב טוב כאן").filter((p) => p.op !== "eq")).toEqual([
      { op: "del", text: "שגיאה" },
      { op: "add", text: "טוב" },
    ]);
  });
});
