/**
 * Plan 3.2 — the Version History panel shows collab versions (with their
 * author) and whether the browser keeps the storage.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import * as history from "../storage/history";

vi.mock("../storage/persistentStorage", () => ({
  storageState: vi.fn(async () => ({ persisted: false, usage: 850 * 1024 * 1024, quota: 1024 * 1024 * 1024 })),
  requestPersistentStorage: vi.fn(async () => "persisted"),
}));

import { VersionHistory } from "../ui/VersionHistory";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  history.__resetHistoryDb();
});
afterEach(cleanup);

describe("<VersionHistory>", () => {
  it("lists a collab version with its author and shows the storage state", async () => {
    await history.recordSnapshot("team/Shared.md", "from the session", "collab", 1000, "Blue Fox");
    render(<VersionHistory fileName="team/Shared.md" currentContent="" onRestore={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/collab session/)).toBeTruthy());
    expect(screen.getByText(/by Blue Fox/)).toBeTruthy();
    const status = await screen.findByTestId("storage-status");
    expect(status.dataset.persisted).toBe("false");
    expect(status.textContent).toMatch(/not persistent/);
    expect(status.textContent).toMatch(/83%/);
    expect(screen.getByRole("button", { name: "Keep my storage" })).toBeTruthy();
  });
});
