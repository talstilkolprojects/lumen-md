/**
 * `[[` completion in the source editor (4.5): the CodeMirror source over
 * the real workspace index (in-memory OPFS), applying a pick, creating a
 * note, staying out of code — and living next to the TypeScript checks'
 * completion source (two `override`s would throw on a config conflict).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { CompletionContext, type Completion, type CompletionResult } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { readWorkspaceFile, workspaceHasEntry, writeWorkspaceFile } from "../storage/workspace";
import { __resetWorkspaceIndex } from "../storage/workspaceIndex";
import { WORKSPACE_CHANGED } from "../storage/workspaceEvents";
import { wikiLinkAutocomplete, wikiLinkSource } from "../editor/wikiLinkAutocomplete";
import { tsCheckExtension } from "../editor/tsCheckExtension";
import { createLinkedNote } from "../editor/wikiLinkData";
import type { TsClient } from "../lsp/tsClient";

vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));

// jsdom has no layout; CodeMirror's scrollIntoView measures Range rects.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} }) as DOMRect;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= zeroRect;

beforeAll(async () => {
  installFakeOpfs();
  __resetWorkspaceIndex();
  await writeWorkspaceFile("Project Alpha.md", "---\naliases: [Alpha]\n---\n# Project Alpha\n\n## Goals\n\nShip. ^ship\n");
  await writeWorkspaceFile("שלום עולם.md", "# שלום\n");
  await writeWorkspaceFile("work/Notes.md", "");
});

function viewOf(doc: string, caret = doc.length): EditorView {
  return new EditorView({ state: EditorState.create({ doc, selection: { anchor: caret }, extensions: [markdown(), wikiLinkAutocomplete()] }) });
}

async function complete(view: EditorView): Promise<CompletionResult | null> {
  return (await wikiLinkSource(new CompletionContext(view.state, view.state.selection.main.head, false))) as CompletionResult | null;
}

async function pick(view: EditorView, label: string): Promise<string> {
  const res = await complete(view);
  const option = res?.options.find((o) => o.label === label);
  if (!option) throw new Error(`no option ${label}: ${res?.options.map((o) => o.label).join(", ")}`);
  (option.apply as (v: EditorView, c: Completion, from: number, to: number) => void)(view, option, res!.from, view.state.selection.main.head);
  const { doc, selection } = view.state;
  return doc.sliceString(0, selection.main.head) + "|" + doc.sliceString(selection.main.head);
}

describe("source editor [[ completion", () => {
  it("offers notes by noteKey and inserts the link", async () => {
    const view = viewOf("See [[proj");
    const res = await complete(view);
    expect(res?.from).toBe(6);
    expect(res?.filter).toBe(false);
    expect(res?.options[0]).toMatchObject({ label: "Project Alpha", type: "wiki-note" });
    expect(await pick(view, "Project Alpha")).toBe("See [[Project Alpha]]|");
  });

  it("Hebrew with niqqud, inside brackets closeBrackets typed", async () => {
    const doc = "כתבתי [[שָׁלוֹ]] היום";
    const view = viewOf(doc, doc.indexOf("]]"));
    expect(await pick(view, "שלום עולם")).toBe("כתבתי [[שלום עולם]]| היום");
  });

  it("headings and aliases; no block links until 4.8", async () => {
    expect(await pick(viewOf("[[Project Alpha#go"), "Goals")).toBe("[[Project Alpha#Goals]]|");
    expect(await complete(viewOf("[[Project Alpha^sh"))).toBeNull();
    expect(await complete(viewOf("[[Project Alpha#^sh"))).toBeNull();
    expect(await pick(viewOf("[[alph"), "Alpha")).toBe("[[Project Alpha|Alpha]]|");
    const res = await complete(viewOf("[[alph"));
    expect(res?.options.find((o) => o.label === "Alpha")?.detail).toBe("alias of Project Alpha");
  });

  it("creates the note when none has the name, and links it", async () => {
    const view = viewOf("[[Brand New");
    const res = await complete(view);
    expect(res?.options.map((o) => o.label)).toEqual(["Create note «Brand New»"]);
    const changed = vi.fn();
    window.addEventListener(WORKSPACE_CHANGED, changed);
    expect(await pick(view, "Create note «Brand New»")).toBe("[[Brand New]]|");
    await vi.waitFor(async () => expect(await workspaceHasEntry("Brand New.md")).toBe(true));
    expect(await readWorkspaceFile("Brand New.md")).toBe("# Brand New\n\n");
    expect(changed).toHaveBeenCalled();
    window.removeEventListener(WORKSPACE_CHANGED, changed);
  });

  it("never overwrites a note the index hadn't seen yet", async () => {
    await writeWorkspaceFile("Unseen.md", "keep me");
    expect(await createLinkedNote("Unseen.md")).toBe(false);
    expect(await readWorkspaceFile("Unseen.md")).toBe("keep me");
  });

  it("nothing outside an open link or inside code", async () => {
    expect(await complete(viewOf("no link [here"))).toBeNull();
    expect(await complete(viewOf("[[Done]] after"))).toBeNull();
    expect(await complete(viewOf("```\n[[proj"))).toBeNull();
    expect(await complete(viewOf("Use `[[proj"))).not.toBeNull(); // an unclosed backtick is no code span
    expect(await complete(viewOf("Use `x` and `[[proj`", "Use `x` and `[[proj".length))).toBeNull();
  });

  it("Ctrl-Space reopens the list inside [[ and is left to the AI ghost text elsewhere", () => {
    const ctrlSpace = (v: EditorView) => runScopeHandlers(v, new KeyboardEvent("keydown", { key: " ", code: "Space", ctrlKey: true }), "editor");
    expect(ctrlSpace(viewOf("plain text"))).toBe(false);
    expect(ctrlSpace(viewOf("See [[pro"))).toBe(true);
  });

  it("lives next to the TypeScript checks' completions", () => {
    const client: TsClient = { check: vi.fn(async () => []), complete: vi.fn(async () => []), hover: vi.fn(async () => null), dispose: vi.fn() };
    const state = EditorState.create({ doc: "[[x", extensions: [markdown({ completeHTMLTags: false }), wikiLinkAutocomplete(), tsCheckExtension(client)] });
    expect(state.languageDataAt("autocomplete", 3)).toHaveLength(2);
  });
});
