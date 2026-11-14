/** Plan 11.2 (b) — a plugin's UI tree rendered by the app: no URL, image, style or markup from plugin strings. */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { UiTreeView } from "../plugins/runtime/UiTreeView";
import { validateUiTree } from "../plugins/runtime/uiTree";

const tree = validateUiTree({
  type: "box",
  children: [
    { type: "heading", text: "<img src=https://evil.example/x>" },
    { type: "paragraph", children: [{ type: "text", text: "javascript:alert(1)" }, { type: "noteLink", target: "Projects/Plan", label: "the plan" }] },
    { type: "button", id: "go", label: "Go" },
    { type: "checkbox", id: "c", label: "Check" },
    { type: "input", id: "name", value: "שלום" },
    { type: "select", id: "s", value: "b", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
  ],
});

describe("UiTreeView", () => {
  it("renders plugin strings as text only: no img, link, frame, form, style or script", () => {
    const { container } = render(<UiTreeView node={tree} onEvent={() => undefined} onOpenNote={() => undefined} />);
    expect(container.querySelectorAll("img, a, iframe, form, style, script, link, object, embed, video, audio, source")).toHaveLength(0);
    for (const el of container.querySelectorAll("*")) {
      expect(el.hasAttribute("src") || el.hasAttribute("href") || el.hasAttribute("action")).toBe(false);
      expect(el.getAttribute("style") ?? "").not.toMatch(/url\(/);
    }
    expect(container.textContent).toContain("<img src=https://evil.example/x>");
  });
  it("reports clicks and changes by element id; note links open notes", () => {
    const onEvent = vi.fn();
    const onOpenNote = vi.fn();
    const { getByText, container } = render(<UiTreeView node={tree} onEvent={onEvent} onOpenNote={onOpenNote} />);
    fireEvent.click(getByText("Go"));
    fireEvent.click(container.querySelector('[data-plugin-ui="c"]')!);
    fireEvent.change(container.querySelector('[data-plugin-ui="s"]')!, { target: { value: "a" } });
    const input = container.querySelector('[data-plugin-ui="name"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "עולם" } });
    fireEvent.blur(input);
    fireEvent.click(getByText("the plan"));
    expect(onEvent.mock.calls.map((c) => c[0])).toEqual([
      { id: "go", kind: "click" },
      { id: "c", kind: "change", value: true },
      { id: "s", kind: "change", value: "a" },
      { id: "name", kind: "change", value: "עולם" },
    ]);
    expect(onOpenNote).toHaveBeenCalledWith("Projects/Plan");
  });
});
