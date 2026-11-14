/**
 * T25 — per-line direction in the source editor.
 *
 * The extension puts a `dir` attribute on every rendered line: its own direction (plan 9.7; was `auto`)
 * for prose (the browser resolves it from the line's own text), `ltr`
 * inside fenced code and the frontmatter, and the frontmatter's own
 * `dir:` for every line when the note pins one.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { bidiExtension, frontmatterDir, firstStrongDirection } from "../editor/bidi";

function mount(doc: string, host: HTMLElement): EditorView {
  return new EditorView({
    state: EditorState.create({ doc, extensions: [markdown(), bidiExtension()] }),
    parent: host,
  });
}

function dirs(view: EditorView): string[] {
  return Array.from(view.contentDOM.querySelectorAll(".cm-line")).map((el) => el.getAttribute("dir") ?? "");
}

describe("frontmatterDir", () => {
  it("reads a dir key from the frontmatter only", () => {
    expect(frontmatterDir("---\ndir: rtl\n---\n# x")).toBe("rtl");
    expect(frontmatterDir("---\ntitle: t\ndir: 'ltr'\n---\n")).toBe("ltr");
    expect(frontmatterDir("---\ndir: auto\n---\n")).toBe("auto");
    expect(frontmatterDir("# x\n\ndir: rtl")).toBeNull();
    expect(frontmatterDir("---\ndir: sideways\n---\n")).toBeNull();
    expect(frontmatterDir("---\nno closing fence")).toBeNull();
  });

  it("re-exports the shared first-strong helper", () => {
    expect(firstStrongDirection("שלום")).toBe("rtl");
  });
});

describe("bidiExtension", () => {
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  it("gives every prose line its own direction, empty lines the note's, and code ltr (plan 9.7)", () => {
    const view = mount("# כותרת\n\nEnglish paragraph\n\n```js\nconst x = 1;\n```\n\nשורה בעברית", host);
    expect(dirs(view)).toEqual(["rtl", "rtl", "ltr", "rtl", "ltr", "ltr", "ltr", "rtl", "rtl"]);
    view.destroy();
  });

  it("decides by the text after Markdown markers, without code spans and link URLs (plan 9.7)", () => {
    const view = mount("> `iPhone` הפגישה נדחתה\n- [ ] Hello everyone\n[שלום](https://example.com/a)\n10:30 42%\n\u200F10:30 PDF", host);
    // dir="auto" would have made the first line ltr (the code span's "i").
    expect(dirs(view)).toEqual(["rtl", "ltr", "rtl", "rtl", "rtl"]);
    view.destroy();
  });

  it("keeps the frontmatter ltr and lets a dir key pin the rest of the note", () => {
    const view = mount("---\ntitle: t\ndir: rtl\n---\nfirst line\n\n```\ncode\n```", host);
    // Frontmatter lines are ltr (YAML) and so is code; the prose takes
    // the pin instead of resolving per line.
    expect(dirs(view)).toEqual(["ltr", "ltr", "ltr", "ltr", "rtl", "rtl", "ltr", "ltr", "ltr"]);
    view.destroy();
  });

  it("takes a neutral line's direction from the whole note, past fenced code (review: #252)", async () => {
    const { noteDirection } = await import("../editor/bidi");
    const { EditorState } = await import("@codemirror/state");
    const neutral = Array.from({ length: 600 }, (_, i) => `${i}.`).join("\n");
    expect(noteDirection(EditorState.create({ doc: `${neutral}\nשורה בעברית` }), -1)).toBe("rtl");
    expect(noteDirection(EditorState.create({ doc: "10:30\n```\nEnglish code\n```\nשלום" }), -1)).toBe("rtl");
    expect(noteDirection(EditorState.create({ doc: "10:30\n42" }), -1)).toBe("ltr");
  });

  it("turns on CodeMirror's per-line direction so cursor motion follows each line", () => {
    const view = mount("שלום\nhello", host);
    expect(view.state.facet(EditorView.perLineTextDirection)).toBe(true);
    view.destroy();
  });

  it("follows edits: a line that becomes code turns ltr", () => {
    const view = mount("שלום\nhello\n", host);
    expect(dirs(view)).toEqual(["rtl", "ltr", "rtl"]);
    view.dispatch({ changes: { from: 0, insert: "```\n" } });
    view.dispatch({ changes: { from: view.state.doc.length, insert: "```" } });
    expect(dirs(view)).toEqual(["ltr", "ltr", "ltr", "ltr"]);
    view.destroy();
  });
});
