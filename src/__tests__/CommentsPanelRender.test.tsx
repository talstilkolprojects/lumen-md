import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";

vi.mock("../i18n", () => ({ registerEnglish: () => undefined, t: (k: string) => k }));
vi.mock("../lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../collab/comments", () => ({
  listComments: vi.fn().mockReturnValue([]),
  onCommentsChanged: vi.fn().mockReturnValue(() => {}),
  addComment: vi.fn(),
  deleteComment: vi.fn(),
  replyToComment: vi.fn(),
  resolveAnchor: vi.fn().mockReturnValue(null),
  toggleResolved: vi.fn(),
}));

function makeCollab() {
  return {
    doc: {} as any,
    commentsDoc: {} as any,
    canComment: () => true,
    canEdit: () => true,
    ytext: { toString: () => "sample text" } as any,
    user: { name: "Test User", color: "#ff0" } as any,
  };
}

describe("CommentsPanel", () => {
  it("renders without crashing when closed", async () => {
    const { CommentsPanel } = await import("../ui/CommentsPanel");
    const { container } = render(
      <CommentsPanel
        open={false}
        onClose={vi.fn()}
        collab={makeCollab() as any}
      />,
    );
    // When closed, renders null
    expect(container.firstChild).toBeNull();
  });

  it("renders panel when open", async () => {
    const { CommentsPanel } = await import("../ui/CommentsPanel");
    const { container } = render(
      <CommentsPanel
        open={true}
        onClose={vi.fn()}
        collab={makeCollab() as any}
      />,
    );
    const aside = container.querySelector("aside");
    expect(aside).not.toBeNull();
  });

  it("shows empty state when no comments", async () => {
    const { CommentsPanel } = await import("../ui/CommentsPanel");
    const { container } = render(
      <CommentsPanel
        open={true}
        onClose={vi.fn()}
        collab={makeCollab() as any}
      />,
    );
    expect(container.textContent).toContain("commentsPanel.empty");
  });

  it("calls onClose when close button is clicked", async () => {
    const { CommentsPanel } = await import("../ui/CommentsPanel");
    const onClose = vi.fn();
    const { container } = render(
      <CommentsPanel
        open={true}
        onClose={onClose}
        collab={makeCollab() as any}
      />,
    );
    const closeBtn = container.querySelector(
      "button[aria-label='commentsPanel.close']",
    ) as HTMLButtonElement;
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("has aria-label on the aside panel", async () => {
    const { CommentsPanel } = await import("../ui/CommentsPanel");
    const { container } = render(
      <CommentsPanel
        open={true}
        onClose={vi.fn()}
        collab={makeCollab() as any}
      />,
    );
    const aside = container.querySelector("aside");
    expect(aside?.getAttribute("aria-label")).toBe("commentsPanel.title");
  });
});

describe("addCommentFromSelection", () => {
  it("returns null for empty body", async () => {
    const { addCommentFromSelection } = await import("../ui/CommentsPanel");
    const result = addCommentFromSelection(makeCollab() as any, "", 0, 10);
    expect(result).toBeNull();
  });

  it("returns null when from === to (no selection)", async () => {
    const { addCommentFromSelection } = await import("../ui/CommentsPanel");
    const result = addCommentFromSelection(makeCollab() as any, "A comment", 5, 5);
    expect(result).toBeNull();
  });
});
