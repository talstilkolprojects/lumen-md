/**
 * Wiki links in the WYSIWYG editor (4.5): `[[Note]]` is written back as
 * is (Milkdown alone escaped it to `\[\[Note]]`), and `[[` completes notes
 * there too, over the same index, inserting the same link.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Editor, defaultValueCtx, editorViewCtx, prosePluginsCtx, remarkStringifyOptionsCtx, rootCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { getMarkdown } from "@milkdown/utils";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { workspaceHasEntry, writeWorkspaceFile } from "../storage/workspace";
import { __resetWorkspaceIndex } from "../storage/workspaceIndex";
import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { keepWikiLinks, unescapeWikiLinks } from "../editor/wysiwygWikiLinks";
import { wysiwygWikiComplete } from "../editor/wysiwygWikiComplete";
import WysiwygEditor from "../editor/WysiwygEditor";
import { getActiveWysiwygView } from "../editor/wysiwygSuggest";
import { noteCatalog, type NoteCatalog } from "../editor/wikiComplete";
import * as linkData from "../editor/wikiLinkData";
import { useAppStore } from "../store/useStore";

vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));
vi.mock("../ai/llm", () => ({
  chat: vi.fn(),
  chatStream: vi.fn(),
  AiError: class AiError extends Error {},
}));

// jsdom has no layout; ProseMirror's scrollIntoView measures Range rects.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} }) as DOMRect;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= zeroRect;

let editors: Editor[] = [];
afterEach(async () => {
  cleanup();
  for (const e of editors) await e.destroy();
  editors = [];
  document.body.innerHTML = "";
});

async function make(md: string, opts: { fix?: boolean; complete?: boolean } = {}): Promise<{ editor: Editor; view: EditorView }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const m = Editor.make().config((ctx) => {
    ctx.set(rootCtx, host);
    ctx.set(defaultValueCtx, md);
    if (opts.fix !== false) ctx.update(remarkStringifyOptionsCtx, keepWikiLinks);
    if (opts.complete) ctx.update(prosePluginsCtx, (ps) => [...ps, wysiwygWikiComplete()]);
  });
  const editor = await m.use(commonmark).use(gfm).create();
  editors.push(editor);
  return { editor, view: editor.action((ctx) => ctx.get(editorViewCtx)) };
}

describe("wiki links through the WYSIWYG serializer", () => {
  it("Milkdown alone escapes them; with the fix they round-trip", async () => {
    const src = "See [[Foo Bar]], [[שלום#כותרת|x]] and [[a/b#^id]].\n";
    expect((await make(src, { fix: false })).editor.action(getMarkdown())).toContain("\\[\\[Foo Bar]]");
    expect((await make(src)).editor.action(getMarkdown())).toBe(src);
  });

  it("keeps escapes that matter, and code as is", async () => {
    expect(unescapeWikiLinks("\\[\\[x]](y) \\[\\[open \\[\\[a]] \\[[b]]")).toBe("\\[\\[x]](y) \\[\\[open [[a]] [[b]]");
    const src = "Literal `[[x]]` and [[y]] in a table:\n\n| a | b |\n| - | - |\n| [[n]] | c |\n";
    const out = (await make(src)).editor.action(getMarkdown());
    expect(out).toContain("`[[x]]`");
    expect(out).toContain("[[y]]");
    expect(out).toContain("| [[n]] |");
  });
});

describe("escaped wiki links in the WYSIWYG editor", () => {
  it("a deliberately escaped \\[\\[x]] stays escaped; real links and code stay as written", async () => {
    const onChange = vi.fn();
    const src = "Literal \\[\\[example]], real [[Note]], `\\[\\[code]]`, \\[[half]] and \\\\[[after a backslash]] end";
    render(createElement(WysiwygEditor, { value: src, onChange }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    const view = getActiveWysiwygView()!;
    await act(async () => {
      view.dispatch(view.state.tr.insertText("!", view.state.doc.content.size - 1));
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(onChange).toHaveBeenLastCalledWith(
      "Literal \\[\\[example]], real [[Note]], `\\[\\[code]]`, \\[\\[half]] and \\\\[[after a backslash]] end!\n",
    );
  });
});

describe("[[ completion in WYSIWYG", () => {
  beforeAll(async () => {
    installFakeOpfs();
    __resetWorkspaceIndex();
    await writeWorkspaceFile("Project Alpha.md", "# Project Alpha\n\n## Goals\n");
    await writeWorkspaceFile("שלום עולם.md", "# שלום\n");
  });

  const menu = () => document.querySelector<HTMLElement>("[data-testid='wiki-complete-menu']")!;
  const type = (view: EditorView, text: string) => {
    view.dispatch(view.state.tr.insertText(text));
  };
  const key = (view: EditorView, k: string) =>
    view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key: k, cancelable: true })));
  const caretToEnd = (view: EditorView) => view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));

  it("shows notes matched by noteKey and inserts the link with Enter", async () => {
    const { editor, view } = await make("Hello", { complete: true });
    caretToEnd(view);
    type(view, " [[proj");
    await vi.waitFor(() => expect(menu().dataset.show).toBe("true"));
    expect(menu().getAttribute("role")).toBe("listbox");
    expect([...menu().querySelectorAll(".slash-label")].map((n) => n.textContent)[0]).toBe("Project Alpha");
    expect(key(view, "Enter")).toBe(true);
    expect(menu().dataset.show).toBe("false");
    expect(editor.action(getMarkdown())).toBe("Hello [[Project Alpha]]\n");
  });

  it("Hebrew with niqqud, headings, Esc, and creating a note", async () => {
    const { editor, view } = await make("", { complete: true });
    type(view, "[[שָׁלוֹ");
    await vi.waitFor(() => expect(menu().textContent).toContain("שלום עולם"));
    key(view, "Tab");
    type(view, " [[Project Alpha#go");
    await vi.waitFor(() => expect(menu().textContent).toContain("Goals"));
    key(view, "Enter");
    expect(editor.action(getMarkdown())).toBe("[[שלום עולם]] [[Project Alpha#Goals]]\n");

    type(view, " [[x");
    await vi.waitFor(() => expect(menu().dataset.show).toBe("true"));
    expect(key(view, "Escape")).toBe(true);
    expect(menu().dataset.show).toBe("false");
    type(view, "y");
    await new Promise((r) => setTimeout(r, 30));
    expect(menu().dataset.show).toBe("false"); // closed for this link

    type(view, " [[Fresh Idea");
    await vi.waitFor(() => expect(menu().textContent).toContain("Create note «Fresh Idea»"));
    key(view, "Enter");
    expect(editor.action(getMarkdown())).toContain("[[Fresh Idea]]");
    await vi.waitFor(async () => expect(await workspaceHasEntry("Fresh Idea.md")).toBe(true));
  });

  it("[[# offers the headings in the editor now, not the store's older copy", async () => {
    useAppStore.setState((st) => ({ doc: { ...st.doc, content: "# Stale\n", workspaceName: null } }));
    const { view } = await make("# Fresh\n\ntext", { complete: true });
    caretToEnd(view);
    type(view, " [[#");
    await vi.waitFor(() => expect(menu().dataset.show).toBe("true"));
    expect([...menu().querySelectorAll(".slash-label")].map((n) => n.textContent)).toEqual(["Fresh"]);
  });

  it("a blur while the notes load drops the answer: no popup over an unfocused editor", async () => {
    let release!: (c: NoteCatalog) => void;
    const spy = vi.spyOn(linkData, "linkCatalog").mockImplementationOnce(() => new Promise<NoteCatalog>((r) => (release = r)));
    const { view } = await make("", { complete: true });
    type(view, "[[proj");
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    view.dom.dispatchEvent(new FocusEvent("blur"));
    release(noteCatalog([{ path: "Project Alpha.md", content: "", modified: 0 }]));
    await new Promise((r) => setTimeout(r, 30));
    expect(menu().dataset.show).toBe("false");
    spy.mockRestore();
  });

  it("not inside code", async () => {
    const { view } = await make("```\ncode\n```\n", { complete: true });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    type(view, "[[proj");
    await new Promise((r) => setTimeout(r, 30));
    expect(menu().dataset.show).toBe("false");
  });
});
