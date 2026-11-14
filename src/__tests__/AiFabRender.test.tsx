import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { AiFab } from "../ui/AiFab";

vi.mock("../i18n", () => ({ registerEnglish: () => undefined, t: (k: string) => k }));
vi.mock("../lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const baseCmd = {
  id: "ai.rewrite",
  label: "AI: Rewrite",
  hint: "Rewrite the selection",
  action: vi.fn(),
};

describe("AiFab", () => {
  it("renders without crashing", () => {
    const { container } = render(<AiFab commands={[]} />);
    expect(container).toBeDefined();
  });

  it("renders the trigger button", () => {
    const { container } = render(<AiFab commands={[]} />);
    const btn = container.querySelector("button");
    expect(btn).not.toBeNull();
  });

  it("is closed by default (no menu)", () => {
    const { container } = render(<AiFab commands={[baseCmd]} />);
    const menu = container.querySelector("[role='menu']");
    expect(menu).toBeNull();
  });

  it("opens the menu on trigger click", () => {
    const { container } = render(<AiFab commands={[baseCmd]} />);
    const btn = container.querySelector("button") as HTMLButtonElement;
    fireEvent.click(btn);
    const menu = container.querySelector("[role='menu']");
    expect(menu).not.toBeNull();
  });

  it("shows AI command items after opening", () => {
    const { container } = render(<AiFab commands={[baseCmd]} />);
    const btn = container.querySelector("button") as HTMLButtonElement;
    fireEvent.click(btn);
    const items = container.querySelectorAll("[role='menuitem']");
    expect(items.length).toBeGreaterThan(0);
  });

  it("calls command action when item is clicked", () => {
    const action = vi.fn();
    const cmd = { ...baseCmd, action };
    const { container } = render(<AiFab commands={[cmd]} />);
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    const item = container.querySelector("[role='menuitem']") as HTMLButtonElement;
    fireEvent.click(item);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("filters out non-ai commands", () => {
    const nonAi = { id: "file.new", label: "New File", action: vi.fn() };
    const { container } = render(<AiFab commands={[baseCmd, nonAi]} />);
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    const items = container.querySelectorAll("[role='menuitem']");
    // Only the ai.* command should appear
    expect(items.length).toBe(1);
  });

  it("has aria-expanded attribute on trigger", () => {
    const { container } = render(<AiFab commands={[]} />);
    const btn = container.querySelector("button") as HTMLButtonElement;
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });
});
