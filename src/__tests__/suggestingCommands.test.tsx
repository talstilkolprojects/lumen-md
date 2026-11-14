/**
 * Suggesting mode — palette commands + status-bar indicator.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));

import { buildSuggestingCommands } from "../editor/suggestingCommands";
import { suggestingExtension } from "../editor/suggestingExtension";
import { showAiToast } from "../ui/AiToast";
import { StatusBar } from "../ui/StatusBar";
import { useAppStore } from "../store/useStore";

function deps(over: Partial<Parameters<typeof buildSuggestingCommands>[0]> = {}) {
  let content = "a{++b++}c";
  return {
    getView: () => null,
    getContent: () => content,
    setContent: (s: string) => {
      content = s;
    },
    suggesting: false,
    toggle: vi.fn(),
    get content() {
      return content;
    },
    ...over,
  };
}

const byId = (cmds: ReturnType<typeof buildSuggestingCommands>, id: string) =>
  cmds.find((c) => c.id === id)!;

describe("buildSuggestingCommands", () => {
  beforeEach(() => vi.mocked(showAiToast).mockClear());

  it("registers toggle, accept/reject (cursor + all) and navigation", () => {
    const ids = buildSuggestingCommands(deps()).map((c) => c.id);
    expect(ids).toEqual([
      "edit.suggesting.toggle",
      "edit.suggesting.accept",
      "edit.suggesting.reject",
      "edit.suggesting.acceptAll",
      "edit.suggesting.rejectAll",
      "edit.suggesting.next",
      "edit.suggesting.prev",
    ]);
  });

  it("toggle label reflects state and calls toggle", () => {
    const d = deps({ suggesting: true });
    const cmd = byId(buildSuggestingCommands(d), "edit.suggesting.toggle");
    expect(cmd.label).toMatch(/off/i);
    cmd.action();
    expect(d.toggle).toHaveBeenCalled();
  });

  it("accept / reject all rewrite the text when no editor is mounted", () => {
    const d = deps();
    byId(buildSuggestingCommands(d), "edit.suggesting.acceptAll").action();
    expect(d.content).toBe("abc");
    const r = deps();
    byId(buildSuggestingCommands(r), "edit.suggesting.rejectAll").action();
    expect(r.content).toBe("ac");
  });

  it("cursor commands explain that the source editor is needed", () => {
    byId(buildSuggestingCommands(deps()), "edit.suggesting.accept").action();
    expect(showAiToast).toHaveBeenCalled();
  });

  it("cursor commands act on a mounted view", async () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "a{++b++}c", selection: { anchor: 4 }, extensions: suggestingExtension() }),
    });
    await byId(buildSuggestingCommands(deps({ getView: () => view })), "edit.suggesting.reject").action();
    expect(view.state.doc.toString()).toBe("ac");
    view.destroy();
  });
});

describe("StatusBar suggesting pill", () => {
  beforeEach(() => useAppStore.setState({ suggestingMode: false }));

  it("toggles the store flag and shows the suggestion count", () => {
    render(<StatusBar text="x{++a++}{--b--}" dirty={false} filename="x.md" />);
    const pill = screen.getByTestId("status-suggesting");
    expect(pill.getAttribute("aria-pressed")).toBe("false");
    expect(pill.textContent).toContain("2");
    fireEvent.click(pill);
    expect(useAppStore.getState().suggestingMode).toBe(true);
    expect(screen.getByTestId("status-suggesting").getAttribute("aria-pressed")).toBe("true");
  });
});
