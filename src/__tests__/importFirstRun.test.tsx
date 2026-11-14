/**
 * Plan W11.P6 — import-first onboarding: the first run's last step offers an
 * empty note, "Bring your notes" (six sources, into the import wizard) and
 * opening an Obsidian folder as it is; after an import the wizard shows the
 * report, a sample search over the imported notes, and Undo. The import runs
 * for real (prepare → commit → undo) on the in-memory OPFS; the exports are
 * the repository's synthetic fixtures (src/__tests__/fixtures/import).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import FirstRun from "../onboarding/FirstRun";
import { setupDue } from "../onboarding/setup";
import { FIRST_RUN_SOURCES, OPEN_IMPORT_EVENT, readOpenImport, sampleSearchQuery } from "../onboarding/importFirst";
import { ImportWizard } from "../storage/import/ImportWizard";
import { workspaceHasEntry } from "../storage/workspace";
import { keepExport } from "./fixtures/import/exports";

vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));

beforeAll(async () => {
  installFakeOpfs();
  await import("../storage/vault/location");
});
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
});

const toStart = () => {
  for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "Next" }));
};

describe("the first run's last step", () => {
  it("offers the sample (still the default), an empty note, Bring your notes, and an Obsidian folder", () => {
    render(<FirstRun onDone={() => {}} />);
    toStart();
    expect(screen.getByRole("radio", { name: /A sample vault/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("radio", { name: /An empty vault/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Bring your notes/ })).toBeTruthy();
    // No folder picker here: the choice says so and is disabled.
    expect(screen.getByRole("radio", { name: /Open an Obsidian folder/ })).toHaveProperty("disabled", true);
    expect(screen.queryByTestId("first-run-sources")).toBeNull();
  });

  it("Bring your notes lists the six sources; finishing ends setup and opens the wizard on the source picked", async () => {
    const onDone = vi.fn();
    const opened: Event[] = [];
    const on = (e: Event) => opened.push(e);
    window.addEventListener(OPEN_IMPORT_EVENT, on);
    try {
      render(<FirstRun onDone={onDone} />);
      toStart();
      fireEvent.click(screen.getByRole("radio", { name: /Bring your notes/ }));
      const group = screen.getByRole("group", { name: "Where are your notes now?" });
      const names = Array.from(group.querySelectorAll("label") as NodeListOf<HTMLLabelElement>).map((l: HTMLLabelElement) => l.textContent);
      expect(names).toEqual(["Notion", "Evernote", "Apple Notes", "Google Keep", "OneNote", "Obsidian"]);
      expect(FIRST_RUN_SOURCES).toHaveLength(6);
      fireEvent.click(screen.getByRole("radio", { name: "Google Keep" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Choose the export" }));
      });
      await waitFor(() => expect(onDone).toHaveBeenCalledWith(null));
      expect(setupDue()).toBe(false);
      expect(opened).toHaveLength(1);
      expect(readOpenImport(opened[0], FIRST_RUN_SOURCES)).toEqual({ source: "keep", firstRun: true });
    } finally {
      window.removeEventListener(OPEN_IMPORT_EVENT, on);
    }
  });

  it("Open an Obsidian folder: picks the folder and opens it as the vault, writing no note into it", async () => {
    const root = await navigator.storage.getDirectory();
    const vault = await root.getDirectoryHandle("My Obsidian vault", { create: true });
    const note = await (await vault.getFileHandle("Inbox.md", { create: true })).createWritable();
    await note.write("# Inbox\n");
    await note.close();
    const picker = vi.fn(async () => vault);
    (window as { showDirectoryPicker?: unknown }).showDirectoryPicker = picker;
    const onDone = vi.fn();
    render(<FirstRun onDone={onDone} />);
    toStart();
    const folderPath = screen.getByRole("radio", { name: /Open an Obsidian folder/ });
    expect(folderPath).toHaveProperty("disabled", false);
    fireEvent.click(folderPath);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open the folder" }));
    });
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(null));
    expect(picker).toHaveBeenCalledOnce();
    expect(setupDue()).toBe(false);
    const names: string[] = [];
    for await (const [n] of (vault as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) names.push(n);
    expect(names.filter((n) => n.endsWith(".md"))).toEqual(["Inbox.md"]);
  });

  it("an empty note still creates the first note (the existing path)", async () => {
    const onDone = vi.fn();
    render(<FirstRun onDone={onDone} />);
    toStart();
    fireEvent.click(screen.getByRole("radio", { name: /An empty vault/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start writing" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone.mock.calls[0][0].note.path).toMatch(/^First note( \d+)?\.md$/);
  });
});

describe("after the import: report, a sample search over the imported notes, Undo", () => {
  it("imports a Google Keep export opened from the first run, searches it, and undo takes it back", async () => {
    const searches: string[] = [];
    const onSearch = (e: Event) => searches.push(String((e as CustomEvent<{ query?: string }>).detail?.query));
    window.addEventListener("lumen-open-search", onSearch);
    const onClose = vi.fn();
    try {
      render(<ImportWizard open onClose={onClose} initialSource="keep" firstRun />);
      expect(screen.getByTestId("import-source-keep").getAttribute("aria-checked")).toBe("true");
      const files = [...(await keepExport()).entries()].map(([p, bytes]) => {
        const f = new File([bytes as BlobPart], p.split("/").pop()!);
        Object.defineProperty(f, "webkitRelativePath", { value: p });
        return f;
      });
      await act(async () => {
        fireEvent.change(screen.getByTestId("import-folder-input"), { target: { files } });
      });
      await waitFor(() => expect(screen.getByTestId("import-start")).toBeTruthy(), { timeout: 10_000 });
      await act(async () => {
        fireEvent.click(screen.getByTestId("import-start"));
      });
      await waitFor(() => expect(screen.getByTestId("import-done")).toBeTruthy(), { timeout: 10_000 });
      expect(screen.getByTestId("import-sample-search").textContent).toContain("Your notes are here");
      const button = screen.getByTestId("import-search");
      const query = /“(.+)”/.exec(button.textContent ?? "")?.[1];
      expect(query && query.length >= 3).toBe(true);
      expect(screen.getByTestId("import-undo")).toBeTruthy();
      const folder = /“(Imported\/[^”]+)”/.exec(screen.getByTestId("import-done").textContent ?? "")?.[1];
      expect(folder).toBeTruthy();
      expect(await workspaceHasEntry(folder!)).toBe(true);
      fireEvent.click(button);
      expect(onClose).toHaveBeenCalled();
      expect(searches).toEqual([query]);
    } finally {
      window.removeEventListener("lumen-open-search", onSearch);
    }
  });
});

describe("the sample search word", () => {
  it("the word in the most notes, ≥ 3 letters, no stop words, Hebrew kept (NFC)", () => {
    const notes = new Map([
      ["a.md", "# מתכון חלה\nקמח, שמרים ומלח. מתכון של סבתא."],
      ["b.md", "מתכון לעוגה: קמח וסוכר"],
      ["c.md", "the shopping list for the week"],
      ["d.png", "מתכון מתכון מתכון מתכון"], // not a note
    ]);
    expect(sampleSearchQuery(notes)).toBe("מתכון");
    expect(sampleSearchQuery(new Map([["x.md", "<b>a</b> https://example.org/abc 12 34"]]))).toBeNull();
    expect(sampleSearchQuery(new Map([["x.md", "Alpha beta"], ["y.md", "beta Alpha"]]))).toBe("alpha");
  });

  it("an open-import event only carries a known source and a boolean", () => {
    const ev = (detail: unknown) => new CustomEvent(OPEN_IMPORT_EVENT, { detail });
    expect(readOpenImport(ev({ source: "keep", firstRun: true }), FIRST_RUN_SOURCES)).toEqual({ source: "keep", firstRun: true });
    expect(readOpenImport(ev({ source: "../../etc", firstRun: "yes" }), FIRST_RUN_SOURCES)).toEqual({ source: undefined, firstRun: false });
    expect(readOpenImport(new Event(OPEN_IMPORT_EVENT), FIRST_RUN_SOURCES)).toEqual({});
  });
});
