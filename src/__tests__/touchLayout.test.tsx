/**
 * Touch and mobile (plan 10.2): the outline toggles a bottom sheet on a
 * phone-width screen and leaves the desktop setting alone; the sheet closes
 * from its button and from a picked heading. The touch journey itself is
 * e2e/touch.spec.ts (iPhone 14, Pixel 7).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useAppStore, isNarrowScreen } from "../store/useStore";
import { Outline } from "../ui/Outline";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function screenWidth(narrow: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: narrow && q.includes("max-width: 760px"), media: q, addEventListener() {}, removeEventListener() {} }));
}

describe("the outline on a phone", () => {
  it("the toggle opens a sheet there, and the side panel on wider screens", () => {
    useAppStore.setState({ showOutline: true, outlineSheet: false });
    screenWidth(true);
    expect(isNarrowScreen()).toBe(true);
    useAppStore.getState().toggleOutline();
    expect(useAppStore.getState()).toMatchObject({ outlineSheet: true, showOutline: true });
    useAppStore.getState().toggleOutline();
    expect(useAppStore.getState()).toMatchObject({ outlineSheet: false, showOutline: true });
    screenWidth(false);
    useAppStore.getState().toggleOutline();
    expect(useAppStore.getState()).toMatchObject({ outlineSheet: false, showOutline: false });
    useAppStore.setState({ showOutline: true });
  });

  it("the sheet is not persisted: a phone starts without it", () => {
    useAppStore.setState({ outlineSheet: true });
    const persisted = JSON.parse(localStorage.getItem("lumen-md") ?? "{}") as { state?: Record<string, unknown> };
    expect(persisted.state ?? {}).not.toHaveProperty("outlineSheet");
    useAppStore.setState({ outlineSheet: false });
  });

  it("renders as a labelled sheet that closes from its button or a picked heading", () => {
    screenWidth(true);
    useAppStore.setState({ outlineSheet: true });
    vi.useFakeTimers();
    render(<Outline markdownText={"# One\n\n## Two\n"} sheet />);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    vi.useRealTimers();
    const sheet = screen.getByTestId("outline-sheet");
    expect(sheet.className).toContain("outline-sheet");
    expect(sheet.getAttribute("aria-label")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Two" }));
    expect(useAppStore.getState().outlineSheet).toBe(false);
    useAppStore.setState({ outlineSheet: true });
    fireEvent.click(screen.getByRole("button", { name: "Close the outline" }));
    expect(useAppStore.getState().outlineSheet).toBe(false);
  });

  it("on a wide screen it stays the side panel", () => {
    render(<Outline markdownText={"# One\n"} />);
    expect(screen.queryByTestId("outline-sheet")).toBeNull();
  });
});
