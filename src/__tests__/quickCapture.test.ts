/**
 * Plan 4.16 — quick capture to inbox.md: the entry format (timestamp, link
 * to the day's daily note, Hebrew kept as typed), appending (creates the
 * inbox when missing, never rewrites what is there, keeps unsaved edits of
 * an open inbox), the share target and the `?capture=1` launch, and the
 * desktop shortcut's feature check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QuickCapture } from "../ui/QuickCapture";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { useAppStore } from "../store/useStore";
import { listWorkspace, readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";
import { DEFAULT_DAILY } from "../daily/dailyNote";
import { appendEntry, captureShared, captureToInbox, formatEntry, INBOX_PATH, openInbox, sharedText } from "../capture/quickCapture";
import { parseLaunch, sharedItem } from "../pwa/launch";
import { registerGlobalCapture } from "../capture/desktopShortcut";

const at = new Date(2026, 9, 20, 9, 5); // 20 Oct 2026, 09:05 local time

describe("formatEntry", () => {
  it("a list item with the day's note and the time", () => {
    expect(formatEntry("call the plumber", at, DEFAULT_DAILY)).toBe("- [[journal/2026-10-20]] 09:05 call the plumber");
  });
  it("follows the daily-note file pattern", () => {
    expect(formatEntry("x", at, { folder: "", pattern: "DD.MM.YYYY" })).toBe("- [[20.10.2026]] 09:05 x");
    expect(formatEntry("x", at, { folder: "diary/daily", pattern: "YYYY-MM-DD" })).toBe("- [[diary/daily/2026-10-20]] 09:05 x");
    // Wiki links can't escape # [ ], and the bare file name could open another note: plain date (review #268)
    expect(formatEntry("x", at, { folder: "C# notes", pattern: "YYYY-MM-DD" })).toBe("- 2026-10-20 09:05 x");
    expect(formatEntry("x", at, { folder: "[daily]", pattern: "YYYY-MM-DD" })).toBe("- 2026-10-20 09:05 x");
    expect(formatEntry("x", at, { folder: "journal", pattern: "#YYYY-MM-DD" })).toBe("- 2026-10-20 09:05 x");
  });
  it("keeps Hebrew, bidi marks and emoji exactly as typed", () => {
    const he = "לקנות חלב ‏(2 ליטר) ו־Notion ⁧שלום⁩ 🥛";
    expect(formatEntry(he, at, DEFAULT_DAILY)).toBe(`- [[journal/2026-10-20]] 09:05 ${he}`);
  });
  it("further lines stay inside the item; blank edges and trailing spaces go", () => {
    expect(formatEntry("\n\n first  \r\nsecond line   \n\nthird\n\n", at, DEFAULT_DAILY)).toBe("- [[journal/2026-10-20]] 09:05 first\n  second line\n\n  third");
  });
  it("nothing to capture → null", () => {
    expect(formatEntry("", at, DEFAULT_DAILY)).toBeNull();
    expect(formatEntry("  \n \t\n", at, DEFAULT_DAILY)).toBeNull();
  });
});

describe("appendEntry", () => {
  it("a missing inbox starts with a heading", () => {
    expect(appendEntry(null, "- a", "Inbox")).toBe("# Inbox\n\n- a\n");
    expect(appendEntry(null, "- a", "תיבת הנכנסים")).toBe("# תיבת הנכנסים\n\n- a\n");
  });
  it("existing text is kept byte for byte, the entry goes after it", () => {
    expect(appendEntry("# Mine\n\n- old\n", "- new")).toBe("# Mine\n\n- old\n- new\n");
    // No final newline: one is added so the entry starts its own line.
    expect(appendEntry("- old", "- new")).toBe("- old\n- new\n");
    expect(appendEntry("", "- new")).toBe("- new\n");
    const odd = "שורה ‏עם RLM\r\n\n\n   ";
    expect(appendEntry(odd, "- new").startsWith(odd)).toBe(true);
  });
});

describe("captureToInbox", () => {
  beforeEach(() => {
    installFakeOpfs();
    useAppStore.setState({ doc: { name: "Untitled.md", content: "", dirty: false, workspaceName: null }, openTabs: [], dailyNotes: { ...DEFAULT_DAILY } });
  });

  it("creates inbox.md when it is missing, and the linked daily note", async () => {
    expect(await captureToInbox("first", at)).toBe(INBOX_PATH);
    expect((await listWorkspace()).map((f) => f.path).sort()).toEqual(["inbox.md", "journal/2026-10-20.md"]);
    expect(await readWorkspaceFile(INBOX_PATH)).toBe("# Inbox\n\n- [[journal/2026-10-20]] 09:05 first\n");
  });

  it("an existing daily note is left alone", async () => {
    await writeWorkspaceFile("journal/2026-10-20.md", "my day");
    await captureToInbox("x", at);
    expect(await readWorkspaceFile("journal/2026-10-20.md")).toBe("my day");
  });

  it("never overwrites what is already there", async () => {
    await writeWorkspaceFile(INBOX_PATH, "# My inbox\n\n- [ ] keep me");
    await captureToInbox("second", at);
    expect(await readWorkspaceFile(INBOX_PATH)).toBe("# My inbox\n\n- [ ] keep me\n- [[journal/2026-10-20]] 09:05 second\n");
  });

  it("preserves Hebrew / RTL text through the vault", async () => {
    const he = "רעיון: לכתוב פוסט על RTL ‏— בלי לשבור את הסדר";
    await captureToInbox(he, at);
    expect(await readWorkspaceFile(INBOX_PATH)).toContain(`- [[journal/2026-10-20]] 09:05 ${he}\n`);
  });

  it("two captures at once both land, in order", async () => {
    await Promise.all([captureToInbox("one", at), captureToInbox("two", at), captureToInbox("three", at)]);
    expect(await readWorkspaceFile(INBOX_PATH)).toBe("# Inbox\n\n- [[journal/2026-10-20]] 09:05 one\n- [[journal/2026-10-20]] 09:05 two\n- [[journal/2026-10-20]] 09:05 three\n");
  });

  it("empty text writes nothing", async () => {
    expect(await captureToInbox("   ", at)).toBeNull();
    expect(await listWorkspace()).toEqual([]);
  });

  it("an open inbox keeps its unsaved edits and shows the entry", async () => {
    await writeWorkspaceFile(INBOX_PATH, "# Inbox\n");
    useAppStore.getState().openTab({ name: INBOX_PATH, content: "# Inbox\n", workspaceName: INBOX_PATH });
    useAppStore.getState().setContent("# Inbox\n- typed, not saved yet\n");
    await captureToInbox("captured", at);
    const want = "# Inbox\n- typed, not saved yet\n- [[journal/2026-10-20]] 09:05 captured\n";
    expect(await readWorkspaceFile(INBOX_PATH)).toBe(want);
    const s = useAppStore.getState();
    expect(s.doc.content).toBe(want);
    // Still dirty: autosave writes it after any older autosave in flight.
    expect(s.doc.dirty).toBe(true);
    expect(s.openTabs.find((x) => x.workspaceName === INBOX_PATH)?.content).toBe(want);
  });

  it("an inbox open in a background tab follows the file", async () => {
    await writeWorkspaceFile(INBOX_PATH, "# Inbox\n");
    useAppStore.getState().openTab({ name: INBOX_PATH, content: "# Inbox\n- unsaved\n", workspaceName: INBOX_PATH });
    useAppStore.getState().openTab({ name: "other.md", content: "x", workspaceName: null });
    await captureToInbox("bg", at);
    const want = "# Inbox\n- unsaved\n- [[journal/2026-10-20]] 09:05 bg\n";
    expect(await readWorkspaceFile(INBOX_PATH)).toBe(want);
    const tab = useAppStore.getState().openTabs.find((x) => x.workspaceName === INBOX_PATH);
    expect(tab?.content).toBe(want);
    // Stays dirty: an older autosave may still land after this write (review #268).
    expect(tab?.dirty).toBe(true);
    expect(useAppStore.getState().doc.name).toBe("other.md");
  });

  it("openInbox creates a missing inbox", async () => {
    await openInbox();
    expect(await readWorkspaceFile(INBOX_PATH)).toBe("# Inbox\n\n");
    expect(useAppStore.getState().doc.workspaceName).toBe(INBOX_PATH);
  });

  it("openInbox shows the inbox in one tab", async () => {
    await captureToInbox("a", at);
    await openInbox();
    await openInbox();
    const s = useAppStore.getState();
    expect(s.doc.workspaceName).toBe(INBOX_PATH);
    expect(s.openTabs.filter((x) => x.workspaceName === INBOX_PATH)).toHaveLength(1);
  });
});

describe("the capture box", () => {
  beforeEach(() => {
    installFakeOpfs();
    useAppStore.setState({ doc: { name: "Untitled.md", content: "", dirty: false, workspaceName: null }, openTabs: [], dailyNotes: { ...DEFAULT_DAILY } });
  });
  afterEach(cleanup);

  it("type, Enter → appended to inbox.md and closed", async () => {
    const onClose = vi.fn();
    render(createElement(QuickCapture, { open: true, onClose }));
    const field = screen.getByRole("textbox");
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "רעיון חדש" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(await readWorkspaceFile(INBOX_PATH)).toMatch(/^# Inbox\n\n- \[\[journal\/\d{4}-\d{2}-\d{2}\]\] \d{2}:\d{2} רעיון חדש\n$/);
  });

  it("Shift+Enter doesn't save; Esc closes without saving", async () => {
    const onClose = vi.fn();
    render(createElement(QuickCapture, { open: true, onClose }));
    const field = screen.getByRole("textbox");
    fireEvent.change(field, { target: { value: "draft" } });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(await listWorkspace()).toEqual([]);
  });

  it("the Add button saves; empty text can't be added", async () => {
    const onClose = vi.fn();
    render(createElement(QuickCapture, { open: true, onClose }));
    const add = screen.getByRole("button", { name: "Add to inbox" });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "by click" } });
    fireEvent.click(add);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(await readWorkspaceFile(INBOX_PATH)).toContain("by click\n");
  });

  it("closed → renders nothing", () => {
    const { container } = render(createElement(QuickCapture, { open: false, onClose: () => {} }));
    expect(container.innerHTML).toBe("");
  });
});

describe("share target → inbox", () => {
  beforeEach(() => {
    installFakeOpfs();
    useAppStore.setState({ doc: { name: "Untitled.md", content: "", dirty: false, workspaceName: null }, openTabs: [], dailyNotes: { ...DEFAULT_DAILY } });
  });

  it("reads title, text and link (Android puts the link in text)", () => {
    expect(sharedItem("")).toBeNull();
    expect(sharedItem("?title=T&text=hello&url=https%3A%2F%2Fex.com%2Fa")).toEqual({ title: "T", text: "hello", link: "https://ex.com/a" });
    expect(sharedItem("?text=https%3A%2F%2Fex.com%2Fb")).toEqual({ title: "", text: "", link: "https://ex.com/b" });
  });

  it("formats the shared item as one entry", () => {
    expect(sharedText({ title: "Page", text: "quote", link: "https://ex.com" })).toBe("Page <https://ex.com>\nquote");
    expect(sharedText({ title: "", text: "רק טקסט", link: "" })).toBe("רק טקסט");
  });

  it("appends the shared item and opens the inbox", async () => {
    await writeWorkspaceFile(INBOX_PATH, "# Inbox\n\n- older\n");
    const item = sharedItem("?title=" + encodeURIComponent("כתבה") + "&text=" + encodeURIComponent("שווה לקרוא") + "&url=" + encodeURIComponent("https://example.com/a"))!;
    expect(await captureShared(item)).toBe(INBOX_PATH);
    const text = await readWorkspaceFile(INBOX_PATH);
    expect(text.startsWith("# Inbox\n\n- older\n")).toBe(true);
    expect(text).toMatch(/- \[\[journal\/\d{4}-\d{2}-\d{2}\]\] \d{2}:\d{2} כתבה <https:\/\/example\.com\/a>\n {2}שווה לקרוא\n$/);
    expect(useAppStore.getState().doc.workspaceName).toBe(INBOX_PATH);
  });

  it("?capture=1 and ?action=capture open the capture box", () => {
    expect(parseLaunch("?capture=1")).toEqual({ kind: "action", action: "capture" });
    expect(parseLaunch("?action=capture")).toEqual({ kind: "action", action: "capture" });
    expect(parseLaunch("?capture=0")).toEqual({ kind: "none" });
  });
});

describe("desktop global shortcut (feature check)", () => {
  it("does nothing outside the desktop app", async () => {
    const cb = vi.fn();
    expect(await registerGlobalCapture(cb)).toBe(false);
    expect(cb).not.toHaveBeenCalled();
  });

  it("registers through the plugin when the shell has it, and opens on press", async () => {
    const calls: Array<[string, unknown]> = [];
    // An object, not a `let`: TS doesn't see the assignment made inside the mock.
    const got: { handler?: { onmessage?: (e: { shortcut: string; state: string }) => void } } = {};
    vi.doMock("@tauri-apps/api/core", () => ({
      Channel: class {
        onmessage?: (e: unknown) => void;
      },
      invoke: async (cmd: string, args: { handler?: typeof got.handler }) => {
        calls.push([cmd, args]);
        if (cmd === "plugin:global-shortcut|register") got.handler = args.handler;
        return null;
      },
    }));
    vi.doMock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ show: async () => {}, unminimize: async () => {}, setFocus: async () => {} }) }));
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      vi.resetModules();
      vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
      const { registerGlobalCapture: register, GLOBAL_CAPTURE_SHORTCUT } = await import("../capture/desktopShortcut");
      expect(GLOBAL_CAPTURE_SHORTCUT).toBe("Alt+Command+N");
      const cb = vi.fn();
      expect(await register(cb)).toBe(true);
      expect(calls.map((c) => c[0])).toEqual(["plugin:global-shortcut|unregister", "plugin:global-shortcut|register"]);
      expect(calls[1][1]).toMatchObject({ shortcuts: [GLOBAL_CAPTURE_SHORTCUT] });
      got.handler!.onmessage!({ shortcut: GLOBAL_CAPTURE_SHORTCUT, state: "Released" });
      expect(cb).not.toHaveBeenCalled();
      got.handler!.onmessage!({ shortcut: GLOBAL_CAPTURE_SHORTCUT, state: "Pressed" });
      expect(cb).toHaveBeenCalledTimes(1);
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      vi.restoreAllMocks();
      vi.doUnmock("@tauri-apps/api/core");
      vi.doUnmock("@tauri-apps/api/window");
    }
  });

  it("registers nothing on Windows / Linux, where Ctrl+Alt+N is also AltGr+N (review #268)", async () => {
    const calls: string[] = [];
    vi.doMock("@tauri-apps/api/core", () => ({
      Channel: class {},
      invoke: async (cmd: string) => {
        calls.push(cmd);
        return null;
      },
    }));
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      vi.resetModules();
      vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
      const { registerGlobalCapture: register } = await import("../capture/desktopShortcut");
      expect(await register(() => {})).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      vi.restoreAllMocks();
      vi.doUnmock("@tauri-apps/api/core");
    }
  });

  it("a build without the plugin reports false", async () => {
    vi.doMock("@tauri-apps/api/core", () => ({
      Channel: class {},
      invoke: async (cmd: string) => {
        throw new Error(`${cmd} not allowed. Plugin not found`);
      },
    }));
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      vi.resetModules();
      vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
      const { registerGlobalCapture: register } = await import("../capture/desktopShortcut");
      expect(await register(() => {})).toBe(false);
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      vi.restoreAllMocks();
      vi.doUnmock("@tauri-apps/api/core");
    }
  });
});
