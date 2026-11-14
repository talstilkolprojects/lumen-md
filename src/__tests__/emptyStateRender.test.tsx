/**
 * Plan W3.2 — empty states show one action, and the trash asks before
 * deleting for good.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const confirm = vi.fn();
vi.mock("../ui/PromptDialog", () => ({ uiConfirm: (...a: unknown[]) => confirm(...a), uiAlert: vi.fn(), uiPrompt: vi.fn(), uiSelect: vi.fn() }));
const trash = { items: [] as { id: string; originalPath: string; trashedAt: number; kind: "file" }[], emptyTrash: vi.fn(async () => 0) };
vi.mock("../storage/trash", () => ({
  TRASH_KEEP_MS: 30 * 86_400_000,
  listTrash: async () => trash.items,
  emptyTrash: (...a: unknown[]) => trash.emptyTrash(...(a as [])),
  restoreFromTrash: vi.fn(),
}));

import { EmptyState, runCommand } from "../ui/EmptyState";
import { TrashPanel } from "../ui/TrashPanel";
import { t } from "../i18n";

beforeEach(() => {
  confirm.mockReset();
  trash.emptyTrash.mockClear();
  trash.items = [];
});

describe("EmptyState", () => {
  it("shows the sentence and its one action", () => {
    const onClick = vi.fn();
    render(<EmptyState message="Nothing here yet." action={{ label: "Create one", onClick }} />);
    expect(screen.getByRole("status").textContent).toContain("Nothing here yet.");
    fireEvent.click(screen.getByRole("button", { name: "Create one" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("runCommand hands the id to the palette", () => {
    const ids: string[] = [];
    const on = (e: Event) => ids.push((e as CustomEvent<{ id: string }>).detail.id);
    window.addEventListener("lumen-run-command", on);
    runCommand("file.new");
    window.removeEventListener("lumen-run-command", on);
    expect(ids).toEqual(["file.new"]);
  });
});

describe("TrashPanel", () => {
  it("empty: says so and offers the way back", async () => {
    const onClose = vi.fn();
    render(<TrashPanel open onClose={onClose} />);
    const action = await screen.findByRole("button", { name: t("trash.backToNotes") });
    expect(screen.getByRole("status").textContent).toContain(t("trash.empty"));
    fireEvent.click(action);
    expect(onClose).toHaveBeenCalled();
  });

  it("delete forever and empty trash ask first; no means nothing is deleted", async () => {
    trash.items = [{ id: "a", originalPath: "notes/a.md", trashedAt: Date.now(), kind: "file" }];
    confirm.mockResolvedValue(false);
    render(<TrashPanel open onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: t("trash.deleteForever") }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(String(confirm.mock.calls[0][0].message)).toContain("notes/a.md");
    fireEvent.click(screen.getByRole("button", { name: t("trash.emptyAll") }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(trash.emptyTrash).not.toHaveBeenCalled();

    confirm.mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: t("trash.emptyAll") }));
    await waitFor(() => expect(trash.emptyTrash).toHaveBeenCalledTimes(1));
  });
});
