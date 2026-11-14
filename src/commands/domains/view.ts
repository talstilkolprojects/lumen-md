/** View commands: editor modes, panels, editor settings, language and theme. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { useAppStore } from "../../store/useStore";
import { t, SUPPORTED_LOCALES } from "../../i18n";
import type { CommandContext } from "./context";

/** Editor modes, side panels and the editor's on/off settings. */
export function buildViewCommands({ setSearchOpen, setRuntimeMetricsOpen, vimEnabled, spellCheck, typewriterMode, pageView, toggleWorkspace, toggleBacklinks, toggleVim, toggleSpellCheck, toggleTypewriter, tsChecks, toggleTsChecks, grammarCheck, toggleGrammarCheck, setMode, toggleOutline }: CommandContext): Command[] {
  return [
    {
      id: "view.source",
      label: t("cmd.view.source"),
      shortcut: "⌘1",
      icon: cmdIcons.Pencil,
      group: t("group.view"),
      action: () => setMode("source"),
    },
    {
      id: "view.split",
      label: t("cmd.view.split"),
      shortcut: "⌘2",
      icon: cmdIcons.Columns2,
      group: t("group.view"),
      action: () => setMode("split"),
    },
    {
      id: "view.preview",
      label: t("cmd.view.preview"),
      shortcut: "⌘3",
      icon: cmdIcons.Eye,
      group: t("group.view"),
      action: () => setMode("preview"),
    },
    {
      id: "view.wysiwyg",
      label: t("cmd.view.wysiwyg"),
      hint: t("cmd.view.wysiwyg.hint"),
      shortcut: "⌘4",
      icon: cmdIcons.Sparkles,
      group: t("group.view"),
      action: () => setMode("wysiwyg"),
    },
    {
      id: "view.outline",
      label: t("cmd.view.outline"),
      icon: cmdIcons.PanelRightOpen,
      group: t("group.view"),
      action: toggleOutline,
    },
    {
      id: "view.pageView",
      label: t("cmd.view.pageView"),
      hint: pageView ? t("cmd.view.pageView.on") : t("cmd.view.pageView.off"),
      icon: cmdIcons.FileText,
      group: t("group.view"),
      action: () => useAppStore.getState().togglePageView(),
    },
    {
      id: "view.workspace",
      label: t("cmd.view.workspace"),
      hint: t("cmd.view.workspace.hint"),
      icon: cmdIcons.FolderOpen,
      group: t("group.view"),
      action: toggleWorkspace,
    },
    {
      id: "note.today",
      label: t("cmd.note.today"),
      hint: t("cmd.note.today.hint"),
      shortcut: "⌥⌘D",
      icon: cmdIcons.FileText,
      group: t("group.file"),
      action: () => window.dispatchEvent(new CustomEvent("lumen-open-today")),
    },
    {
      id: "view.calendar",
      label: t("cmd.view.calendar"),
      hint: t("cmd.view.calendar.hint"),
      icon: cmdIcons.FileText,
      group: t("group.view"),
      action: () => useAppStore.getState().toggleCalendar(),
    },
    {
      id: "view.backlinks",
      label: t("cmd.view.backlinks"),
      hint: t("cmd.view.backlinks.hint"),
      icon: cmdIcons.Link,
      group: t("group.view"),
      action: toggleBacklinks,
    },
    {
      id: "view.search",
      label: t("cmd.view.search"),
      shortcut: "⇧⌘F",
      icon: cmdIcons.PanelRightOpen,
      group: t("group.view"),
      action: () => setSearchOpen(true),
    },
    {
      id: "view.smartSearch",
      label: t("cmd.view.smartSearch"),
      hint: t("cmd.view.smartSearch.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.view"),
      action: () => {
        (window as unknown as { __lumenSearchMode?: string }).__lumenSearchMode = "smart";
        setSearchOpen(true);
      },
    },
    ...(setRuntimeMetricsOpen
      ? [
          {
            id: "view.runtimeMetrics",
            label: t("cmd.view.runtimeMetrics"),
            hint: t("cmd.view.runtimeMetrics.hint"),
            icon: cmdIcons.BarChart3,
            group: t("group.view"),
            action: () => setRuntimeMetricsOpen(true),
          },
        ]
      : []),
    {
      id: "view.vim",
      label: vimEnabled ? t("cmd.view.vim.off") : t("cmd.view.vim.on"),
      icon: cmdIcons.Pencil,
      group: t("group.view"),
      action: toggleVim,
    },
    {
      id: "view.spellCheck",
      label: spellCheck
        ? t("cmd.view.spellCheck.off")
        : t("cmd.view.spellCheck.on"),
      hint: t("cmd.view.spellCheck.hint"),
      icon: cmdIcons.Pencil,
      group: t("group.view"),
      action: toggleSpellCheck,
    },
    {
      id: "view.typewriter",
      label: typewriterMode
        ? t("cmd.view.typewriter.off")
        : t("cmd.view.typewriter.on"),
      hint: t("cmd.view.typewriter.hint"),
      icon: cmdIcons.Pencil,
      group: t("group.view"),
      action: toggleTypewriter,
    },
    {
      id: "view.tsChecks",
      label: tsChecks ? t("cmd.view.tsChecks.off") : t("cmd.view.tsChecks.on"),
      hint: t("cmd.view.tsChecks.hint"),
      icon: cmdIcons.Pencil,
      group: t("group.view"),
      action: toggleTsChecks,
    },
    {
      id: "view.grammarCheck",
      label: grammarCheck
        ? t("cmd.view.grammarCheck.off") ?? "Disable grammar check"
        : t("cmd.view.grammarCheck.on") ?? "Enable grammar check (LanguageTool)",
      hint:
        t("cmd.view.grammarCheck.hint") ??
        "Underlines grammar / style / typo issues. Calls LanguageTool — set VITE_LANGUAGETOOL_URL to self-host.",
      icon: cmdIcons.Pencil,
      group: t("group.view"),
      action: toggleGrammarCheck,
    },
  ];
}

/** Text direction and UI language. */
export function buildLanguageCommands({ rtl, toggleRtl, setLocale }: CommandContext): Command[] {
  return [
    {
      id: "view.rtl",
      label: rtl ? t("cmd.view.rtl.off") : t("cmd.view.rtl.on"),
      hint: rtl ? "← LTR" : "→ RTL",
      icon: cmdIcons.Pencil,
      group: t("group.view"),
      action: toggleRtl,
    },
    ...SUPPORTED_LOCALES.map((l) => ({
      id: `lang.${l.code}`,
      label: t("cmd.view.language", { label: l.label }),
      hint:
        l.dir === "rtl"
          ? t("cmd.view.language.rtl")
          : t("cmd.view.language.ltr"),
      icon: cmdIcons.PanelRightOpen,
      group: t("group.view"),
      action: () => setLocale(l.code),
    })),
  ];
}

/** Find & replace, graph, history, table editor, autosave, canvas, plugins. */
export function buildPanelCommands({ setFindReplaceOpen, setGraphOpen, setHistoryOpen, setTableEditorOpen, setCanvasOpen, setGalleryOpen, autoSave, autoSaveInterval, toggleAutoSave }: CommandContext): Command[] {
  return [
    {
      id: "view.findReplace",
      label: t("cmd.view.findReplace"),
      shortcut: "⌘H",
      icon: cmdIcons.PanelRightOpen,
      group: t("group.view"),
      action: () => setFindReplaceOpen(true),
    },
    {
      id: "view.graphView",
      label: t("cmd.view.graphView"),
      hint: t("cmd.view.graphView.hint"),
      icon: cmdIcons.PanelRightOpen,
      group: t("group.view"),
      action: () => {
        setGraphOpen(true);
      },
    },
    {
      id: "view.versionHistory",
      label: t("cmd.view.versionHistory"),
      hint: t("cmd.view.versionHistory.hint"),
      icon: cmdIcons.PanelRightOpen,
      group: t("group.view"),
      action: () => setHistoryOpen(true),
    },
    {
      id: "insert.table",
      label: t("cmd.insert.table"),
      hint: t("cmd.insert.table.hint"),
      icon: cmdIcons.Pencil,
      group: t("group.insert"),
      action: () => setTableEditorOpen(true),
    },
    {
      id: "view.autoSave",
      label: autoSave ? t("cmd.view.autoSave.off") : t("cmd.view.autoSave.on"),
      hint: autoSave ? t("cmd.view.autoSave.hint", { interval: autoSaveInterval / 1000 }) : "off",
      icon: cmdIcons.Pencil,
      group: t("group.view"),
      action: toggleAutoSave,
    },
    {
      id: "view.canvas",
      label: t("cmd.view.canvas"),
      hint: t("cmd.view.canvas.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.view"),
      action: () => setCanvasOpen(true),
    },
    {
      id: "view.plugins",
      label: t("cmd.view.plugins"),
      hint: t("cmd.view.plugins.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.view"),
      action: () => setGalleryOpen(true),
    },
  ];
}

/** Light / dark theme. */
export function buildThemeToggleCommands({ theme, setTheme }: CommandContext): Command[] {
  const isDark = theme === "dark";
  return [
    {
      id: "theme.toggle",
      label: isDark ? t("cmd.view.theme.toLight") : t("cmd.view.theme.toDark"),
      icon: isDark ? cmdIcons.Sun : cmdIcons.Moon,
      group: t("group.view"),
      action: () => setTheme(isDark ? "light" : "dark"),
    },
  ];
}
