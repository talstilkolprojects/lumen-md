/**
 * src/App.tsx — the shell that wires the store, storage, keyboard,
 * window events and the overlay panels together.
 *
 * Every child surface (toolbar, editor layout, panels, dialogs) is a stub
 * that renders `[Name]` and records the props it was given, so each test
 * can assert what App passes down and call the callbacks App hands out —
 * exactly what a click inside the real child would do. Storage (file
 * dialogs, OPFS workspace, recents, history) is mocked; the app store,
 * i18n and the AI toast stack are the real ones.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import type { UseCommandsOptions } from "../commands/useCommands";
import type { MenuActions } from "../hooks/useTauriMenu";

type Props = Record<string, unknown>;
type AnyFn = (...args: unknown[]) => unknown;

const h = await vi.hoisted(async () => {
  const { createElement } = await import("react");
  const props: Record<string, Props> = {};
  // Each stub is its own element, so `getByText("[Name]")` finds it.
  const stub = (name: string) =>
    function Stub(p: Props) {
      props[name] = p;
      return createElement("div", { "data-stub": name }, `[${name}]`);
    };
  return {
    props,
    stub,
    commandOpts: null as UseCommandsOptions | null,
    commands: [] as Array<{ id: string; label: string; action: AnyFn; children?: Array<{ id: string; label: string; action: AnyFn }> }>,
    menu: null as MenuActions | null,
    dragHover: false,
    openNewDoc: vi.fn<AnyFn>(),
    openFileDialog: vi.fn<AnyFn>(),
    saveFile: vi.fn<AnyFn>(),
    getRecents: vi.fn<AnyFn>(),
    pushRecent: vi.fn<AnyFn>(),
    reopenRecent: vi.fn<AnyFn>(),
    isOPFSAvailable: vi.fn<AnyFn>(),
    uniqueWorkspaceName: vi.fn<AnyFn>(),
    writeWorkspaceFile: vi.fn<AnyFn>(),
    writeWorkspaceBlob: vi.fn<AnyFn>(),
    readWorkspaceFile: vi.fn<AnyFn>(),
    workspaceHasFile: vi.fn<AnyFn>(),
    uiAlert: vi.fn<AnyFn>(),
    uiConfirm: vi.fn<AnyFn>(),
    uiPrompt: vi.fn<AnyFn>(),
    openInsertTextDialog: vi.fn<AnyFn>(),
    exportToHtml: vi.fn<AnyFn>(),
    recordSnapshot: vi.fn<AnyFn>(),
    scrollToHeading: vi.fn<AnyFn>(),
    parseLaunch: vi.fn<AnyFn>(),
    clearLaunchParams: vi.fn<AnyFn>(),
    onLaunchFiles: vi.fn<AnyFn>(),
  };
});

// ── Children: stubs ────────────────────────────────────────────────────
vi.mock("../ui/Toolbar", () => ({ Toolbar: h.stub("Toolbar") }));
vi.mock("../ui/Outline", () => ({ Outline: h.stub("Outline") }));
vi.mock("../ui/StatusBar", () => ({ StatusBar: h.stub("StatusBar") }));
vi.mock("../ui/ScrollProgress", () => ({ ScrollProgress: h.stub("ScrollProgress") }));
vi.mock("../ui/SearchReplace", () => ({ SearchReplace: h.stub("SearchReplace") }));
vi.mock("../ui/CommandPalette", () => ({ CommandPalette: h.stub("CommandPalette"), cmdIcons: {} }));
vi.mock("../ui/AiFab", () => ({ AiFab: h.stub("AiFab") }));
vi.mock("../ui/FileTree", () => ({ FileTree: h.stub("FileTree") }));
vi.mock("../ui/SidebarResizer", () => ({ SidebarResizer: h.stub("SidebarResizer") }));
vi.mock("../ui/BacklinksPanel", () => ({ BacklinksPanel: h.stub("BacklinksPanel") }));
vi.mock("../ui/AiSuggestionsPanel", () => ({ AiSuggestionsPanel: h.stub("AiSuggestionsPanel") }));
vi.mock("../ui/MobileKeyboardBar", () => ({ MobileKeyboardBar: h.stub("MobileKeyboardBar") }));
vi.mock("../ui/TagsPanel", () => ({ TagsPanel: h.stub("TagsPanel") }));
vi.mock("../ui/AiInlinePrompt", () => ({ AiInlinePromptOverlay: h.stub("AiInlinePromptOverlay"), openAiPrompt: () => {} }));
vi.mock("../ui/RuntimeMetricsPanel", () => ({ RuntimeMetricsPanel: h.stub("RuntimeMetricsPanel") }));
vi.mock("../ui/KeyboardShortcuts", () => ({ KeyboardShortcuts: h.stub("KeyboardShortcuts"), detectIsMac: () => false }));
vi.mock("../ui/FocusMode", () => ({ FocusMode: h.stub("FocusMode") }));
vi.mock("../ui/OnboardingTour", () => ({ OnboardingTour: h.stub("OnboardingTour") }));
vi.mock("../onboarding/FirstRun", () => ({ default: h.stub("FirstRun") }));
vi.mock("../layouts/EditorLayout", () => ({ EditorLayout: h.stub("EditorLayout") }));
vi.mock("../ui/DocTabs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/DocTabs")>()),
  DocTabs: h.stub("DocTabs"),
}));
// Lazy panels.
vi.mock("../ui/GraphView", () => ({ GraphView: h.stub("GraphView") }));
vi.mock("../ui/CanvasExcalidraw", () => ({ CanvasExcalidraw: h.stub("CanvasExcalidraw"), debouncedSave: () => {} }));
vi.mock("../ui/PluginGallery", () => ({ PluginGallery: h.stub("PluginGallery") }));
vi.mock("../ui/TemplateGallery", () => ({ TemplateGallery: h.stub("TemplateGallery") }));
vi.mock("../ui/AuditLog", () => ({ AuditLog: h.stub("AuditLog") }));
vi.mock("../ui/OrgSettings", () => ({ OrgSettings: h.stub("OrgSettings") }));
vi.mock("../ui/TrustedKeysSettings", () => ({ TrustedKeysSettings: h.stub("TrustedKeysSettings") }));
vi.mock("../ui/ThemeSettings", () => ({ ThemeSettings: h.stub("ThemeSettings") }));
vi.mock("../ui/AiSettingsPanel", () => ({ AiSettingsPanel: h.stub("AiSettingsPanel") }));
vi.mock("../ui/PrivacyLedgerPanel", () => ({ PrivacyLedgerPanel: h.stub("PrivacyLedgerPanel") }));
vi.mock("../ui/TrashPanel", () => ({ TrashPanel: h.stub("TrashPanel") }));
vi.mock("../ui/AiDoctorPanel", () => ({ AiDoctorPanel: h.stub("AiDoctorPanel") }));
vi.mock("../ui/FineTuneSettings", () => ({ FineTuneSettings: h.stub("FineTuneSettings") }));
vi.mock("../ui/VersionHistory", () => ({ VersionHistory: h.stub("VersionHistory") }));
vi.mock("../ui/MarkdownTableEditor", () => ({ MarkdownTableEditor: h.stub("MarkdownTableEditor") }));
vi.mock("../ui/SearchDialog", () => ({ SearchDialog: h.stub("SearchDialog") }));
vi.mock("../ui/CommentsPanel", () => ({ CommentsPanel: h.stub("CommentsPanel"), addCommentFromSelection: () => {} }));

// ── Hooks and services ─────────────────────────────────────────────────
vi.mock("../commands/useCommands", () => ({
  useCommands: (o: UseCommandsOptions) => {
    h.commandOpts = o;
    return h.commands;
  },
  openNewDoc: (...a: unknown[]) => h.openNewDoc(...a),
}));
vi.mock("../hooks/useCollab", () => ({
  useCollab: () => ({ collab: null, collabPeers: [], handleStartCollab: () => {}, handleStopCollab: () => {} }),
}));
vi.mock("../hooks/useTauriMenu", () => ({
  useTauriMenu: (actions: MenuActions) => {
    h.menu = actions;
  },
}));
vi.mock("../hooks/useFileDragDrop", () => ({ useFileDragDrop: () => ({ dragHover: h.dragHover }) }));
vi.mock("../agents/modelCritic", () => ({ installModelCritic: () => {} }));
vi.mock("../pwa/launch", () => ({
  parseLaunch: (...a: unknown[]) => h.parseLaunch(...a),
  clearLaunchParams: (...a: unknown[]) => h.clearLaunchParams(...a),
  onLaunchFiles: (...a: unknown[]) => h.onLaunchFiles(...a),
  // Quick capture (#268): App also asks for a shared item and listens for the desktop capture shortcut.
  sharedItem: () => null,
  onDesktopCapture: () => {},
}));
vi.mock("../storage/fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage/fs")>()),
  openFileDialog: (...a: unknown[]) => h.openFileDialog(...a),
  saveFile: (...a: unknown[]) => h.saveFile(...a),
}));
vi.mock("../storage/recent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage/recent")>()),
  getRecents: (...a: unknown[]) => h.getRecents(...a),
  pushRecent: (...a: unknown[]) => h.pushRecent(...a),
  reopenRecent: (...a: unknown[]) => h.reopenRecent(...a),
}));
vi.mock("../storage/workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage/workspace")>()),
  isOPFSAvailable: (...a: unknown[]) => h.isOPFSAvailable(...a),
  uniqueWorkspaceName: (...a: unknown[]) => h.uniqueWorkspaceName(...a),
  writeWorkspaceFile: (...a: unknown[]) => h.writeWorkspaceFile(...a),
  writeWorkspaceBlob: (...a: unknown[]) => h.writeWorkspaceBlob(...a),
  readWorkspaceFile: (...a: unknown[]) => h.readWorkspaceFile(...a),
  workspaceHasFile: (...a: unknown[]) => h.workspaceHasFile(...a),
  makeAssetName: (name: string) => `lumen-asset-${name}`,
}));
vi.mock("../storage/exportHtml", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage/exportHtml")>()),
  exportToHtml: (...a: unknown[]) => h.exportToHtml(...a),
}));
vi.mock("../storage/history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage/history")>()),
  recordSnapshot: (...a: unknown[]) => h.recordSnapshot(...a),
}));
vi.mock("../ui/PromptDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/PromptDialog")>()),
  uiAlert: (...a: unknown[]) => h.uiAlert(...a),
  uiConfirm: (...a: unknown[]) => h.uiConfirm(...a),
  uiPrompt: (...a: unknown[]) => h.uiPrompt(...a),
}));
vi.mock("../ui/InsertTextDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/InsertTextDialog")>()),
  openInsertTextDialog: (...a: unknown[]) => h.openInsertTextDialog(...a),
}));
vi.mock("../renderer/wikiLinks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../renderer/wikiLinks")>()),
  scrollToHeadingWhenRendered: (...a: unknown[]) => h.scrollToHeading(...a),
}));

import App from "../App";
import { useAppStore } from "../store/useStore";
import { __resetExternalChanges } from "../store/externalChanges";
import { welcomeDoc } from "../welcomeDoc";
import { applyLocale, loadLocale, t } from "../i18n";
import { useToastStore } from "../store/useToastStore";

// ── Helpers ────────────────────────────────────────────────────────────
function propsOf(name: string): Props {
  const p = h.props[name];
  if (!p) throw new Error(`${name} was never rendered`);
  return p;
}
/** A lazily loaded surface mounted only while open (#261): wait for the chunk, then read its props. */
async function opened(name: string): Promise<Props> {
  await waitFor(() => expect(propsOf(name).open).toBe(true), { timeout: 3000 });
  return propsOf(name);
}
const mounted = (name: string) => screen.queryByText(`[${name}]`) !== null;

function cb<T = AnyFn>(name: string, key: string): T {
  return propsOf(name)[key] as T;
}
function opts(): UseCommandsOptions {
  if (!h.commandOpts) throw new Error("useCommands was not called");
  return h.commandOpts;
}
function doc() {
  return useAppStore.getState().doc;
}
/** Run an App callback (sync or async) inside act and wait for it. */
async function run(fn: () => unknown) {
  await act(async () => {
    await fn();
  });
}
function key(k: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = { ctrl: true }) {
  fireEvent.keyDown(window, { key: k, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift });
}
async function renderApp() {
  const utils = render(<App />);
  // The launch-parameter effect resolves a dynamic import; let it settle.
  await waitFor(() => expect(h.onLaunchFiles).toHaveBeenCalled());
  return utils;
}
function setDocState(d: Partial<ReturnType<typeof doc>>, tabs = true) {
  const next = { name: "notes.md", content: "# Notes\n", dirty: false, workspaceName: null, handle: undefined, ...d };
  useAppStore.setState({
    doc: next,
    openTabs: tabs
      ? [{ id: next.workspaceName ?? next.name, name: next.name, content: next.content, workspaceName: next.workspaceName ?? null, dirty: next.dirty }]
      : [],
  });
}

beforeEach(() => {
  // The outside-change guard (#258) remembers what each path last held, across cases: start clean.
  __resetExternalChanges();
  for (const k of Object.keys(h.props)) delete h.props[k];
  h.commandOpts = null;
  h.menu = null;
  h.commands = [];
  h.dragHover = false;
  for (const fn of [
    h.openNewDoc, h.openFileDialog, h.saveFile, h.getRecents, h.pushRecent, h.reopenRecent,
    h.isOPFSAvailable, h.uniqueWorkspaceName, h.writeWorkspaceFile, h.writeWorkspaceBlob,
    h.readWorkspaceFile, h.workspaceHasFile, h.uiAlert, h.uiConfirm, h.uiPrompt, h.openInsertTextDialog,
    h.exportToHtml, h.recordSnapshot, h.scrollToHeading, h.parseLaunch, h.clearLaunchParams, h.onLaunchFiles,
  ]) fn.mockReset();
  h.getRecents.mockResolvedValue([]);
  h.pushRecent.mockResolvedValue(undefined);
  h.isOPFSAvailable.mockReturnValue(false);
  h.uniqueWorkspaceName.mockImplementation(async (...a: unknown[]) => a[0]);
  h.writeWorkspaceFile.mockResolvedValue(undefined);
  h.writeWorkspaceBlob.mockResolvedValue(undefined);
  h.readWorkspaceFile.mockResolvedValue("");
  h.workspaceHasFile.mockResolvedValue(false);
  h.uiAlert.mockResolvedValue(null);
  h.uiConfirm.mockResolvedValue(true);
  h.uiPrompt.mockResolvedValue(null);
  h.openInsertTextDialog.mockResolvedValue(null);
  h.exportToHtml.mockResolvedValue(undefined);
  h.recordSnapshot.mockResolvedValue(true);
  h.parseLaunch.mockReturnValue({ kind: "none" });

  localStorage.clear();
  localStorage.setItem("lumen-tour-done", "1");
  useToastStore.getState().clear();
  useAppStore.setState({
    doc: { name: "Welcome.md", content: "", dirty: false, workspaceName: null },
    openTabs: [],
    mode: "split",
    theme: "dark",
    locale: "en",
    showWorkspace: false,
    showOutline: true,
    showBacklinks: false,
    autoSave: false,
    pageView: false,
  });
});

afterEach(() => {
  cleanup();
  applyLocale("en");
});

// ── Tests ──────────────────────────────────────────────────────────────
describe("App first launch", () => {
  it("seeds the Welcome document as the first tab and renders the shell", async () => {
    await renderApp();
    await waitFor(() => expect(doc().content).toBe(welcomeDoc()));
    expect(doc().name).toBe("Welcome.md");
    expect(useAppStore.getState().openTabs.map((tab) => tab.name)).toEqual(["Welcome.md"]);
    expect(screen.getByRole("link", { name: t("a11y.skipToContent") }).getAttribute("href")).toBe("#main");
    expect(document.getElementById("main")?.tagName).toBe("MAIN");
    expect(propsOf("EditorLayout").docContent).toBe(welcomeDoc());
    expect(propsOf("EditorLayout").mode).toBe("split");
    expect(propsOf("StatusBar").filename).toBe("Welcome.md");
    expect(propsOf("Outline").markdownText).toBe(welcomeDoc());
    // Workspace sidebar is off by default.
    expect(h.props.FileTree).toBeUndefined();
    expect(h.uiAlert).not.toHaveBeenCalled();
  });

  it("backfills a tab for a document restored from a session without tabs", async () => {
    setDocState({ name: "notes.md", content: "# Notes\n" }, false);
    await renderApp();
    expect(useAppStore.getState().openTabs.map((tab) => tab.name)).toEqual(["notes.md"]);
    expect(doc().content).toBe("# Notes\n");
    const tabs = propsOf("DocTabs").tabs as Array<{ id: string; name: string }>;
    expect(tabs.map((tab) => tab.name)).toEqual(["notes.md"]);
    expect(propsOf("DocTabs").activeId).toBe("notes.md");
  });

  it("starts the setup, then the onboarding tour, on a first visit and remembers when it is closed", async () => {
    localStorage.removeItem("lumen-tour-done");
    await renderApp();
    // A first visit opens the setup (#261, plan 14.1); the tour follows when it is done.
    await waitFor(() => expect(mounted("FirstRun")).toBe(true), { timeout: 3000 });
    await run(() => cb("FirstRun", "onDone")({ note: { path: "Welcome.md", content: "# Welcome\n" } }));
    await opened("OnboardingTour");
    await run(() => cb("OnboardingTour", "onClose")());
    expect(mounted("OnboardingTour")).toBe(false);
    expect(localStorage.getItem("lumen-tour-done")).toBe("1");
  });

  it("the tour's action opens the runtime metrics panel", async () => {
    await renderApp();
    await run(() => cb("Toolbar", "onTour")());
    const actions = (await opened("OnboardingTour")).actions as Array<{ id: string; label: string; onRun: () => void }>;
    expect(actions[0].id).toBe("runtimeMetrics.open");
    expect(actions[0].label).toBe(t("tour.action.openRuntimeMetrics"));
    await run(() => actions[0].onRun());
    expect(screen.getByText("[RuntimeMetricsPanel]")).toBeTruthy();
    await run(() => cb("RuntimeMetricsPanel", "onClose")());
    expect(screen.queryByText("[RuntimeMetricsPanel]")).toBeNull();
  });

  it("applies the stored locale to <html> (Hebrew → RTL)", async () => {
    const he = await loadLocale("he");
    useAppStore.setState({ locale: "he" });
    await renderApp();
    expect(document.documentElement.lang).toBe("he");
    expect(document.documentElement.dir).toBe("rtl");
    expect(screen.getByRole("link", { name: he["a11y.skipToContent"] })).toBeTruthy();
    expect(he["a11y.skipToContent"]).not.toBe("Skip to content");
  });
});

describe("App launch parameters", () => {
  it("opens shared text as a new unsaved note with a safe name", async () => {
    h.parseLaunch.mockReturnValue({ kind: "share", title: "Hello/world: notes", body: "shared body" });
    await renderApp();
    expect(h.openNewDoc).toHaveBeenCalledWith("Hello world  notes", "shared body", true);
    expect(h.clearLaunchParams).toHaveBeenCalledTimes(1);
  });

  it("falls back to 'Shared' when the shared title is only punctuation", async () => {
    h.parseLaunch.mockReturnValue({ kind: "share", title: "///", body: "b" });
    await renderApp();
    expect(h.openNewDoc).toHaveBeenCalledWith("Shared", "b", true);
  });

  it("the 'new' shortcut opens an empty untitled note", async () => {
    h.parseLaunch.mockReturnValue({ kind: "action", action: "new" });
    await renderApp();
    expect(h.openNewDoc).toHaveBeenCalledWith(t("doc.untitled"), "", false);
  });

  it("the 'palette' shortcut opens the command palette", async () => {
    h.parseLaunch.mockReturnValue({ kind: "action", action: "palette" });
    await renderApp();
    await waitFor(() => expect(propsOf("CommandPalette").open).toBe(true));
    expect(h.clearLaunchParams).toHaveBeenCalled();
  });

  it("no launch parameters: nothing is opened or cleared", async () => {
    await renderApp();
    expect(h.openNewDoc).not.toHaveBeenCalled();
    expect(h.clearLaunchParams).not.toHaveBeenCalled();
  });

  it("a file opened with the installed app lands in a tab, with its handle", async () => {
    await renderApp();
    const open = h.onLaunchFiles.mock.calls[0][0] as (name: string, content: string, handle: unknown) => void;
    const handle = { kind: "file", name: "launched.md" };
    await run(() => open("launched.md", "# Launched", handle));
    expect(doc().name).toBe("launched.md");
    expect(doc().content).toBe("# Launched");
    expect(doc().handle).toBe(handle);
  });

  it("picks up a note shared from the iOS share extension once", async () => {
    const w = window as unknown as Record<string, unknown>;
    w.__pendingSharedNote = "from the share sheet";
    await renderApp();
    expect(h.openNewDoc).toHaveBeenCalledWith("Shared Note", "from the share sheet", true);
    expect(w.__pendingSharedNote).toBeUndefined();
    expect(await screen.findByText(t("toast.openedSharedNoteFromIos"))).toBeTruthy();
  });
});

describe("App keyboard shortcuts", () => {
  it("⌘K toggles the palette, ⌘/ the shortcuts sheet, ⌘H find & replace", async () => {
    await renderApp();
    expect(propsOf("CommandPalette").open).toBe(false);
    key("k");
    expect(propsOf("CommandPalette").open).toBe(true);
    key("K", { meta: true });
    expect(propsOf("CommandPalette").open).toBe(false);
    key("/");
    await opened("KeyboardShortcuts");
    key("h");
    expect(propsOf("SearchReplace").open).toBe(true);
    // Without a modifier nothing happens.
    key("k", {});
    expect(propsOf("CommandPalette").open).toBe(false);
  });

  it("⌘1–⌘4 switch the view mode", async () => {
    await renderApp();
    key("1");
    expect(useAppStore.getState().mode).toBe("source");
    key("3");
    expect(useAppStore.getState().mode).toBe("preview");
    key("4");
    expect(useAppStore.getState().mode).toBe("wysiwyg");
    key("2");
    expect(useAppStore.getState().mode).toBe("split");
    expect(propsOf("EditorLayout").mode).toBe("split");
  });

  it("⇧⌘F toggles focus mode", async () => {
    await renderApp();
    expect(screen.queryByText("[FocusMode]")).toBeNull();
    key("F", { ctrl: true, shift: true });
    expect(screen.getByText("[FocusMode]")).toBeTruthy();
    key("f", { ctrl: true, shift: true });
    expect(screen.queryByText("[FocusMode]")).toBeNull();
  });

  it("⌘S saves through the file system, ⇧⌘S asks where", async () => {
    setDocState({ name: "draft.md", content: "draft", dirty: true });
    h.saveFile.mockImplementation(async (...a: unknown[]) => ({ ...(a[0] as object), name: "draft.md", handle: undefined }));
    await renderApp();
    key("s");
    await waitFor(() => expect(doc().dirty).toBe(false));
    expect(h.saveFile).toHaveBeenLastCalledWith({ name: "draft.md", content: "draft", handle: undefined }, { saveAs: false });
    expect(h.recordSnapshot).toHaveBeenCalledWith("draft.md", "draft", "save");
    key("S", { ctrl: true, shift: true });
    await waitFor(() => expect(h.saveFile).toHaveBeenLastCalledWith(expect.anything(), { saveAs: true }));
  });

  it("⌘O opens a file and records it in recents", async () => {
    const handle = { kind: "file", name: "a.md" };
    h.openFileDialog.mockResolvedValue({ name: "a.md", content: "A", handle });
    h.getRecents.mockResolvedValue([{ id: "r1", name: "a.md", openedAt: 1 }]);
    await renderApp();
    key("o");
    await waitFor(() => expect(doc().name).toBe("a.md"));
    expect(doc().content).toBe("A");
    expect(h.pushRecent).toHaveBeenCalledWith({ name: "a.md", handle });
    await waitFor(() => expect(opts().recents).toEqual([{ id: "r1", name: "a.md", openedAt: 1 }]));
  });

  it("⌘O cancelled: the document stays", async () => {
    setDocState({ name: "keep.md", content: "keep" });
    h.openFileDialog.mockResolvedValue(null);
    await renderApp();
    await run(() => opts().handleOpen());
    expect(doc().name).toBe("keep.md");
    expect(h.pushRecent).not.toHaveBeenCalled();
  });

  it("⌘N asks before discarding unsaved changes", async () => {
    setDocState({ name: "dirty.md", content: "unsaved", dirty: true });
    h.uiConfirm.mockResolvedValueOnce(false);
    await renderApp();
    key("n");
    await waitFor(() => expect(h.uiConfirm).toHaveBeenCalledWith({ message: t("doc.confirm.discardUnsaved") }));
    expect(doc().name).toBe("dirty.md");
    await run(() => opts().handleNew());
    expect(doc().name).toBe(`${t("doc.untitled")}.md`);
    expect(doc().content).toBe(`# ${t("doc.untitled")}\n\n`);
  });

  it("a new document gets a free workspace name when OPFS is available", async () => {
    h.isOPFSAvailable.mockReturnValue(true);
    h.uniqueWorkspaceName.mockResolvedValue("Untitled 2.md");
    await renderApp();
    await run(() => opts().handleNew());
    expect(doc().name).toBe("Untitled 2.md");
    expect(doc().content).toBe("# Untitled 2\n\n");
    expect(h.uiConfirm).not.toHaveBeenCalled();
  });

  it("⇧⌘V smart insert appends, replaces, or inserts at the end without an editor", async () => {
    setDocState({ name: "n.md", content: "start" });
    await renderApp();
    h.openInsertTextDialog.mockResolvedValueOnce({ mode: "append", markdown: "added" });
    key("V", { ctrl: true, shift: true });
    await waitFor(() => expect(doc().content).toBe("start\n\nadded"));
    h.openInsertTextDialog.mockResolvedValueOnce({ mode: "atCursor", markdown: "cursor" });
    key("v", { ctrl: true, shift: true });
    await waitFor(() => expect(doc().content).toBe("start\n\nadded\ncursor"));
    h.openInsertTextDialog.mockResolvedValueOnce({ mode: "replace", markdown: "replaced" });
    key("V", { ctrl: true, shift: true });
    await waitFor(() => expect(doc().content).toBe("replaced"));
  });
});

describe("App file actions", () => {
  it("a failed save says why; a cancelled Save-As stays silent", async () => {
    await renderApp();
    h.saveFile.mockRejectedValueOnce(new Error("disk full"));
    await run(() => opts().handleSave(false));
    expect(h.uiAlert).toHaveBeenCalledWith({ message: t("doc.alert.saveFailed", { error: "disk full" }) });
    h.uiAlert.mockClear();
    h.saveFile.mockRejectedValueOnce(new DOMException("cancelled", "AbortError"));
    await run(() => opts().handleSave(true));
    expect(h.uiAlert).not.toHaveBeenCalled();
  });

  it("reopens a recent file, or explains when it is gone", async () => {
    await renderApp();
    const entry = { id: "r1", name: "old.md", openedAt: 1 };
    h.reopenRecent.mockResolvedValueOnce(null);
    await run(() => opts().handleReopenRecent(entry));
    expect(h.uiAlert).toHaveBeenCalledWith({ message: t("doc.alert.reopenFailed") });
    const handle = { kind: "file", name: "old.md" };
    h.reopenRecent.mockResolvedValueOnce({ name: "old.md", content: "Old", handle });
    await run(() => opts().handleReopenRecent(entry));
    expect(doc().name).toBe("old.md");
    expect(doc().content).toBe("Old");
    expect(h.pushRecent).toHaveBeenCalledWith({ name: "old.md", handle });
  });

  it("exports HTML and reports an export failure", async () => {
    setDocState({ name: "e.md", content: "# E" });
    await renderApp();
    await run(() => opts().handleExportHtml());
    expect(h.exportToHtml).toHaveBeenCalledWith("# E", "e.md");
    h.exportToHtml.mockRejectedValueOnce(new Error("blocked"));
    await run(() => opts().handleExportHtml());
    expect(h.uiAlert).toHaveBeenCalledWith({ message: t("doc.alert.exportFailed", { error: "blocked" }) });
  });

  it("save to workspace: explains when OPFS is missing", async () => {
    await renderApp();
    await run(() => opts().handleSaveToWorkspace());
    expect(h.uiAlert).toHaveBeenCalledWith({ message: t("doc.alert.workspaceUnavailable") });
    expect(h.writeWorkspaceFile).not.toHaveBeenCalled();
  });

  it("save to workspace: writes under a free .md name and shows the workspace", async () => {
    setDocState({ name: "draft.txt", content: "hello" });
    h.isOPFSAvailable.mockReturnValue(true);
    await renderApp();
    const changed = vi.fn();
    window.addEventListener("lumen-workspace-changed", changed);
    await run(() => opts().handleSaveToWorkspace());
    window.removeEventListener("lumen-workspace-changed", changed);
    expect(h.uniqueWorkspaceName).toHaveBeenCalledWith("draft.md");
    expect(h.writeWorkspaceFile).toHaveBeenCalledWith("draft.md", "hello");
    expect(doc().workspaceName).toBe("draft.md");
    expect(useAppStore.getState().showWorkspace).toBe(true);
    expect(changed).toHaveBeenCalled();
    expect(screen.getByText("[FileTree]")).toBeTruthy();
  });

  it("pasted images become workspace assets when OPFS is available", async () => {
    await renderApp();
    const addAsset = cb<(f: File) => Promise<string | null>>("EditorLayout", "handleAddAsset");
    const file = new File(["png"], "pic.png", { type: "image/png" });
    expect(await addAsset(file)).toBeNull();
    h.isOPFSAvailable.mockReturnValue(true);
    expect(await addAsset(file)).toBe("lumen-asset-pic.png");
    expect(h.writeWorkspaceBlob).toHaveBeenCalledWith("lumen-asset-pic.png", file);
    h.writeWorkspaceBlob.mockRejectedValueOnce(new Error("quota"));
    expect(await addAsset(file)).toBeNull();
  });

  it("insertSnippet without a mounted editor is a no-op", async () => {
    setDocState({ name: "s.md", content: "same" });
    await renderApp();
    opts().insertSnippet("**bold**");
    expect(doc().content).toBe("same");
  });
});

describe("App autosave", () => {
  it("writes a dirty workspace file after a short debounce", async () => {
    setDocState({ name: "w.md", content: "typed", workspaceName: "w.md", dirty: true });
    await renderApp();
    await waitFor(() => expect(h.writeWorkspaceFile).toHaveBeenCalledWith("w.md", "typed"), { timeout: 3000 });
    await waitFor(() => expect(doc().dirty).toBe(false));
    expect(h.recordSnapshot).toHaveBeenCalledWith("w.md", "typed", "autosave");
  });

  it("says so when the workspace write fails", async () => {
    setDocState({ name: "w.md", content: "typed", workspaceName: "w.md", dirty: true });
    h.writeWorkspaceFile.mockRejectedValue(new Error("io"));
    await renderApp();
    const message = t("doc.save.failedRetrying", { name: "w.md" });
    expect(await screen.findByText(message, {}, { timeout: 3000 })).toBeTruthy();
    expect(doc().dirty).toBe(true);
  });

  it("flushes the pending write when the page is hidden or closed", async () => {
    setDocState({ name: "w.md", content: "unflushed", workspaceName: "w.md", dirty: true });
    await renderApp();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    // The write goes through the outside-change guard (#258), loaded on demand: wait for it.
    await waitFor(() => expect(h.writeWorkspaceFile).toHaveBeenCalledWith("w.md", "unflushed"));
    expect(h.recordSnapshot).toHaveBeenCalledWith("w.md", "unflushed", "close");
    h.writeWorkspaceFile.mockClear();
    // The flush marked the note saved (main); a new edit makes it pending again. The vault
    // now holds what was written, so the guard (#258) sees no outside change.
    await waitFor(() => expect(doc().dirty).toBe(false));
    h.workspaceHasFile.mockResolvedValue(true);
    h.readWorkspaceFile.mockResolvedValue("unflushed");
    act(() => {
      useAppStore.getState().setContent("unflushed, again");
    });
    const vis = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    if (vis) Object.defineProperty(document, "visibilityState", vis);
    else delete (document as unknown as Record<string, unknown>).visibilityState;
    await waitFor(() => expect(h.writeWorkspaceFile).toHaveBeenCalledWith("w.md", "unflushed, again"));
  });

  it("warns before unloading only with unsaved changes", async () => {
    setDocState({ name: "c.md", content: "clean" });
    const { unmount } = await renderApp();
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    unmount();
    setDocState({ name: "d.md", content: "dirty", dirty: true });
    await renderApp();
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  it("interval autosave adopts an untitled document into the workspace", async () => {
    setDocState({ name: "Untitled.md", content: "loose text", dirty: true });
    h.isOPFSAvailable.mockReturnValue(true);
    useAppStore.setState({ autoSave: true, autoSaveInterval: 50 });
    await renderApp();
    await waitFor(() => expect(h.writeWorkspaceFile).toHaveBeenCalledWith("Untitled.md", "loose text"));
    await waitFor(() => expect(doc().workspaceName).toBe("Untitled.md"));
  });

  it("interval autosave writes a disk file back through its handle", async () => {
    const handle = { kind: "file", name: "disk.md" };
    setDocState({ name: "disk.md", content: "on disk", dirty: true, handle: handle as unknown as FileSystemFileHandle });
    h.saveFile.mockImplementation(async (...a: unknown[]) => a[0]);
    useAppStore.setState({ autoSave: true, autoSaveInterval: 50 });
    await renderApp();
    await waitFor(() => expect(h.saveFile).toHaveBeenCalledWith({ name: "disk.md", content: "on disk", handle }, { saveAs: false }));
    await waitFor(() => expect(doc().dirty).toBe(false));
  });
});

describe("App window events", () => {
  it("lumen-open-file opens a workspace note and scrolls to the heading", async () => {
    h.readWorkspaceFile.mockResolvedValue("# Linked");
    await renderApp();
    act(() => {
      window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path: "notes/linked.md", heading: "Intro" } }));
    });
    await waitFor(() => expect(doc().workspaceName).toBe("notes/linked.md"));
    expect(doc().content).toBe("# Linked");
    expect(h.scrollToHeading).toHaveBeenCalledWith("Intro", { docKey: "ws:notes/linked.md" });
  });

  it("lumen-open-file ignores missing files and empty events", async () => {
    h.readWorkspaceFile.mockRejectedValue(new Error("gone"));
    setDocState({ name: "stay.md", content: "stay" });
    await renderApp();
    act(() => {
      window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path: "gone.md" } }));
      window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: {} }));
    });
    await waitFor(() => expect(h.readWorkspaceFile).toHaveBeenCalledWith("gone.md"));
    expect(doc().name).toBe("stay.md");
    expect(h.readWorkspaceFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["lumen-open-ai-settings", "AiSettingsPanel"],
    ["lumen-open-privacy-ledger", "PrivacyLedgerPanel"],
    ["lumen-open-trash", "TrashPanel"],
    ["lumen-open-ai-doctor", "AiDoctorPanel"],
  ])("%s opens %s, and its close button closes it", async (event, panel) => {
    await renderApp();
    expect(screen.queryByText(`[${panel}]`)).toBeNull();
    act(() => {
      window.dispatchEvent(new Event(event));
    });
    expect(await screen.findByText(`[${panel}]`)).toBeTruthy();
    expect(propsOf(panel).open).toBe(true);
    await run(() => cb(panel, "onClose")());
    expect(screen.queryByText(`[${panel}]`)).toBeNull();
  });

  it("lumen-run-command runs a palette command by id, nested ones too", async () => {
    const top = vi.fn();
    const nested = vi.fn();
    h.commands = [
      { id: "file.new", label: "New", action: top },
      { id: "group", label: "Group", action: () => {}, children: [{ id: "group.child", label: "Child", action: nested }] },
    ];
    await renderApp();
    act(() => {
      window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "group.child" } }));
      window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "file.new" } }));
      window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "missing" } }));
      window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: {} }));
    });
    expect(nested).toHaveBeenCalledTimes(1);
    expect(top).toHaveBeenCalledTimes(1);
  });

  it("shows the drop hint while a file is dragged over the window", async () => {
    h.dragHover = true;
    await renderApp();
    expect(screen.getByText(t("dnd.dropHint"))).toBeTruthy();
  });
});

describe("App overlay panels opened from commands", () => {
  it.each([
    ["setCanvasOpen", "CanvasExcalidraw"],
    ["setGalleryOpen", "PluginGallery"],
    ["setTemplateGalleryOpen", "TemplateGallery"],
    ["setAuditLogOpen", "AuditLog"],
    ["setFineTuneOpen", "FineTuneSettings"],
    ["setTrustedKeysOpen", "TrustedKeysSettings"],
    ["setThemeSettingsOpen", "ThemeSettings"],
    ["setHistoryOpen", "VersionHistory"],
    ["setTableEditorOpen", "MarkdownTableEditor"],
    ["setRuntimeMetricsOpen", "RuntimeMetricsPanel"],
  ])("%s(true) mounts %s and its onClose unmounts it", async (setter, panel) => {
    await renderApp();
    const open = opts()[setter as keyof UseCommandsOptions] as (v: boolean) => void;
    await run(() => open(true));
    expect(await screen.findByText(`[${panel}]`)).toBeTruthy();
    await run(() => cb(panel, "onClose")());
    expect(screen.queryByText(`[${panel}]`)).toBeNull();
  });

  it("the audit log is scoped to 'personal' without an organization", async () => {
    await renderApp();
    await run(() => opts().setAuditLogOpen?.(true));
    await screen.findByText("[AuditLog]");
    expect(propsOf("AuditLog").orgId).toBe("personal");
  });

  it("org settings can open the audit log", async () => {
    await renderApp();
    await run(() => opts().setOrgSettingsOpen?.(true));
    await screen.findByText("[OrgSettings]");
    await run(() => cb("OrgSettings", "onOpenAuditLog")());
    expect(await screen.findByText("[AuditLog]")).toBeTruthy();
    await run(() => cb("OrgSettings", "onClose")());
    expect(screen.queryByText("[OrgSettings]")).toBeNull();
  });

  it("graph view opens a note and closes itself", async () => {
    await renderApp();
    await run(() => opts().setGraphOpen(true));
    expect(screen.getByText(t("graphView.title"))).toBeTruthy();
    await screen.findByText("[GraphView]");
    await run(() => cb("GraphView", "onOpenFile")("dir/graph.md", "# G"));
    expect(doc().name).toBe("graph.md");
    expect(doc().workspaceName).toBe("dir/graph.md");
    expect(screen.queryByText("[GraphView]")).toBeNull();
  });

  it("graph view's cancel button closes it", async () => {
    await renderApp();
    await run(() => opts().setGraphOpen(true));
    fireEvent.click(screen.getByRole("button", { name: t("dialog.cancel") }));
    expect(screen.queryByText(t("graphView.title"))).toBeNull();
  });

  it("version history restores an older version into the document", async () => {
    setDocState({ name: "h.md", content: "new", workspaceName: "dir/h.md" });
    await renderApp();
    await run(() => opts().setHistoryOpen(true));
    await screen.findByText("[VersionHistory]");
    expect(propsOf("VersionHistory").fileName).toBe("dir/h.md");
    expect(propsOf("VersionHistory").currentContent).toBe("new");
    await run(() => cb("VersionHistory", "onRestore")("old"));
    expect(doc().content).toBe("old");
  });

  it("the table editor appends its table to the document", async () => {
    setDocState({ name: "t.md", content: "intro" });
    await renderApp();
    await run(() => opts().setTableEditorOpen(true));
    await screen.findByText("[MarkdownTableEditor]");
    await run(() => cb("MarkdownTableEditor", "onUpdate")("| a |\n| - |"));
    expect(doc().content).toBe("intro\n\n| a |\n| - |\n");
  });

  it("workspace search opens the picked file and reveals the workspace", async () => {
    await renderApp();
    await run(() => opts().setSearchOpen(true));
    await screen.findByText("[SearchDialog]");
    expect(propsOf("SearchDialog").open).toBe(true);
    await run(() => cb("SearchDialog", "onOpenFile")("docs/found.md", "Found"));
    expect(doc().name).toBe("found.md");
    expect(doc().workspaceName).toBe("docs/found.md");
    expect(useAppStore.getState().showWorkspace).toBe(true);
    // Closing keeps the dialog mounted (an Ask Workspace chat survives).
    await run(() => cb("SearchDialog", "onClose")());
    expect(propsOf("SearchDialog").open).toBe(false);
    expect(screen.getByText("[SearchDialog]")).toBeTruthy();
  });

  it("tags panel and find & replace follow their open flags", async () => {
    setDocState({ name: "f.md", content: "find me" });
    await renderApp();
    await run(() => opts().setTagsPanelOpen?.(true));
    expect(propsOf("TagsPanel").open).toBe(true);
    await run(() => cb("TagsPanel", "onClose")());
    expect(propsOf("TagsPanel").open).toBe(false);
    await run(() => opts().setFindReplaceOpen(true));
    expect(propsOf("SearchReplace").open).toBe(true);
    expect(propsOf("SearchReplace").content).toBe("find me");
    await run(() => cb("SearchReplace", "onChange")("found you"));
    expect(doc().content).toBe("found you");
    await run(() => cb("SearchReplace", "onClose")());
    expect(propsOf("SearchReplace").open).toBe(false);
  });

  it("without a collab session there is no comment command or panel", async () => {
    await renderApp();
    expect(opts().onAddComment).toBeUndefined();
    expect(opts().collab).toBeNull();
    expect(screen.queryByText("[CommentsPanel]")).toBeNull();
    expect(opts().getEditorView?.()).toBeNull();
  });
});

describe("App toolbar callbacks", () => {
  it("palette, focus mode, shortcuts and tour buttons open their surfaces", async () => {
    await renderApp();
    await run(() => cb("Toolbar", "onCommandPalette")());
    expect(propsOf("CommandPalette").open).toBe(true);
    await run(() => cb("CommandPalette", "onClose")());
    expect(propsOf("CommandPalette").open).toBe(false);
    await run(() => cb("Toolbar", "onShortcuts")());
    await opened("KeyboardShortcuts");
    await run(() => cb("KeyboardShortcuts", "onClose")());
    expect(mounted("KeyboardShortcuts")).toBe(false);
    await run(() => cb("Toolbar", "onTour")());
    await opened("OnboardingTour");
    await run(() => cb("Toolbar", "onFocusMode")());
    expect(screen.getByText("[FocusMode]")).toBeTruthy();
    await run(() => cb("FocusMode", "onExit")());
    expect(screen.queryByText("[FocusMode]")).toBeNull();
  });

  it("'show welcome' restores the bundled welcome document", async () => {
    setDocState({ name: "other.md", content: "other" });
    await renderApp();
    await run(() => cb("Toolbar", "onShowWelcome")());
    expect(doc().name).toBe("Welcome.md");
    expect(doc().content).toBe(welcomeDoc());
  });

  it("insert text: replace, append, and at-cursor without an editor", async () => {
    setDocState({ name: "i.md", content: "base" });
    await renderApp();
    const insert = cb<() => Promise<void>>("Toolbar", "onInsertText");
    h.openInsertTextDialog.mockResolvedValueOnce({ mode: "append", markdown: "tail" });
    await run(insert);
    expect(doc().content).toBe("base\n\ntail");
    h.openInsertTextDialog.mockResolvedValueOnce({ mode: "atCursor", markdown: "here" });
    await run(cb<() => Promise<void>>("Toolbar", "onInsertText"));
    expect(doc().content).toBe("base\n\ntail\nhere");
    h.openInsertTextDialog.mockResolvedValueOnce({ mode: "replace", markdown: "fresh" });
    await run(cb<() => Promise<void>>("Toolbar", "onInsertText"));
    expect(doc().content).toBe("fresh");
    const success = t("toast.insertText.success");
    expect(screen.getAllByText((text) => text.endsWith(success)).length).toBeGreaterThan(0);
    // Cancelled dialog: nothing changes.
    await run(cb<() => Promise<void>>("Toolbar", "onInsertText"));
    expect(doc().content).toBe("fresh");
  });

  it("paste text converts HTML to Markdown and keeps plain text as is", async () => {
    setDocState({ name: "p.md", content: "top" });
    await renderApp();
    h.uiPrompt.mockResolvedValueOnce("<h1>Hello</h1>");
    await run(cb<() => Promise<void>>("Toolbar", "onPasteText"));
    expect(doc().content.startsWith("top\n\n")).toBe(true);
    expect(doc().content).toContain("Hello");
    expect(doc().content).not.toContain("<h1>");
    h.uiPrompt.mockResolvedValueOnce("plain words");
    await run(cb<() => Promise<void>>("Toolbar", "onPasteText"));
    expect(doc().content.endsWith("\n\nplain words")).toBe(true);
    const before = doc().content;
    await run(cb<() => Promise<void>>("Toolbar", "onPasteText"));
    expect(doc().content).toBe(before);
  });

  it("status bar opens runtime metrics", async () => {
    await renderApp();
    expect(propsOf("StatusBar").collab).toBeNull();
    await run(() => cb("StatusBar", "onOpenRuntimeMetrics")());
    expect(screen.getByText("[RuntimeMetricsPanel]")).toBeTruthy();
  });
});

describe("App workspace sidebar and tabs", () => {
  it("file tree opens, renames and deletes the active file", async () => {
    useAppStore.setState({ showWorkspace: true });
    await renderApp();
    expect(screen.getByText("[SidebarResizer]")).toBeTruthy();
    await run(() => cb("FileTree", "onOpenFile")("tree.md", "# Tree"));
    expect(doc().workspaceName).toBe("tree.md");
    expect(propsOf("FileTree").activePath).toBe("tree.md");
    await run(() => cb("FileTree", "onActiveRenamed")("renamed.md"));
    expect(doc().name).toBe("renamed.md");
    expect(doc().workspaceName).toBe("renamed.md");
    await run(() => cb("FileTree", "onActiveDeleted")());
    expect(doc().name).toBe(`${t("doc.untitled")}.md`);
    expect(doc().content).toBe("");
    expect(doc().workspaceName).toBeNull();
  });

  it("backlinks open the linking note and reveal the workspace", async () => {
    useAppStore.setState({ showBacklinks: true });
    h.readWorkspaceFile.mockResolvedValue("links here");
    await renderApp();
    await run(() => cb("BacklinksPanel", "onOpen")("dir/from.md"));
    expect(doc().name).toBe("from.md");
    expect(doc().content).toBe("links here");
    expect(useAppStore.getState().showWorkspace).toBe(true);
    h.readWorkspaceFile.mockRejectedValueOnce(new Error("missing"));
    await run(() => cb("BacklinksPanel", "onOpen")("dir/missing.md"));
    expect(doc().name).toBe("from.md");
  });

  it("tabs switch, reorder and close", async () => {
    await renderApp();
    await run(() => cb("DocTabs", "onSelect")("missing-tab"));
    expect(doc().name).toBe("Welcome.md");
    await run(() => {
      useAppStore.getState().openTab({ name: "a.md", content: "A", workspaceName: "a.md" });
      useAppStore.getState().openTab({ name: "b.md", content: "B", workspaceName: "b.md" });
    });
    await waitFor(() => expect((propsOf("DocTabs").tabs as unknown[]).length).toBe(3));
    await run(() => cb("DocTabs", "onSelect")("a.md"));
    expect(doc().name).toBe("a.md");
    expect(propsOf("DocTabs").activeId).toBe("a.md");
    await run(() => cb("DocTabs", "onReorder")(2, 0));
    expect(useAppStore.getState().openTabs[0].id).toBe("b.md");
    await run(() => cb("DocTabs", "onClose")("b.md"));
    expect(useAppStore.getState().openTabs.map((tab) => tab.id)).not.toContain("b.md");
  });
});

describe("App native (Tauri) menu", () => {
  it("menu items drive the same actions as the toolbar", async () => {
    const exportHtml = vi.fn();
    const exportPdf = vi.fn();
    const print = vi.fn();
    h.commands = [
      { id: "file.exportHtml", label: "HTML", action: exportHtml },
      { id: "file.exportPdf", label: "PDF", action: exportPdf },
      { id: "file.print", label: "Print", action: print },
    ];
    setDocState({ name: "m.md", content: "menu" });
    await renderApp();
    const menu = h.menu!;
    await run(() => menu.onToggleTheme?.());
    expect(useAppStore.getState().theme).toBe("light");
    await run(() => menu.onToggleTheme?.());
    expect(useAppStore.getState().theme).toBe("dark");
    await run(() => menu.onSetMode?.("preview"));
    expect(useAppStore.getState().mode).toBe("preview");
    await run(() => menu.onToggleWorkspace?.());
    expect(useAppStore.getState().showWorkspace).toBe(true);
    await run(() => menu.onToggleOutline?.());
    expect(useAppStore.getState().showOutline).toBe(false);
    await run(() => menu.onExportHtml?.());
    await run(() => menu.onExportPdf?.());
    await run(() => menu.onPrint?.());
    expect([exportHtml, exportPdf, print].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    await run(() => menu.onCommandPalette());
    expect(propsOf("CommandPalette").open).toBe(true);
    await run(() => menu.onShortcuts?.());
    await opened("KeyboardShortcuts");
    await run(() => menu.onTour?.());
    await opened("OnboardingTour");
    await run(() => menu.onFindReplace?.());
    expect(propsOf("SearchReplace").open).toBe(true);
    await run(() => menu.onWorkspaceSearch?.());
    expect(await screen.findByText("[SearchDialog]")).toBeTruthy();
    await run(() => menu.onFocusMode?.());
    expect(screen.getByText("[FocusMode]")).toBeTruthy();
  });

  it("menu insert-text uses the same three modes", async () => {
    setDocState({ name: "m.md", content: "menu" });
    await renderApp();
    h.openInsertTextDialog.mockResolvedValueOnce({ mode: "append", markdown: "x" });
    await run(() => h.menu!.onInsertText?.());
    expect(doc().content).toBe("menu\n\nx");
    h.openInsertTextDialog.mockResolvedValueOnce({ mode: "atCursor", markdown: "y" });
    await run(() => h.menu!.onInsertText?.());
    expect(doc().content).toBe("menu\n\nx\ny");
    h.openInsertTextDialog.mockResolvedValueOnce({ mode: "replace", markdown: "z" });
    await run(() => h.menu!.onInsertText?.());
    expect(doc().content).toBe("z");
    await run(() => h.menu!.onInsertText?.());
    expect(doc().content).toBe("z");
  });

  it("menu New / Open / Save reach the file handlers", async () => {
    h.openFileDialog.mockResolvedValue(null);
    h.saveFile.mockImplementation(async (...a: unknown[]) => a[0]);
    await renderApp();
    await run(() => h.menu!.onOpen());
    expect(h.openFileDialog).toHaveBeenCalledTimes(1);
    await run(() => h.menu!.onSave(true));
    expect(h.saveFile).toHaveBeenCalledWith(expect.anything(), { saveAs: true });
    await run(() => h.menu!.onNew());
    expect(doc().name).toBe(`${t("doc.untitled")}.md`);
  });
});
