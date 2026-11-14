/**
 * MobileKeyboardBar — accessory row that appears above the on-screen
 * keyboard on touch devices.
 *
 * Previously this test only asserted `container is defined` — theatre
 * that would pass even if the bar never rendered. The real component
 * gates rendering on (a) `matchMedia('(pointer: coarse)')`, (b) editor
 * focused, (c) nothing else: the row sits on top of the keyboard when there is one
 * (VisualViewport) and at the bottom of the screen when there isn't.
 *
 * We test two coordinates of the contract:
 *   1. On a non-touch device (default in jsdom) the bar is hidden.
 *   2. On a touch screen with the source editor focused, the bar renders
 *      the user's row (store `mobileToolbar`, plan W1.25) above the
 *      keyboard, and a tap sends `lumen-mobile-action` {id}.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";

vi.mock("../lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  // Default to non-touch.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

describe("MobileKeyboardBar", () => {
  it("renders nothing on a non-touch device", async () => {
    const { MobileKeyboardBar } = await import("../ui/MobileKeyboardBar");
    const { container } = render(<MobileKeyboardBar />);
    // No toolbar should appear.
    expect(container.querySelector('[role="toolbar"]')).toBeNull();
  });

  it("on a touch screen with the editor focused: the user's row, 44 px targets, and a tap sends lumen-mobile-action without taking focus", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (q: string) => ({
        matches: q === "(pointer: coarse)",
        media: q,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: { height: 500, offsetTop: 0, addEventListener: () => {}, removeEventListener: () => {} } as unknown as VisualViewport,
    });
    // Focus inside the source editor (CodeMirror's .cm-editor).
    const host = document.createElement("div");
    host.className = "cm-editor";
    const editor = document.createElement("div");
    editor.className = "cm-content";
    editor.tabIndex = 0;
    host.appendChild(editor);
    document.body.appendChild(host);
    editor.focus();

    const { useAppStore } = await import("../store/useStore");
    useAppStore.setState({ mobileToolbar: ["task", "indent", "hideKeyboard"] });
    const { MobileKeyboardBar } = await import("../ui/MobileKeyboardBar");
    const { container } = render(<MobileKeyboardBar />);
    await act(async () => {
      document.dispatchEvent(new FocusEvent("focusin"));
    });

    const toolbar = container.querySelector('[role="toolbar"][aria-label="Editing toolbar"]');
    expect(toolbar).not.toBeNull();
    // The stored row, then ⋯ (customise); placed on top of the 300 px keyboard.
    expect(Array.from(toolbar!.querySelectorAll<HTMLButtonElement>("button")).map((b) => b.getAttribute("data-action"))).toEqual(["task", "indent", "hideKeyboard", "customize"]);
    expect((toolbar as HTMLElement).style.bottom).toBe("300px");
    const task = toolbar!.querySelector('button[aria-label="Task checkbox"]') as HTMLButtonElement;
    expect(task.style.minWidth).toBe("44px");

    let captured: CustomEvent | null = null;
    const handler = (e: Event) => {
      captured = e as CustomEvent;
    };
    window.addEventListener("lumen-mobile-action", handler);
    // mousedown is cancelled (the editor keeps focus and the keyboard stays up); click acts.
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    task.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.click(task);
    window.removeEventListener("lumen-mobile-action", handler);
    expect((captured as unknown as CustomEvent).detail?.id).toBe("task");

    document.body.removeChild(host);
  });
});
