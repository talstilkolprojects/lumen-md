/**
 * Pins the command palette's list: every command's id, label, group, hint,
 * shortcut and icon, in order, and which option or store action it calls
 * directly. Taken on the single-file useCommands.ts before it was split into
 * per-domain modules (plan 0.2), so the split is checked against the
 * original. An intended change to the list updates the snapshot
 * (`npx vitest run -u src/__tests__/commandIds.test.ts`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

const flags = vi.hoisted(() => ({ full: false }));
// Billing builds and installed plugins / marketplace templates add commands;
// the "full" scenario turns them all on.
vi.mock("../billing/planActions", async (orig) => ({
  ...(await orig<object>()),
  canPurchasePlans: () => flags.full,
}));
vi.mock("../plugins/pluginSystem", async (orig) => {
  const real = await orig<typeof import("../plugins/pluginSystem")>();
  return {
    ...real,
    getPluginCommands: () =>
      flags.full ? [{ id: "plugin.demo.run", label: "Demo plugin: run", hint: "demo", action: () => {} }] : real.getPluginCommands(),
  };
});
vi.mock("../commands/installedTemplates", async (orig) => {
  const real = await orig<typeof import("../commands/installedTemplates")>();
  return {
    ...real,
    useInstalledTemplates: () => {
      const list = real.useInstalledTemplates(); // keeps the hook order stable
      return flags.full ? [{ id: "weekly", name: "Weekly review", path: "templates/weekly.md" } as never] : list;
    },
  };
});

import { useCommands, type UseCommandsOptions } from "../commands/useCommands";
import { cmdIcons, type Command } from "../ui/CommandPalette";
import { useAppStore } from "../store/useStore";
import type { CollabSession } from "../collab/yjs";

const REQUIRED = [
  "handleNew", "handleOpen", "handleSave", "handleExportHtml", "handleSaveToWorkspace", "insertSnippet",
  "setRecents", "handleReopenRecent", "handleStartCollab", "handleStopCollab", "setSearchOpen",
  "setFindReplaceOpen", "setGraphOpen", "setHistoryOpen", "setTableEditorOpen", "setCanvasOpen", "setGalleryOpen",
] as const;
const OPTIONAL = [
  "setTemplateGalleryOpen", "setAuditLogOpen", "setOrgSettingsOpen", "setTrustedKeysOpen", "setThemeSettingsOpen",
  "setFineTuneOpen", "setTagsPanelOpen", "setCommentsPanelOpen", "setRuntimeMetricsOpen", "onAddComment", "getEditorView",
] as const;

function options(full: boolean): UseCommandsOptions {
  const fns: Record<string, () => void> = {};
  for (const name of [...REQUIRED, ...(full ? OPTIONAL : [])]) fns[name] = vi.fn();
  return {
    ...(fns as unknown as UseCommandsOptions),
    recents: full
      ? [
          { id: "r1", name: "first.md", openedAt: Date.now() - 60_000 } as never,
          { id: "r2", name: "second.md", openedAt: Date.now() - 3_600_000 } as never,
        ]
      : [],
    collab: full ? ({ roomName: "room-1", sharePassword: "pw" } as unknown as CollabSession) : null,
  };
}

type Entry = Record<string, unknown>;

/** What a command is, as data: everything but its action's body. */
function describeCommands(list: Command[], opts: UseCommandsOptions): Entry[] {
  const iconName = new Map<unknown, string>(Object.entries(cmdIcons).map(([k, v]) => [v, k]));
  const direct = new Map<unknown, string>();
  for (const [k, v] of Object.entries(opts)) if (typeof v === "function") direct.set(v, `option:${k}`);
  for (const [k, v] of Object.entries(useAppStore.getState())) if (typeof v === "function" && !direct.has(v)) direct.set(v, `store:${k}`);
  return list.map((c) => {
    const e: Entry = { id: c.id, label: c.label };
    if (c.group !== undefined) e.group = c.group;
    if (c.hint !== undefined) e.hint = /^recent\./.test(c.id) ? "<relative time>" : c.hint;
    if (c.shortcut !== undefined) e.shortcut = c.shortcut;
    if (c.icon !== undefined) e.icon = iconName.get(c.icon) ?? "<other>";
    if (direct.has(c.action)) e.action = direct.get(c.action);
    if (c.children) e.children = describeCommands(c.children, opts);
    return e;
  });
}

function snapshotOf(full: boolean): Entry[] {
  flags.full = full;
  const opts = options(full);
  const { result, unmount } = renderHook(() => useCommands(opts));
  const out = describeCommands(result.current, opts);
  unmount();
  return out;
}

const DEFAULTS = useAppStore.getState();

describe("command palette list (plan 0.2 split guard)", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      theme: DEFAULTS.theme,
      locale: "en",
      vimEnabled: DEFAULTS.vimEnabled,
      rtl: DEFAULTS.rtl,
      autoSave: DEFAULTS.autoSave,
      autoSaveInterval: DEFAULTS.autoSaveInterval,
      pageView: DEFAULTS.pageView,
      spellCheck: DEFAULTS.spellCheck,
      useLocalAi: DEFAULTS.useLocalAi,
      typewriterMode: DEFAULTS.typewriterMode,
      tsChecks: DEFAULTS.tsChecks,
      writingGoalWords: DEFAULTS.writingGoalWords,
      grammarCheck: DEFAULTS.grammarCheck,
      suggestingMode: DEFAULTS.suggestingMode,
    });
  });

  it("matches the snapshot in every scenario", async () => {
    const minimal = snapshotOf(false);

    // Every optional panel, a live collab room, billing, a plugin, an
    // installed template, recents, and every toggle flipped.
    useAppStore.setState({
      theme: DEFAULTS.theme === "dark" ? "light" : "dark",
      vimEnabled: !DEFAULTS.vimEnabled,
      rtl: !DEFAULTS.rtl,
      autoSave: !DEFAULTS.autoSave,
      pageView: !DEFAULTS.pageView,
      spellCheck: !DEFAULTS.spellCheck,
      useLocalAi: !DEFAULTS.useLocalAi,
      typewriterMode: !DEFAULTS.typewriterMode,
      tsChecks: !DEFAULTS.tsChecks,
      writingGoalWords: 750,
      grammarCheck: !DEFAULTS.grammarCheck,
      suggestingMode: !DEFAULTS.suggestingMode,
    });
    const full = snapshotOf(true);
    useAppStore.setState({ theme: DEFAULTS.theme, autoSave: true, autoSaveInterval: 5000 });
    const autoSaveOn = snapshotOf(false).filter((e) => e.id === "view.autoSave");

    // The AI prompt templates follow the UI locale.
    useAppStore.setState({ locale: "he" });
    const hebrew = snapshotOf(false).map((e) => e.id);

    expect(minimal.length).toBeGreaterThan(100);
    expect(new Set(minimal.map((e) => e.id)).size).toBe(minimal.length);
    await expect(JSON.stringify({ minimal, full, autoSaveOn, hebrewIds: hebrew }, null, 2) + "\n").toMatchFileSnapshot(
      "./__snapshots__/commandIds.snapshot.json",
    );
  });

  it("toggle labels follow the store without a rebuild from elsewhere (review: #208 follow-up)", () => {
    const opts = options(false);
    const { result, unmount } = renderHook(() => useCommands(opts));
    const label = (id: string) => result.current.find((c) => c.id === id)?.label;
    const toggles = [
      ["useLocalAi", "ai.localToggle"],
      ["spellCheck", "view.spellCheck"],
      ["rtl", "view.rtl"],
      ["typewriterMode", "view.typewriter"],
      ["tsChecks", "view.tsChecks"],
      ["grammarCheck", "view.grammarCheck"],
    ] as const;
    for (const [key, id] of toggles) {
      const before = label(id);
      expect(before, id).toBeDefined();
      act(() => useAppStore.setState({ [key]: !useAppStore.getState()[key] } as never));
      expect(label(id), `${id} after ${key} changed`).not.toBe(before);
    }
    unmount();
  });
});
