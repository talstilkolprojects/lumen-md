/**
 * Plan 3.1 review (#218): Ctrl+Z restores from the trash while the Trash
 * panel may be open. The panel follows (no stale rows), and Restore on a row
 * that is already back is a no-op instead of "Not in the trash".
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";
import { __resetTrashUndo, trashPaths, undoLastTrash } from "../storage/fileOps";
import { listTrash, restoreFromTrash } from "../storage/trash";
import { TrashPanel } from "../ui/TrashPanel";
import { useToastStore } from "../store/useToastStore";

beforeEach(() => {
  installFakeOpfs();
  __resetTrashUndo();
  useToastStore.getState().clear();
});

afterEach(() => cleanup());

describe("TrashPanel while Ctrl+Z restores", () => {
  it("drops the row that Ctrl+Z restored", async () => {
    await writeWorkspaceFile("a.md", "A");
    await writeWorkspaceFile("b.md", "B");
    await trashPaths(["a.md"]);
    await trashPaths(["b.md"]);
    render(<TrashPanel open onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("trash-item")).toHaveLength(2));
    expect(await undoLastTrash()).toEqual(["b.md"]);
    await waitFor(() => expect(screen.getAllByTestId("trash-item")).toHaveLength(1));
    expect(screen.getByTestId("trash-item").textContent).toContain("a.md");
  });

  it("Restore on a row restored meanwhile does nothing and refreshes the list", async () => {
    await writeWorkspaceFile("a.md", "A");
    const [a] = await trashPaths(["a.md"]);
    render(<TrashPanel open onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("trash-item")).toHaveLength(1));
    await restoreFromTrash(a.id); // no change event: the row is still shown
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.queryAllByTestId("trash-item")).toHaveLength(0));
    expect(await readWorkspaceFile("a.md")).toBe("A");
    expect(await listTrash()).toEqual([]);
    expect(useToastStore.getState().toasts.filter((t) => t.kind === "error")).toHaveLength(0);
  });
});
