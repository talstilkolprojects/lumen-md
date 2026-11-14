import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import {
  FileContextMenu,
  buildFileActions,
} from "../ui/FileContextMenu";

vi.mock("../i18n", () => ({ registerEnglish: () => undefined, t: (k: string) => k }));

describe("FileContextMenu", () => {
  const baseProps = {
    x: 100,
    y: 100,
    onClose: vi.fn(),
    actions: [
      { id: "rename", label: "Rename", icon: null, onSelect: vi.fn() },
      { id: "delete", label: "Delete", icon: null, destructive: true, onSelect: vi.fn() },
    ],
  };

  it("renders without crashing", () => {
    const { container } = render(<FileContextMenu {...baseProps} />);
    expect(container).toBeDefined();
  });

  it("renders a [role=menu] element", () => {
    render(<FileContextMenu {...baseProps} />);
    const menu = document.querySelector("[role='menu']");
    expect(menu).not.toBeNull();
  });

  it("renders all actions as menuitems", () => {
    render(<FileContextMenu {...baseProps} />);
    const items = document.querySelectorAll("[role='menuitem']");
    expect(items.length).toBe(2);
  });

  it("calls onSelect and onClose when an item is clicked", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(
      <FileContextMenu
        x={100}
        y={100}
        onClose={onClose}
        actions={[{ id: "a", label: "Action", icon: null, onSelect }]}
      />,
    );
    const item = document.querySelector("[role='menuitem']") as HTMLElement;
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("buildFileActions", () => {
  it("always includes rename and delete", () => {
    const actions = buildFileActions({
      isFolder: false,
      onRename: vi.fn(),
      onDelete: vi.fn(),
      onCopyPath: vi.fn(),
    });
    const ids = actions.map((a) => a.id);
    expect(ids).toContain("rename");
    expect(ids).toContain("delete");
  });

  it("includes duplicate for files (not folders)", () => {
    const actions = buildFileActions({
      isFolder: false,
      onRename: vi.fn(),
      onDuplicate: vi.fn(),
      onDelete: vi.fn(),
      onCopyPath: vi.fn(),
    });
    expect(actions.find((a) => a.id === "duplicate")).toBeDefined();
  });

  it("does NOT include duplicate for folders", () => {
    const actions = buildFileActions({
      isFolder: true,
      onRename: vi.fn(),
      onDuplicate: vi.fn(),
      onDelete: vi.fn(),
      onCopyPath: vi.fn(),
    });
    expect(actions.find((a) => a.id === "duplicate")).toBeUndefined();
  });

  it("includes newFile and newFolder for folders", () => {
    const actions = buildFileActions({
      isFolder: true,
      onRename: vi.fn(),
      onDelete: vi.fn(),
      onCopyPath: vi.fn(),
      onNewFile: vi.fn(),
      onNewFolder: vi.fn(),
    });
    const ids = actions.map((a) => a.id);
    expect(ids).toContain("newFile");
    expect(ids).toContain("newFolder");
  });

  it("marks delete as destructive", () => {
    const actions = buildFileActions({
      isFolder: false,
      onRename: vi.fn(),
      onDelete: vi.fn(),
      onCopyPath: vi.fn(),
    });
    const del = actions.find((a) => a.id === "delete");
    expect(del?.destructive).toBe(true);
  });
});
