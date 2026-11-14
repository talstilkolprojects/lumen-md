import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { AiToastContainer, showAiToast } from "../ui/AiToast";

vi.mock("../i18n", () => ({ registerEnglish: () => undefined, t: (k: string) => k }));
vi.mock("../lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("AiToastContainer", () => {
  it("keeps its two live regions on the page even when empty (WCAG 4.1.3)", () => {
    const { container } = render(<AiToastContainer />);
    expect(container.textContent).toBe("");
    expect(container.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"][aria-live="assertive"]')).not.toBeNull();
  });

  it("puts errors in the assertive region and the rest in the polite one", () => {
    const { container } = render(<AiToastContainer />);
    act(() => {
      showAiToast("Broke", "error");
      showAiToast("Saved", "success");
    });
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("Broke");
    expect(container.querySelector('[role="status"]')!.textContent).toContain("Saved");
  });

  it("stays while hovered or focused, then times out (WCAG 2.2.1)", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<AiToastContainer />);
      act(() => { showAiToast("Hold me", "info"); });
      const toast = container.querySelector('[role="status"] > div') as HTMLElement;
      fireEvent.mouseEnter(toast);
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(container.textContent).toContain("Hold me");
      fireEvent.mouseLeave(toast);
      act(() => { vi.advanceTimersByTime(4_100); });
      expect(container.textContent).not.toContain("Hold me");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a toast when showAiToast is called", () => {
    const { container } = render(<AiToastContainer />);
    act(() => { showAiToast("Test message", "info"); });
    expect(container.textContent).toContain("Test message");
  });

  it("shows success type toast", () => {
    const { container } = render(<AiToastContainer />);
    act(() => { showAiToast("Saved!", "success"); });
    expect(container.textContent).toContain("Saved!");
  });

  it("shows error type toast", () => {
    const { container } = render(<AiToastContainer />);
    act(() => { showAiToast("Something failed", "error"); });
    expect(container.textContent).toContain("Something failed");
  });

  it("dismiss button removes the toast", () => {
    const { container } = render(<AiToastContainer />);
    act(() => { showAiToast("Dismiss me", "info"); });
    const dismissBtn = container.querySelector("button[aria-label]") as HTMLButtonElement;
    expect(dismissBtn).not.toBeNull();
    fireEvent.click(dismissBtn);
    expect(container.textContent).not.toContain("Dismiss me");
  });

  it("shows multiple toasts simultaneously", () => {
    const { container } = render(<AiToastContainer />);
    act(() => {
      showAiToast("First", "info");
      showAiToast("Second", "success");
    });
    expect(container.textContent).toContain("First");
    expect(container.textContent).toContain("Second");
  });
});
