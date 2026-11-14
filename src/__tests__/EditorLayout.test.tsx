/**
 * src/layouts/EditorLayout.tsx — which panes each view mode shows, how the
 * split axis follows the preference and the viewport, and the
 * heading-anchored scroll sync between the source editor and the preview.
 *
 * CodeMirror and the markdown renderer are replaced by small stand-ins
 * that render the DOM hooks the layout looks for (`.cm-scroller` and
 * `[data-preview-root]` with heading ids). jsdom does no layout, so the
 * test gives those elements explicit scroll geometry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import type { RefObject } from "react";
import type { EditorHandle } from "../editor/Editor";

const seen = vi.hoisted(() => ({
  editor: [] as Array<{ value: string; suggesting?: boolean; vimEnabled?: boolean }>,
  preview: [] as Array<{ markdownText: string; docKey?: string | null }>,
  pageView: [] as Array<{ markdownText: string; docKey?: string | null }>,
  wysiwyg: [] as Array<{ value: string; onChange: (s: string) => void }>,
}));

vi.mock("../editor/Editor", async () => {
  const { forwardRef } = await import("react");
  return {
    Editor: forwardRef<unknown, { value: string; suggesting?: boolean; vimEnabled?: boolean }>(function FakeEditor(props, _ref) {
      seen.editor.push(props);
      return (
        <div className="cm-scroller" data-testid="editor-scroller">
          {props.value}
        </div>
      );
    }),
  };
});
vi.mock("../renderer/Preview", () => ({
  Preview: (props: { markdownText: string; docKey?: string | null }) => {
    seen.preview.push(props);
    const headings = props.markdownText.includes("#");
    return (
      <div data-preview-root data-testid="preview-root">
        {headings && <h1 id="intro">Intro</h1>}
        <p>{props.markdownText}</p>
        {headings && <h2 id="details">Details</h2>}
      </div>
    );
  },
}));
vi.mock("../ui/PageView", () => ({
  PageView: (props: { markdownText: string; docKey?: string | null }) => {
    seen.pageView.push(props);
    return <div data-testid="page-view">{props.markdownText}</div>;
  },
}));
vi.mock("../editor/WysiwygEditor", () => ({
  default: (props: { value: string; onChange: (s: string) => void }) => {
    seen.wysiwyg.push(props);
    if (props.value === "boom") throw new Error("milkdown failed to boot");
    return <div data-testid="wysiwyg">{props.value}</div>;
  },
}));
vi.mock("../ui/WritingGoalBanner", () => ({ WritingGoalBanner: () => null }));

import { EditorLayout } from "../layouts/EditorLayout";
import { useAppStore } from "../store/useStore";
import type { ViewMode } from "../store/useStore";

// jsdom has no CSS.escape; the layout uses it to look headings up by id.
const g = globalThis as unknown as { CSS?: { escape?: (s: string) => string } };
if (!g.CSS) g.CSS = {};
if (!g.CSS.escape) g.CSS.escape = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);

const SOURCE = "# Intro\nbody\n## Details\nmore";

/** A CodeMirror-shaped view: line n starts at offset n and sits 20px per line. */
function fakeEditorRef(text: string): RefObject<EditorHandle | null> {
  const lines = text.split("\n").length;
  const view = {
    state: { doc: { toString: () => text, lines, line: (n: number) => ({ from: n }) } },
    lineBlockAt: (from: number) => ({ top: (from - 1) * 20 }),
  };
  return { current: { getView: () => view } } as unknown as RefObject<EditorHandle | null>;
}

/** Give a jsdom element scroll geometry; scrollTop becomes a plain stored number. */
function geometry(el: Element, values: { scrollHeight?: number; clientHeight?: number; offsetTop?: number }) {
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(el, key, { configurable: true, get: () => value });
  }
}

function setWidth(px: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: px });
}

function layout(mode: ViewMode, extra: Partial<Parameters<typeof EditorLayout>[0]> = {}) {
  return (
    <EditorLayout
      mode={mode}
      docContent={SOURCE}
      deferredContent={SOURCE}
      deferredDocKey="ws:notes.md"
      editorRef={fakeEditorRef(SOURCE)}
      vimEnabled={false}
      spellCheck={false}
      grammarCheck={false}
      typewriterMode={false}
      activeFile="notes.md"
      pageView={false}
      collab={null}
      setContent={() => {}}
      handleAddAsset={async () => null}
      {...extra}
    />
  );
}

const originalWidth = window.innerWidth;

beforeEach(() => {
  seen.editor.length = 0;
  seen.preview.length = 0;
  seen.pageView.length = 0;
  seen.wysiwyg.length = 0;
  setWidth(1280);
  useAppStore.setState({ splitAxis: "auto", syncScroll: "all" });
});

afterEach(() => {
  cleanup();
  setWidth(originalWidth);
});

describe("EditorLayout panes per view mode", () => {
  it("split: editor and preview side by side", async () => {
    const { container } = render(layout("split", { suggestingMode: true, vimEnabled: true }));
    expect(await screen.findByTestId("editor-scroller")).toBeTruthy();
    expect(screen.getByTestId("preview-root")).toBeTruthy();
    expect(container.firstElementChild?.getAttribute("data-split-axis")).toBe("horizontal");
    const last = seen.editor[seen.editor.length - 1];
    expect(last.value).toBe(SOURCE);
    expect(last.suggesting).toBe(true);
    expect(last.vimEnabled).toBe(true);
    expect(seen.preview[seen.preview.length - 1]).toMatchObject({ markdownText: SOURCE, docKey: "ws:notes.md" });
  });

  it("source: only the editor", async () => {
    render(layout("source"));
    expect(await screen.findByTestId("editor-scroller")).toBeTruthy();
    expect(screen.queryByTestId("preview-root")).toBeNull();
  });

  it("preview: only the rendered preview, from the deferred content", () => {
    render(layout("preview", { docContent: "live", deferredContent: "# deferred" }));
    expect(screen.queryByTestId("editor-scroller")).toBeNull();
    expect(screen.getByTestId("preview-root").textContent).toContain("# deferred");
  });

  it("page view replaces the preview when enabled", async () => {
    render(layout("preview", { pageView: true }));
    expect((await screen.findByTestId("page-view")).textContent).toBe(SOURCE);
    expect(screen.queryByTestId("preview-root")).toBeNull();
    expect(seen.pageView[seen.pageView.length - 1].docKey).toBe("ws:notes.md");
  });

  it("wysiwyg: the rich editor edits the live content", async () => {
    const setContent = vi.fn();
    render(layout("wysiwyg", { setContent }));
    expect((await screen.findByTestId("wysiwyg")).textContent).toBe(SOURCE);
    expect(screen.queryByTestId("editor-scroller")).toBeNull();
    seen.wysiwyg[seen.wysiwyg.length - 1].onChange("edited");
    expect(setContent).toHaveBeenCalledWith("edited");
  });

  it("wysiwyg: a crashing rich editor falls back to a hint instead of a blank page", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(layout("wysiwyg", { docContent: "boom" }));
    expect((await screen.findByText("WYSIWYG editor failed")).tagName).toBe("STRONG");
    expect(screen.getByText("Try switching to Source mode.")).toBeTruthy();
    spy.mockRestore();
  });
});

describe("EditorLayout split axis", () => {
  it("stacks the panes when the user picks vertical", () => {
    useAppStore.setState({ splitAxis: "vertical" });
    const { container } = render(layout("split"));
    expect(container.firstElementChild?.getAttribute("data-split-axis")).toBe("vertical");
    expect(container.firstElementChild?.className).toContain("flex-col");
  });

  it("auto and horizontal stack on a phone-width viewport and follow resizes", () => {
    useAppStore.setState({ splitAxis: "horizontal" });
    setWidth(500);
    const { container } = render(layout("split"));
    const root = () => container.firstElementChild?.getAttribute("data-split-axis");
    expect(root()).toBe("vertical");
    act(() => {
      setWidth(1200);
      window.dispatchEvent(new Event("resize"));
    });
    expect(root()).toBe("horizontal");
  });

  it("the axis only applies to split mode", () => {
    useAppStore.setState({ splitAxis: "vertical" });
    const { container } = render(layout("preview"));
    expect(container.firstElementChild?.getAttribute("data-split-axis")).toBe("horizontal");
  });
});

describe("EditorLayout scroll sync", () => {
  it("keeps the same heading section in view in both panes", async () => {
    render(layout("split"));
    const editor = await screen.findByTestId("editor-scroller");
    const preview = screen.getByTestId("preview-root");
    geometry(editor, { scrollHeight: 120, clientHeight: 60 });
    geometry(preview, { scrollHeight: 800, clientHeight: 200 });
    geometry(preview.querySelector("#intro")!, { offsetTop: 0 });
    geometry(preview.querySelector("#details")!, { offsetTop: 400 });

    // Editor halfway through "Intro" (lines 1–3 → 0–40px) → preview halfway
    // between the Intro (0) and Details (400) headings.
    await waitFor(() => {
      fireEvent.mouseEnter(editor);
      editor.scrollTop = 20;
      fireEvent.scroll(editor);
      expect(preview.scrollTop).toBe(200);
    });

    // Preview halfway through the last section (400 → end at 800) → editor
    // halfway from the Details line (40px) to the end of its content (120px).
    await waitFor(() => {
      fireEvent.mouseEnter(preview);
      preview.scrollTop = 600;
      fireEvent.scroll(preview);
      expect(editor.scrollTop).toBe(80);
    });
  });

  it("falls back to proportional scrolling when the document has no headings", async () => {
    render(layout("split", { docContent: "plain", deferredContent: "plain", editorRef: fakeEditorRef("plain") }));
    const editor = await screen.findByTestId("editor-scroller");
    const preview = screen.getByTestId("preview-root");
    geometry(editor, { scrollHeight: 160, clientHeight: 60 });
    geometry(preview, { scrollHeight: 800, clientHeight: 200 });
    await waitFor(() => {
      fireEvent.mouseEnter(editor);
      editor.scrollTop = 50;
      fireEvent.scroll(editor);
      // 50 / (160 - 60) = half way → half of (800 - 200).
      expect(preview.scrollTop).toBe(300);
    });
    await waitFor(() => {
      fireEvent.mouseEnter(preview);
      preview.scrollTop = 150;
      fireEvent.scroll(preview);
      // 150 / 600 = a quarter → a quarter of 100.
      expect(editor.scrollTop).toBe(25);
    });
  });
});
