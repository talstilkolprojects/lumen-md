import { describe, it, expect, vi, beforeAll } from "vitest";
import { render } from "@testing-library/react";

// ResizeObserver is not available in jsdom — stub it
beforeAll(() => {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

vi.mock("../i18n", () => ({ t: (k: string) => k }));
vi.mock("../renderer/Preview", () => ({
  Preview: ({ markdownText }: { markdownText: string }) => (
    <div data-testid="preview">{markdownText}</div>
  ),
}));

describe("PageView", () => {
  it("renders without crashing", async () => {
    const { PageView } = await import("../ui/PageView");
    const { container } = render(<PageView markdownText="# Hello" />);
    expect(container).toBeDefined();
  });

  it("renders navigation bar with prev/next buttons", async () => {
    const { PageView } = await import("../ui/PageView");
    const { container } = render(<PageView markdownText="# Hello" />);
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });

  it("shows 'Previous page' and 'Next page' labels", async () => {
    const { PageView } = await import("../ui/PageView");
    const { container } = render(<PageView markdownText="# Hello" />);
    const prevBtn = container.querySelector("[aria-label='pageView.prev']");
    const nextBtn = container.querySelector("[aria-label='pageView.next']");
    expect(prevBtn).not.toBeNull();
    expect(nextBtn).not.toBeNull();
  });

  it("previous button is disabled on first page", async () => {
    const { PageView } = await import("../ui/PageView");
    const { container } = render(<PageView markdownText="# Hello" />);
    const prevBtn = container.querySelector("[aria-label='pageView.prev']") as HTMLButtonElement;
    expect(prevBtn.disabled).toBe(true);
  });

  it("renders page select dropdown", async () => {
    const { PageView } = await import("../ui/PageView");
    const { container } = render(<PageView markdownText="# Hello" />);
    const select = container.querySelector("select[aria-label='pageView.jump']");
    expect(select).not.toBeNull();
  });

  it("renders the preview content", async () => {
    const { PageView } = await import("../ui/PageView");
    const { container } = render(<PageView markdownText="# My Document" />);
    expect(container.textContent).toContain("My Document");
  });
});
