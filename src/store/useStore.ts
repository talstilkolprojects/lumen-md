import { DEFAULT_DAILY, isValidDailyPattern, type DailySettings } from "../daily/defaults";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { vaultEncryptionState } from "../storage/vault";
import { deferredJSONStorage, persistedTextLength } from "./deferredStorage";
import type { Locale } from "../i18n";
import { applyLocale, isLocaleLoaded, loadLocale } from "../i18n";
import {
  DEFAULT_THEME_SETTINGS,
  applyThemeSettings,
  sanitizeThemeSettings,
  type ThemeSettings,
} from "../lib/themeSettings";
import { lockedNotes } from "../storage/lockedNotesRegistry";

/** The phone layout's breakpoint (index.css: max-width 760px). */
export function isNarrowScreen(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches;
}

// Monotonic token so a slow lazy-locale fetch can't clobber a newer pick.
let localeRequest = 0;

export type ViewMode = "source" | "split" | "preview" | "wysiwyg";
export type Theme = "light" | "dark" | "system";
export type SyncScrollMode = "single" | "all";
/**
 * Split orientation:
 *   "auto"       – follow the viewport (horizontal on desktop, vertical on phone).
 *   "horizontal" – editor left, preview right. Locked.
 *   "vertical"   – editor top, preview bottom. Locked.
 */
export type SplitAxis = "auto" | "horizontal" | "vertical";

export interface DocFile {
  name: string;
  content: string;
  /** File System Access API handle, if the doc came from disk */
  handle?: FileSystemFileHandle;
  /** When set, the doc lives inside the OPFS workspace under this name. */
  workspaceName?: string | null;
  dirty: boolean;
  /**
   * Fresh on every load of a document (open, drop, new tab) — lets
   * `docIdentity` tell apart two loads of same-named files that have no
   * handle or workspace path (e.g. two `README.md` via the file-input
   * fallback), so per-document grants such as live-js run approval never
   * carry over to a different file.
   */
  loadId?: number;
}

let nextLoadId = 0;

/**
 * What an open tab keeps while it is not the active document and that
 * cannot be persisted with it: its load identity (live-JS approval and the
 * worker scope follow `docIdentity`) and the disk handle of a file opened
 * from the system (PWA file handling), so Save still writes back after a
 * tab switch. Runtime only — handles are not serializable.
 */
const tabRuntime = new Map<string, { loadId?: number; handle?: FileSystemFileHandle }>();

/** Test hook. */
export function __tabRuntime(): ReadonlyMap<string, { loadId?: number; handle?: FileSystemFileHandle }> {
  return tabRuntime;
}

/** A tab's id changed (rename, move, detach): its runtime state follows it. */
export function moveTabRuntime(fromId: string, toId: string): void {
  moveTabRuntimes([[fromId, toId]]);
}

/**
 * Several id changes at once, collision-safe: every source entry is read
 * before any is written, so a move into an id that is itself moving away in
 * the same batch (a moved note landing where an overwritten tab was) does not
 * carry the wrong runtime along.
 */
export function moveTabRuntimes(moves: ReadonlyArray<readonly [string, string]>): void {
  const real = moves.filter(([from, to]) => from !== to);
  const taken = real.map(([from, to]) => [to, tabRuntime.get(from)] as const);
  for (const [from] of real) tabRuntime.delete(from);
  for (const [to, rt] of taken) if (rt) tabRuntime.set(to, rt);
}

export interface AppState {
  doc: DocFile;
  mode: ViewMode;
  theme: Theme;
  /** Theme customisation (preset, accent, typography, measure). */
  themeSettings: ThemeSettings;
  locale: Locale;
  showOutline: boolean;
  /** Phones (plan 10.2.4): the outline as a bottom sheet — this session only, closed at start. */
  outlineSheet: boolean;
  showWorkspace: boolean;
  showBacklinks: boolean;
  vimEnabled: boolean;
  rtl: boolean;
  autoSave: boolean;
  autoSaveInterval: number;
  syncScroll: SyncScrollMode;
  splitAxis: SplitAxis;
  pageView: boolean;
  aiKey: string | null;
  /** Toggle browser-native red squiggle spell-check inside the editor. */
  spellCheck: boolean;
  /** Run AI locally via web-llm + WebGPU instead of OpenAI. */
  useLocalAi: boolean;
  /** Typewriter scroll mode — keep the active line vertically centred. */
  typewriterMode: boolean;
  /** Type-check ```ts blocks in the source editor (loads the TS compiler). */
  tsChecks: boolean;
  /** Daily notes: folder, file pattern, template (plan 4.12). */
  dailyNotes: DailySettings;
  /** The month calendar under the file tree. */
  showCalendar: boolean;
  /** Daily writing goal (words). 0 disables the banner. */
  writingGoalWords: number;
  /** Toggle LanguageTool-powered grammar/style checking in the editor. */
  grammarCheck: boolean;
  /** Suggesting mode (track changes): edits are recorded as CriticMarkup. */
  suggestingMode: boolean;
  /**
   * F3 — when set, `chat()` routes to the user's fine-tuned model
   * (id stored in `fineTunedModelId`). Off by default; flipped from
   * Settings only after a fine-tune job has succeeded.
   */
  useFineTunedModel: boolean;
  /** Persisted result of the last successful fine-tune job. */
  fineTunedModelId: string | null;
  /**
   * Active tag filter for the FileTree. When non-null, the tree shows only
   * the listed paths (and their parent directories). Driven by the Tags panel.
   * Not persisted — purely a runtime view-filter.
   */
  tagFilter: { tag: string; paths: string[] } | null;
  /**
   * Open document tabs (multi-doc UI). The currently active tab is the one
   * whose `id` matches `tabIdOf(doc)`. Tabs persist across reloads so users
   * resume where they left off.
   */
  openTabs: Array<{ id: string; name: string; content: string; workspaceName: string | null; dirty: boolean }>;
  setMode: (m: ViewMode) => void;
  setTheme: (t: Theme) => void;
  /** Merge a patch into the theme customisation and apply it live. */
  setThemeSettings: (patch: Partial<ThemeSettings>) => void;
  /** Restore the stock theme customisation. */
  resetThemeSettings: () => void;
  setLocale: (l: Locale) => void;
  setContent: (s: string) => void;
  setDoc: (d: Partial<DocFile>) => void;
  toggleOutline: () => void;
  toggleWorkspace: () => void;
  toggleBacklinks: () => void;
  toggleVim: () => void;
  toggleRtl: () => void;
  toggleAutoSave: () => void;
  setAutoSaveInterval: (ms: number) => void;
  markSaved: () => void;
  setAiKey: (key: string | null) => void;
  toggleSyncScroll: () => void;
  togglePageView: () => void;
  setSplitAxis: (axis: SplitAxis) => void;
  toggleSpellCheck: () => void;
  toggleLocalAi: () => void;
  toggleTypewriter: () => void;
  toggleTsChecks: () => void;
  setWritingGoal: (words: number) => void;
  setDailyNotes: (patch: Partial<DailySettings>) => void;
  toggleCalendar: () => void;
  /** Toggle the LanguageTool grammar checker. */
  toggleGrammarCheck: () => void;
  /** Toggle suggesting mode (track changes). */
  toggleSuggestingMode: () => void;
  /** Toggle the personal fine-tuned model on/off (F3). */
  toggleFineTunedModel: () => void;
  /** Persist the resulting model id from a successful fine-tune job. */
  setFineTunedModelId: (id: string | null) => void;
  /** Apply or clear the tag-based file-tree filter. */
  setTagFilter: (filter: { tag: string; paths: string[] } | null) => void;
  /**
   * Open (or focus) a doc as a tab. Idempotent: re-opening an already-open
   * doc just selects that tab. Updates `doc` to mirror the active tab.
   */
  openTab: (input: { name: string; content: string; workspaceName?: string | null; handle?: FileSystemFileHandle }) => void;
  /** Close a tab by id. If it was active, falls back to the neighbour. */
  closeTab: (id: string) => void;
  /**
   * The active ad-hoc document was just written into the workspace under
   * `workspaceName`: the document and its tab take that identity (the tab
   * id follows, since it is the workspace name) and are clean.
   */
  adoptWorkspaceName: (workspaceName: string) => void;
  /** Reorder a tab from one index to another (drag-and-drop). */
  reorderTabs: (fromIndex: number, toIndex: number) => void;
}

/** Stable per-tab identity. Workspace name preferred (unique across the
 *  vault), falls back to display name for ad-hoc / untitled docs. Treats
 *  empty strings as missing — `""` should never be a tab id. */
export function tabIdOf(d: { workspaceName?: string | null; name: string }): string {
  if (d.workspaceName) return d.workspaceName;
  if (d.name) return d.name;
  return "Untitled";
}

const DEFAULT_DOC: DocFile = {
  name: "Welcome.md",
  content: "",
  dirty: false,
};

/**
 * Editors holding edits they haven't emitted yet (the WYSIWYG editor
 * debounces its listener). Before the active document is switched or
 * replaced, each flushes them synchronously, so they still reach the
 * document they were made in: once the switch has happened, the editor's
 * `onChange` (setContent) would write them into the newly active one.
 */
const pendingEditFlushers = new Set<() => void>();
export function registerPendingEdits(flush: () => void): () => void {
  pendingEditFlushers.add(flush);
  return () => void pendingEditFlushers.delete(flush);
}
let flushingEdits = false;
/** Make every editor emit the edits it is still holding (into the active document). */
export function flushPendingEdits(): void {
  if (flushingEdits) return;
  flushingEdits = true;
  try {
    for (const flush of [...pendingEditFlushers]) {
      try {
        flush();
      } catch {
        /* why: an editor mid-teardown: nothing to flush */
      }
    }
  } finally {
    flushingEdits = false;
  }
}
/** `action`, run after every editor has flushed its pending edits. */
function afterPendingEdits<A extends unknown[]>(action: (...args: A) => void): (...args: A) => void {
  return (...args) => {
    flushPendingEdits();
    action(...args);
  };
}

/**
 * Told when an open note stays the same note under a new tab id: adopted
 * into the workspace (autosave of an ad-hoc note), renamed, or moved. Code
 * that remembers a tab id, such as dictation, follows the note with this.
 */
const tabIdChangeListeners = new Set<(from: string, to: string) => void>();
export function onTabIdChange(fn: (from: string, to: string) => void): () => void {
  tabIdChangeListeners.add(fn);
  return () => void tabIdChangeListeners.delete(fn);
}
export function notifyTabIdChange(from: string, to: string): void {
  if (from === to) return;
  for (const fn of [...tabIdChangeListeners]) fn(from, to);
}

/** The first-run view: Preview on narrow screens, Split elsewhere. */
export function defaultMode(width: number = typeof window !== "undefined" ? window.innerWidth : 1280): "split" | "preview" {
  return width < 768 ? "preview" : "split";
}

/** What of the app state survives a reload. */
const partializeAppState = (s: AppState) =>
  ({
    mode: s.mode,
    theme: s.theme,
    themeSettings: s.themeSettings,
    locale: s.locale,
    showOutline: s.showOutline,
    showWorkspace: s.showWorkspace,
    showBacklinks: s.showBacklinks,
    vimEnabled: s.vimEnabled,
    rtl: s.rtl,
    autoSave: s.autoSave,
    autoSaveInterval: s.autoSaveInterval,
    syncScroll: s.syncScroll,
    splitAxis: s.splitAxis,
    pageView: s.pageView,
    spellCheck: s.spellCheck,
    useLocalAi: s.useLocalAi,
    typewriterMode: s.typewriterMode,
    tsChecks: s.tsChecks,
    writingGoalWords: s.writingGoalWords,
    dailyNotes: s.dailyNotes,
    showCalendar: s.showCalendar,
    grammarCheck: s.grammarCheck,
    suggestingMode: s.suggestingMode,
    useFineTunedModel: s.useFineTunedModel,
    fineTunedModelId: s.fineTunedModelId,
    // aiKey intentionally excluded — session-only for security
    // An encrypted vault (plan 11.4): the open note and the tabs hold
    // note text, and localStorage is plain — they are not kept; after a
    // reload the notes open again from the (encrypted) vault.
    ...(vaultEncryptionState() === "locked" || vaultEncryptionState() === "unlocked"
      ? {}
      : {
          // W5.11: a note unlocked with its own password is kept sealed.
          doc: {
            name: s.doc.name,
            content: lockedNotes.atRest(s.doc.workspaceName, s.doc.content),
            dirty: s.doc.dirty,
            workspaceName: s.doc.workspaceName ?? null,
          },
          // Persist open tabs so the user's session resumes after reload.
          // Heavy `handle` references are intentionally excluded (not
          // structured-cloneable through localStorage anyway).
          openTabs: lockedNotes.paths().length ? s.openTabs.map((t) => ({ ...t, content: lockedNotes.atRest(t.workspaceName, t.content) })) : s.openTabs,
        }),
  });

type PersistedAppState = ReturnType<typeof partializeAppState>;

/** Persisted states with more document text than this are written when typing pauses. */
const LARGE_PERSIST_CHARS = 200_000;

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      doc: DEFAULT_DOC,
      // Phones start in Preview (C1): reading first, and the editor's code
      // (CodeMirror, ~550 KB) loads only when the user switches to editing.
      // A saved choice always wins (persisted below).
      mode: defaultMode(),
      theme: "dark",
      themeSettings: { ...DEFAULT_THEME_SETTINGS },
      locale: "en",
      showOutline: true,
      outlineSheet: false,
      showWorkspace: false,
      showBacklinks: false,
      vimEnabled: false,
      rtl: false,
      autoSave: true,
      autoSaveInterval: 30000,
      syncScroll: "all" as SyncScrollMode,
      splitAxis: "auto" as SplitAxis,
      pageView: false,
      aiKey: null,
      spellCheck: true,
      useLocalAi: true,
      typewriterMode: false,
      tsChecks: false,
      writingGoalWords: 0,
      dailyNotes: { ...DEFAULT_DAILY },
      showCalendar: false,
      grammarCheck: false,
      suggestingMode: false,
      useFineTunedModel: false,
      fineTunedModelId: null,
      tagFilter: null,
      openTabs: [],
      // Suggesting mode tracks edits in the source editor and in WYSIWYG
      // (editor/wysiwygSuggest.ts), so any view works while it is on.
      setMode: (m) => set({ mode: m }),
      setTheme: (t) => {
        set({ theme: t });
        applyTheme(t);
      },
      setThemeSettings: (patch) =>
        set((s) => {
          const next = sanitizeThemeSettings({ ...s.themeSettings, ...patch });
          if (typeof document !== "undefined") applyThemeSettings(next, document.documentElement);
          return { themeSettings: next };
        }),
      resetThemeSettings: () => {
        const next = { ...DEFAULT_THEME_SETTINGS };
        if (typeof document !== "undefined") applyThemeSettings(next, document.documentElement);
        set({ themeSettings: next });
      },
      setLocale: (l) => {
        const req = ++localeRequest;
        const commit = () => {
          if (req !== localeRequest) return;
          // The chunk couldn't load (offline / missing): stay consistent
          // and switch to English rather than English strings under an
          // RTL `lang="he"` UI.
          const locale = isLocaleLoaded(l) ? l : "en";
          applyLocale(locale);
          set({ locale });
        };
        // Non-English bundles are lazy chunks (A7 lever 4). Commit the
        // store change only once the strings are in memory so the
        // re-render it triggers already reads the new language via t().
        if (isLocaleLoaded(l)) commit();
        else void loadLocale(l).then(commit, commit);
      },
      setContent: (s) =>
        set((state) => {
          const nextDoc = { ...state.doc, content: s, dirty: true };
          const id = tabIdOf(nextDoc);
          // Mirror the edit into the matching tab so the dirty-marker on
          // the tab strip stays accurate without a separate event channel.
          const nextTabs = state.openTabs.map((t) =>
            t.id === id ? { ...t, content: s, dirty: true } : t,
          );
          return { doc: nextDoc, openTabs: nextTabs };
        }),
      setDoc: afterPendingEdits((d) => {
        const renamed: Array<[string, string]> = [];
        set((state) => {
          const nextDoc = {
            ...state.doc,
            ...d,
            dirty: d.dirty ?? state.doc.dirty,
          };
          // name + content together = a different document was loaded.
          const loaded = "name" in d && "content" in d;
          if (loaded) nextDoc.loadId = ++nextLoadId;
          const id = tabIdOf(nextDoc);
          // A new name without new content is the same note renamed (rename, save to workspace).
          if (!loaded) renamed.push([tabIdOf(state.doc), id]);
          // Keep the matching tab in sync with `setDoc` patches (e.g. rename,
          // markSaved) so the tab strip never lies.
          const nextTabs = state.openTabs.map((t) =>
            t.id === id
              ? {
                  ...t,
                  name: nextDoc.name,
                  content: nextDoc.content,
                  workspaceName: nextDoc.workspaceName ?? null,
                  dirty: nextDoc.dirty,
                }
              : t,
          );
          return { doc: nextDoc, openTabs: nextTabs };
        });
        for (const [from, to] of renamed) notifyTabIdChange(from, to);
      }),
      // On a phone-width screen the outline is a bottom sheet over the
      // editor: the toggle opens/closes the sheet and leaves the desktop
      // side-panel setting as it was.
      toggleOutline: () =>
        set((s) => (isNarrowScreen() ? { outlineSheet: !s.outlineSheet } : { showOutline: !s.showOutline })),
      toggleWorkspace: () => set((s) => ({ showWorkspace: !s.showWorkspace })),
      toggleBacklinks: () => set((s) => ({ showBacklinks: !s.showBacklinks })),
      toggleVim: () => set((s) => ({ vimEnabled: !s.vimEnabled })),
      toggleRtl: () => set((s) => {
        const next = !s.rtl;
        applyDirection(next);
        return { rtl: next };
      }),
      toggleAutoSave: () => set((s) => ({ autoSave: !s.autoSave })),
      setAutoSaveInterval: (ms) => set({ autoSaveInterval: ms }),
      markSaved: () =>
        set((state) => ({ doc: { ...state.doc, dirty: false } })),
      setAiKey: (key) => set({ aiKey: key }),
      toggleSyncScroll: () => set((s) => ({ syncScroll: s.syncScroll === "all" ? "single" : "all" })),
      togglePageView: () => set((s) => ({ pageView: !s.pageView })),
      setSplitAxis: (axis) => set({ splitAxis: axis }),
      toggleSpellCheck: () => set((s) => ({ spellCheck: !s.spellCheck })),
      toggleLocalAi: () => set((s) => ({ useLocalAi: !s.useLocalAi })),
      toggleTypewriter: () => set((s) => ({ typewriterMode: !s.typewriterMode })),
      toggleTsChecks: () => set((s) => ({ tsChecks: !s.tsChecks })),
      setWritingGoal: (words) => set({ writingGoalWords: Math.max(0, Math.floor(words)) }),
      setDailyNotes: (patch) =>
        set((s) => {
          const next = { ...s.dailyNotes, ...patch };
          // A pattern without YYYY, MM and DD would merge days into one file.
          if (!isValidDailyPattern(next.pattern)) next.pattern = s.dailyNotes.pattern;
          return { dailyNotes: next };
        }),
      // The calendar lives in the file sidebar: showing it shows the sidebar too.
      toggleCalendar: () => set((s) => (s.showCalendar && s.showWorkspace ? { showCalendar: false } : { showCalendar: true, showWorkspace: true })),
      toggleGrammarCheck: () => set((s) => ({ grammarCheck: !s.grammarCheck })),
      toggleSuggestingMode: () =>
        set((s) => {
          return { suggestingMode: !s.suggestingMode };
        }),
      toggleFineTunedModel: () =>
        set((s) => {
          // Refuse to flip ON when no model id is persisted.
          if (!s.useFineTunedModel && !s.fineTunedModelId) return s;
          return { useFineTunedModel: !s.useFineTunedModel };
        }),
      setFineTunedModelId: (id) => set({ fineTunedModelId: id }),
      setTagFilter: (filter) => set({ tagFilter: filter }),
      openTab: afterPendingEdits((input) =>
        set((state) => {
          const id = tabIdOf({
            workspaceName: input.workspaceName ?? null,
            name: input.name,
          });
          // Persist the *current* doc back into its tab before switching, so
          // unsaved edits don't get clobbered when the user switches away
          // and back. Then either focus the existing tab for `id` or push a
          // new one onto the strip.
          const currentId = tabIdOf(state.doc);
          if (state.openTabs.some((t) => t.id === currentId)) tabRuntime.set(currentId, { loadId: state.doc.loadId, handle: state.doc.handle });
          // Focusing a tab that is already open with the same text is the same load:
          // keep its identity, handle and unsaved marker instead of minting a new load.
          const existing = state.openTabs.find((t) => t.id === id);
          const kept = id === currentId ? { loadId: state.doc.loadId, handle: state.doc.handle } : tabRuntime.get(id);
          const sameLoad = !!existing && existing.content === input.content && kept?.loadId !== undefined;
          // The tab's unsaved marker survives whenever it is shown with this very
          // text (edits made while it was in the background, e.g. an approved
          // agent change, plan 5.11, included), so autosave still writes them.
          const held = id === currentId ? state.doc : existing;
          const dirty = !!held && held.content === input.content && held.dirty;
          const baseTabs = state.openTabs.some((t) => t.id === currentId)
            ? state.openTabs.map((t) =>
                t.id === currentId
                  ? {
                      ...t,
                      content: state.doc.content,
                      dirty: state.doc.dirty,
                      name: state.doc.name,
                      workspaceName: state.doc.workspaceName ?? null,
                    }
                  : t,
              )
            : state.openTabs;

          let nextTabs = baseTabs;
          if (!nextTabs.some((t) => t.id === id)) {
            nextTabs = [
              ...nextTabs,
              {
                id,
                name: input.name,
                content: input.content,
                workspaceName: input.workspaceName ?? null,
                dirty: false,
              },
            ];
          }
          const loadId = sameLoad ? kept!.loadId : ++nextLoadId;
          const handle = input.handle ?? (sameLoad ? kept?.handle : undefined);
          tabRuntime.set(id, { loadId, handle });
          return {
            openTabs: nextTabs,
            doc: {
              name: input.name,
              content: input.content,
              workspaceName: input.workspaceName ?? null,
              handle,
              dirty,
              loadId,
            },
          };
        })),
      adoptWorkspaceName: (workspaceName) => {
        let from = "";
        let to = "";
        set((state) => {
          const prevId = tabIdOf(state.doc);
          const doc: DocFile = { ...state.doc, name: workspaceName, workspaceName, handle: undefined, dirty: false };
          const id = tabIdOf(doc);
          from = prevId;
          to = id;
          const openTabs = state.openTabs.map((t) =>
            t.id === prevId ? { ...t, id, name: doc.name, content: doc.content, workspaceName, dirty: false } : t,
          );
          moveTabRuntime(prevId, id);
          return { doc, openTabs };
        });
        notifyTabIdChange(from, to);
      },
      closeTab: afterPendingEdits((id) =>
        set((state) => {
          const idx = state.openTabs.findIndex((t) => t.id === id);
          if (idx === -1) return state;
          const nextTabs = state.openTabs.filter((t) => t.id !== id);
          const wasActive = tabIdOf(state.doc) === id;
          tabRuntime.delete(id);
          if (!wasActive) return { openTabs: nextTabs };
          // Active tab closed — fall back to the neighbour at the same index
          // (or the previous one if we just lost the rightmost tab).
          const fallback =
            nextTabs[Math.min(idx, nextTabs.length - 1)] ?? null;
          if (!fallback) {
            return {
              openTabs: nextTabs,
              doc: {
                name: "Untitled.md",
                content: "",
                workspaceName: null,
                dirty: false,
              },
            };
          }
          const kept = tabRuntime.get(fallback.id);
          return {
            openTabs: nextTabs,
            doc: {
              name: fallback.name,
              content: fallback.content,
              workspaceName: fallback.workspaceName ?? null,
              dirty: fallback.dirty,
              handle: kept?.handle,
              loadId: kept?.loadId ?? ++nextLoadId,
            },
          };
        })),
      reorderTabs: (fromIndex, toIndex) =>
        set((state) => {
          if (fromIndex === toIndex) return state;
          if (fromIndex < 0 || fromIndex >= state.openTabs.length) return state;
          const clamped = Math.max(0, Math.min(toIndex, state.openTabs.length - 1));
          const next = [...state.openTabs];
          const [moved] = next.splice(fromIndex, 1);
          next.splice(clamped, 0, moved);
          return { openTabs: next };
        }),
    }),
    {
      name: "lumen-md",
      // A long open document is saved to localStorage once typing pauses,
      // not on every keystroke (plan 8.4).
      storage: deferredJSONStorage<PersistedAppState>((v) => persistedTextLength(v.state) >= LARGE_PERSIST_CHARS),
      partialize: partializeAppState,
      // Persisted theme settings may be stale or hand-edited — sanitise
      // field-by-field on rehydrate instead of trusting localStorage.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppState>;
        const merged = {
          ...current,
          ...p,
          themeSettings: sanitizeThemeSettings(p.themeSettings),
          // A hand-edited or older store: keep only string fields, fall back per field.
          dailyNotes: {
            folder: typeof p.dailyNotes?.folder === "string" ? p.dailyNotes.folder : DEFAULT_DAILY.folder,
            pattern: typeof p.dailyNotes?.pattern === "string" && isValidDailyPattern(p.dailyNotes.pattern) ? p.dailyNotes.pattern : DEFAULT_DAILY.pattern,
            template: typeof p.dailyNotes?.template === "string" ? p.dailyNotes.template : DEFAULT_DAILY.template,
          },
          showCalendar: p.showCalendar === true,
        };
        // WYSIWYG and suggesting work together now: restore both as saved.
        return merged;
      },
    },
  ),
);

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.classList.toggle("dark", dark);
  // Preset palettes differ between light and dark, so re-apply them.
  applyThemeSettings(useAppStore.getState().themeSettings, root, dark);
}

// Re-apply when the OS color scheme changes (only meaningful for theme="system").
if (typeof window !== "undefined" && window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    const t = useAppStore.getState().theme;
    if (t === "system") applyTheme(t);
  };
  if (mq.addEventListener) mq.addEventListener("change", handler);
  else if (mq.addListener) mq.addListener(handler);
}

export function applyDirection(rtl: boolean) {
  document.documentElement.dir = rtl ? "rtl" : "ltr";
}

/**
 * Align the (already rehydrated) store with the locale boot actually
 * applied. `initLocale` falls back to English when the saved locale's chunk
 * can't load; without this, App's mount effect would re-apply the saved
 * locale (English strings under e.g. Hebrew RTL).
 */
export function adoptBootLocale(applied: Locale): void {
  if (useAppStore.getState().locale !== applied) useAppStore.setState({ locale: applied });
}
