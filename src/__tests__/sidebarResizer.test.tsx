/**
 * SidebarResizer — vertical drag handle that mutates the
 * `--sidebar-width` CSS variable and persists to localStorage.
 *
 * Previously the test only asserted `container.innerHTML.length > 0`
 * (theatre — passes for any DOM). Now we drive the contract:
 *   - Mount renders role=separator with aria-orientation=vertical.
 *   - localStorage[lumen-sidebar-width] is restored on mount.
 *   - Out-of-range saved widths are rejected.
 *   - mousedown → mousemove updates the CSS var; mouseup persists.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

vi.mock("../lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("SidebarResizer", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty("--sidebar-width");
    document.documentElement.removeAttribute("dir");
  });
  afterEach(() => {
    document.documentElement.style.removeProperty("--sidebar-width");
  });

  it("renders a separator with vertical aria-orientation", async () => {
    const { SidebarResizer } = await import("../ui/SidebarResizer");
    const { container } = render(<SidebarResizer />);
    expect(
      container.querySelector('[role="separator"][aria-orientation="vertical"]'),
    ).not.toBeNull();
  });

  it("restores a saved width from localStorage on mount", async () => {
    localStorage.setItem("lumen-sidebar-width", "320");
    const { SidebarResizer } = await import("../ui/SidebarResizer");
    render(<SidebarResizer />);
    expect(
      document.documentElement.style.getPropertyValue("--sidebar-width"),
    ).toBe("320px");
  });

  it("ignores out-of-range saved widths (< 160 or > 480)", async () => {
    localStorage.setItem("lumen-sidebar-width", "10");
    const { SidebarResizer } = await import("../ui/SidebarResizer");
    render(<SidebarResizer />);
    expect(
      document.documentElement.style.getPropertyValue("--sidebar-width"),
    ).toBe("");
  });

  // Pointer events since plan 10.2.1: the same drag for mouse, touch and pen.
  for (const pointerType of ["mouse", "touch"] as const) {
    it(`dragging by ${pointerType}: pointerdown → pointermove → pointerup updates and persists width`, async () => {
      const { SidebarResizer } = await import("../ui/SidebarResizer");
      const { container } = render(<SidebarResizer />);
      const handle = container.querySelector('[role="separator"]') as HTMLElement;
      expect(handle).not.toBeNull();
      fireEvent.pointerDown(handle, { clientX: 200, pointerType, button: 0 });
      fireEvent.pointerMove(window, { clientX: 280, pointerType });
      expect(
        document.documentElement.style.getPropertyValue("--sidebar-width"),
      ).toBe("320px");
      fireEvent.pointerUp(window, { pointerType });
      expect(localStorage.getItem("lumen-sidebar-width")).toBe("320");
    });
  }

  it("a right-button mouse press does not start a drag", async () => {
    const { SidebarResizer } = await import("../ui/SidebarResizer");
    const { container } = render(<SidebarResizer />);
    const handle = container.querySelector('[role="separator"]') as HTMLElement;
    fireEvent.pointerDown(handle, { clientX: 200, pointerType: "mouse", button: 2 });
    fireEvent.pointerMove(window, { clientX: 280, pointerType: "mouse" });
    expect(document.documentElement.style.getPropertyValue("--sidebar-width")).toBe("");
  });
});
