/**
 * First-run setup (plan 14.1): the samples in Hebrew and English, the first
 * note, the done flag, and the dialog's steps, skip and finish.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { readWorkspaceFile, workspaceHasFile } from "../storage/workspace";
import { sampleWorkspaceFiles, SAMPLE_ROOT } from "../storage/sampleWorkspace";
import { sampleWorkspaceFilesHe, SAMPLE_ROOT_HE, SAMPLE_ENTRY_HE } from "../storage/sampleWorkspaceHe";
import { resolveWikiTarget } from "../renderer/wikiLinks";
import { extractFrontmatter } from "../renderer/pipeline";
import { parseDatabaseSpec } from "../views/database";
import { createFirstNote, DONE_KEY, markSetupDone, setupDue } from "../onboarding/setup";
import FirstRun from "../onboarding/FirstRun";
import { useAppStore } from "../store/useStore";

vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));
// The vault's place, settable per test (reopening setup with a folder vault).
const vaultState = vi.hoisted(() => ({ status: null as null | { location: string; name?: string }, toBrowser: 0, reconnects: 0, allowReconnect: false }));
vi.mock("../storage/vault/location", async (orig) => {
  const real = await orig<typeof import("../storage/vault/location")>();
  return {
    ...real,
    getVaultStatus: () => (vaultState.status ?? real.getVaultStatus()) as ReturnType<typeof real.getVaultStatus>,
    reconnectVaultFolder: async () => {
      vaultState.reconnects++;
      if (vaultState.allowReconnect) vaultState.status = { location: "folder", name: vaultState.status?.name };
      return vaultState.allowReconnect;
    },
    switchToBrowserStorage: async () => {
      vaultState.toBrowser++;
      vaultState.status = { location: "opfs" };
    },
  };
});

beforeAll(async () => {
  installFakeOpfs();
  // The first dynamic import of the vault-location module (setup.ts reads the
  // vault's place through it) transforms a large graph; load it once up front
  // so a dialog's first status read isn't slower than waitFor's 1 s.
  await import("../storage/vault/location");
});
beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

const LINK = /!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

describe("the Hebrew sample", () => {
  const he = sampleWorkspaceFilesHe();
  const paths = he.map((f) => `${SAMPLE_ROOT_HE}/${f.path}`);

  it("mirrors the English one, note for note", () => {
    expect(he).toHaveLength(sampleWorkspaceFiles().length);
    for (const f of he) expect(f.content).toMatch(/[֐-׿]/);
  });

  it("every [[link]] names a note in it", () => {
    for (const f of he) for (const m of f.content.matchAll(LINK)) expect(resolveWikiTarget(m[1].trim(), paths), `${f.path} → ${m[1]}`).not.toBeNull();
  });

  it("its boards read its own project folder, and projects have the fields they show", () => {
    const board = he.find((f) => f.path === "לוח פרויקטים.md")!;
    const specs = [...board.content.matchAll(/```database\n([\s\S]*?)```/g)].map((m) => parseDatabaseSpec(m[1]));
    expect(specs.length).toBe(2);
    for (const s of specs) expect(s.spec?.source).toBe(`${SAMPLE_ROOT_HE}/פרויקטים`);
    const projects = he.filter((f) => f.path.startsWith("פרויקטים/"));
    expect(projects).toHaveLength(3);
    for (const p of projects) {
      const fm = extractFrontmatter(p.content)!;
      expect(fm.type).toBe("project");
      expect(fm.status && fm.owner && fm.due).toBeTruthy();
    }
  });
});

describe("createFirstNote", () => {
  it("the sample in Hebrew for a Hebrew interface, its start page first", async () => {
    const n = await createFirstNote("sample", "he");
    expect(n.path).toBe(`${SAMPLE_ROOT_HE}/${SAMPLE_ENTRY_HE}`);
    expect(n.content).toContain("ברוכים הבאים");
    expect(await workspaceHasFile(`${SAMPLE_ROOT_HE}/פרויקטים/עיצוב האתר.md`)).toBe(true);
  });

  it("the English sample for any other language", async () => {
    const n = await createFirstNote("sample", "de");
    expect(n.path).toBe(`${SAMPLE_ROOT}/Start Here.md`);
  });

  it("an empty vault gets one first note, never over an existing one", async () => {
    const a = await createFirstNote("empty", "en");
    const b = await createFirstNote("empty", "en");
    expect(a.path).toBe("First note.md");
    expect(b.path).toBe("First note 2.md");
    expect(await readWorkspaceFile(a.path)).toMatch(/^# My first note/);
  });
});

describe("the done flag", () => {
  it("setup is due until it is finished or skipped", () => {
    expect(setupDue()).toBe(true);
    markSetupDone();
    expect(localStorage.getItem(DONE_KEY)).toBe("1");
    expect(setupDue()).toBe(false);
  });
});

describe("FirstRun", () => {
  it("is a labelled dialog that walks four steps; the language applies at once", async () => {
    render(<FirstRun onDone={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "Welcome to Lumen" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("radio", { name: "English" })).toHaveProperty("checked", true);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "English" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "עברית" }));
    });
    await waitFor(() => expect(useAppStore.getState().locale).toBe("he"));
    expect(document.documentElement.dir).toBe("rtl");
    await act(async () => {
      useAppStore.getState().setLocale("en");
    });
    await waitFor(() => expect(document.documentElement.dir).toBe("ltr"));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("group", { name: "Where your notes live" })).toBeTruthy();
    // jsdom has no folder picker: the folder choice says so and is disabled.
    expect(screen.getByRole("radio", { name: /A folder on this computer/ })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("radio", { name: "Sepia" }));
    expect(useAppStore.getState().themeSettings.preset).toBe("sepia");
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(useAppStore.getState().theme).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Import an Obsidian vault (folder)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start writing" })).toBeTruthy();
    useAppStore.getState().resetThemeSettings();
  });

  it("Start writing creates the first note and hands it over", async () => {
    const onDone = vi.fn();
    render(<FirstRun onDone={onDone} />);
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("radio", { name: /An empty vault/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start writing" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone.mock.calls[0][0].note.path).toMatch(/^First note( \d+)?\.md$/);
    expect(setupDue()).toBe(false);
  });

  it("Skip setup (or Escape) ends it without creating anything", () => {
    const onDone = vi.fn();
    render(<FirstRun onDone={onDone} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDone).toHaveBeenCalledWith(null);
    expect(setupDue()).toBe(false);
    cleanup();
    localStorage.clear();
    const again = vi.fn();
    render(<FirstRun onDone={again} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip setup" }));
    expect(again).toHaveBeenCalledWith(null);
  });

  it("reopened with the vault in a folder, it shows the folder and can move back to browser storage", async () => {
    vaultState.status = { location: "folder", name: "Notes" };
    vaultState.toBrowser = 0;
    Object.assign(window, { showDirectoryPicker: async () => ({}) });
    try {
      render(<FirstRun onDone={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      await waitFor(() => expect(screen.getByRole("radio", { name: /A folder on this computer/ })).toHaveProperty("checked", true));
      await act(async () => {
        fireEvent.click(screen.getByRole("radio", { name: /In this browser/ }));
      });
      expect(vaultState.toBrowser).toBe(1);
      expect(screen.getByRole("radio", { name: /In this browser/ })).toHaveProperty("checked", true);
    } finally {
      vaultState.status = null;
      delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    }
  });

  it("a folder that needs permission again is offered for reconnecting, and Start writing asks before writing", async () => {
    vaultState.status = { location: "folder-disconnected", name: "Notes" };
    vaultState.reconnects = 0;
    vaultState.allowReconnect = false;
    Object.assign(window, { showDirectoryPicker: async () => ({}) });
    const onDone = vi.fn();
    try {
      render(<FirstRun onDone={onDone} />);
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      const again = await screen.findByRole("button", { name: "Reconnect folder" });
      expect(screen.getByText(/Lumen needs your permission to open it again/)).toBeTruthy();
      await act(async () => {
        fireEvent.click(again);
      });
      expect(vaultState.reconnects).toBe(1);
      expect(screen.getByRole("status").textContent).toContain("wasn't allowed to use “Notes”");
      // Refused again at Start writing: nothing is created.
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Start writing" }));
      });
      expect(vaultState.reconnects).toBe(2);
      expect(onDone).not.toHaveBeenCalled();
      // Allowed: the folder is back and setup goes on.
      vaultState.allowReconnect = true;
      fireEvent.click(screen.getByRole("radio", { name: /An empty vault/ }));
      fireEvent.click(screen.getByRole("button", { name: "Start writing" }));
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(vaultState.reconnects).toBe(3);
    } finally {
      vaultState.status = null;
      delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    }
  });

  it("Start writing right after picking a language that is still loading writes the note in that language", async () => {
    const onDone = vi.fn();
    render(<FirstRun onDone={onDone} />);
    // French hasn't been loaded in this file yet: picking it starts the fetch.
    fireEvent.click(screen.getByRole("radio", { name: "Français" }));
    expect(screen.getByRole("radio", { name: "Français" })).toHaveProperty("checked", true);
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getAllByRole("button").at(-1)!);
    fireEvent.click(screen.getAllByRole("radio").at(-1)!); // the empty vault (labels may still be English or French)
    fireEvent.click(screen.getAllByRole("button").at(-1)!);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone.mock.calls[0][0].note.path).toMatch(/^Première note( \d+)?\.md$/);
    await act(async () => {
      useAppStore.getState().setLocale("en");
    });
  });
});
