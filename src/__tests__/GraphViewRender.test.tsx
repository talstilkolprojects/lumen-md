import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

vi.mock("../i18n", () => ({ t: (k: string, p?: Record<string, string>) => {
  if (p) return Object.entries(p).reduce((s, [k2, v]) => s.replace(`{${k2}}`, v), k);
  return k;
}}));
vi.mock("../lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../storage/workspace", () => ({
  listWorkspace: vi.fn().mockResolvedValue([]),
  readWorkspaceFile: vi.fn().mockResolvedValue(""),
}));
vi.mock("../views/louvain", () => ({
  louvain: vi.fn().mockReturnValue({ communities: new Map() }),
  communityPalette: vi.fn().mockReturnValue(["hsl(0 0% 50%)"]),
}));

describe("GraphView", () => {
  it("renders without crashing", async () => {
    const { GraphView } = await import("../ui/GraphView");
    const { container } = render(<GraphView onOpenFile={vi.fn()} />);
    await waitFor(() => expect(container).toBeDefined());
  });

  it("shows empty state when no nodes", async () => {
    const { GraphView } = await import("../ui/GraphView");
    const { container } = render(<GraphView onOpenFile={vi.fn()} />);
    // With no workspace files, should show empty text
    await waitFor(() => {
      expect(container.textContent).toContain("graphView.empty");
    });
  });

  it("renders the stats overlay div", async () => {
    const { GraphView } = await import("../ui/GraphView");
    const { container } = render(<GraphView onOpenFile={vi.fn()} />);
    // The stats bar is always rendered
    await waitFor(() => {
      expect(container.querySelector("div")).not.toBeNull();
    });
  });
});

describe("GraphView by touch (plan 10.2.1)", () => {
  // One note: the layout puts it at (cx + 0.7·min(cx, cy)·0.99^100, cy) on the
  // default 800×600 canvas; jsdom's canvas rect is at (0, 0).
  const nodeX = 400 + 210 * Math.pow(0.99, 100);
  const nodeY = 300;

  async function mount() {
    const ws = await import("../storage/workspace");
    vi.mocked(ws.listWorkspace).mockResolvedValue([{ name: "a.md", path: "a.md" }] as never);
    vi.mocked(ws.readWorkspaceFile).mockResolvedValue("# A");
    const { GraphView } = await import("../ui/GraphView");
    const onOpenFile = vi.fn();
    const { findByTestId } = render(<GraphView onOpenFile={onOpenFile} />);
    const canvas = await findByTestId("graph-canvas");
    return { canvas, onOpenFile };
  }

  it("a tap opens the note under the finger, with nothing hovered before", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { canvas, onOpenFile } = await mount();
    // 15 px off the dot: inside a finger's 22 px, outside the cursor's 10 px.
    fireEvent.pointerDown(canvas, { pointerType: "touch", clientX: nodeX + 15, clientY: nodeY });
    fireEvent.click(canvas, { clientX: nodeX + 15, clientY: nodeY, pointerType: "touch" });
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith("a.md", "# A"));
  });

  it("the mouse keeps the tighter hit area", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { canvas, onOpenFile } = await mount();
    fireEvent.pointerMove(canvas, { pointerType: "mouse", clientX: nodeX + 15, clientY: nodeY });
    fireEvent.click(canvas, { clientX: nodeX + 15, clientY: nodeY });
    await new Promise((r) => setTimeout(r, 20));
    expect(onOpenFile).not.toHaveBeenCalled();
    fireEvent.click(canvas, { clientX: nodeX + 3, clientY: nodeY });
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith("a.md", "# A"));
  });
});
