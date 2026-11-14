/** View commands: editor modes, panels, editor settings, language and theme. */
import { isBetaLocale } from "../../i18n/review";
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { useAppStore } from "../../store/useStore";
import { t, SUPPORTED_LOCALES } from "../../i18n";
import type { CommandContext } from "./context";
import { EXCALIDRAW_CANVAS_ENABLED } from "../../canvas/engine";
import { log } from "../../lib/logger";

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
      id: "mobile.customizeToolbar",
      label: t("cmd.mobile.customizeToolbar"),
      hint: t("cmd.mobile.customizeToolbar.hint"),
      icon: cmdIcons.Pencil,
      group: t("group.view"),
      action: () => window.dispatchEvent(new CustomEvent("lumen-mobile-customize")),
    },
    {
      id: "mobile.readLongNotes",
      label: t("cmd.mobile.readLongNotes"),
      hint: useAppStore.getState().readLongNotes ? t("cmd.mobile.readLongNotes.on") : t("cmd.mobile.readLongNotes.off"),
      icon: cmdIcons.Eye,
      group: t("group.view"),
      action: () => {
        const st = useAppStore.getState();
        st.setReadLongNotes(!st.readLongNotes);
      },
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
      id: "pdf.open",
      label: t("cmd.pdf.open"),
      hint: t("cmd.pdf.open.hint"),
      icon: cmdIcons.FileText,
      group: t("group.file"),
      // Plan 4.14: copies the PDF into the vault and opens it in the reader.
      action: () => void import("../../pdf/openPdf").then((m) => m.pickAndOpenPdf()),
    },
    {
      id: "student.lecture",
      label: t("cmd.student.lecture"),
      hint: t("cmd.student.lecture.hint"),
      icon: cmdIcons.FileText,
      group: t("group.file"),
      // Plan W5.13: record a lecture, mark the important moments, get a transcript, a summary and review cards.
      action: () => void import("../../student/LectureRecorder").then((m) => m.openLectureRecorder()),
    },
    {
      id: "note.capture",
      label: t("capture.title"),
      shortcut: "⌥⌘N",
      icon: cmdIcons.FileText,
      group: t("group.file"),
      action: () => window.dispatchEvent(new CustomEvent("lumen-open-capture")),
    },
    {
      id: "epub.open",
      label: t("cmd.epub.open"),
      icon: cmdIcons.FileText,
      group: t("group.file"),
      // Plan W1.14: copies the book into the vault and opens it in the reader.
      action: () => void import("../../epub/openEpub").then((m) => m.pickAndOpenEpub()),
    },
    {
      id: "view.reading",
      label: t("cmd.reading.mode"),
      icon: cmdIcons.FileText,
      group: t("group.file"),
      // Plan W1.14: the open note (a clip, typically) as a page to read and highlight.
      action: () => void import("../../epub/ReadingMode").then((m) => m.openReadingMode()),
    },
    {
      id: "view.highlights",
      label: t("cmd.highlights.all"),
      icon: cmdIcons.FileText,
      group: t("group.file"),
      // Plan W1.15: every PDF, EPUB and clip highlight — search, tags, export.
      action: () => void import("../../highlights/HighlightsPanel").then((m) => m.openHighlightsPanel()),
    },
    {
      id: "view.review",
      label: t("cmd.review.daily"),
      icon: cmdIcons.FileText,
      group: t("group.file"),
      // Plan W3.3: today's spaced-repetition cards (highlights and question::answer).
      action: () => void import("../../srs/ReviewPanel").then((m) => m.openDailyReview()),
    },
    {
      id: "highlights.import",
      label: t("cmd.highlights.import"),
      icon: cmdIcons.FileText,
      group: t("group.file"),
      // Plan W2.15: Kindle, Kobo, Readwise and Zotero highlights into one note per book.
      action: () => void import("../../highlights/import/runImport").then((m) => m.importHighlights()),
    },
    {
      id: "research.litReview",
      label: t("cmd.research.litReview"),
      hint: t("cmd.research.litReview.hint"),
      icon: cmdIcons.FileText,
      group: t("group.file"),
      // Plan W5.12: a matrix of every PDF in the vault, each value with a quote verified on its page.
      action: () => import("./viewActions").then((m) => m.researchLitReview()),
    },
    {
      id: "note.morning",
      label: t("cmd.note.morning"),
      hint: t("cmd.note.morning.hint"),
      icon: cmdIcons.FileText,
      group: t("group.file"),
      // Plan W5.19: turn "Your morning" on (off by default) and write it into today's note now.
      action: () => import("./viewActions").then((m) => m.noteMorning()),
    },
    {
      id: "note.morningOff",
      label: t("cmd.note.morningOff"),
      hint: t("cmd.note.morningOff.hint"),
      icon: cmdIcons.FileText,
      group: t("group.file"),
      action: () => useAppStore.getState().setDailyNotes({ morning: false }),
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
      id: "view.localGraph",
      label: t("cmd.view.localGraph"),
      hint: t("cmd.view.localGraph.hint"),
      icon: cmdIcons.Link,
      group: t("group.view"),
      action: () => useAppStore.getState().toggleLocalGraph(),
    },
    {
      id: "view.search",
      label: t("cmd.view.search"),
      // No shortcut shown: ⇧⌘F is focus mode (App.tsx) — the palette promised
      // a key that did something else (W2.8 conflict check).
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
        ? t("cmd.view.grammarCheck.off")
        : t("cmd.view.grammarCheck.on"),
      hint:
        t("cmd.view.grammarCheck.hint"),
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
      // Plan W4.18: a language no native speaker has reviewed says so.
      label: t("cmd.view.language", { label: isBetaLocale(l.code) ? t("locale.betaLabel", { label: l.label }) : l.label }),
      hint:
        l.dir === "rtl"
          ? t("cmd.view.language.rtl")
          : t("cmd.view.language.ltr"),
      icon: cmdIcons.PanelRightOpen,
      group: t("group.view"),
      action: () => setLocale(l.code),
    })),
    {
      id: "i18n.suggest",
      label: t("cmd.i18n.suggest"),
      hint: t("cmd.i18n.suggest.hint"),
      icon: cmdIcons.PanelRightOpen,
      group: t("group.view"),
      action: async () => {
        const { openTranslationSuggest } = await import("../../ui/TranslationSuggest");
        openTranslationSuggest();
      },
    },
  ];
}

/** Find & replace, graph, history, table editor, autosave, canvas, plugins. */
export function buildPanelCommands({ setFindReplaceOpen, setGraphOpen, setHistoryOpen, setTableEditorOpen, setCanvasOpen, setGalleryOpen, autoSave, autoSaveInterval, toggleAutoSave, liveDoc }: CommandContext): Command[] {
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
      id: "view.present",
      label: t("cmd.view.present"),
      hint: t("cmd.view.present.hint"),
      icon: cmdIcons.Sparkles,
      group: t("group.view"),
      // Plan W2.17: the note as slides (headings and --- lines), from the slide at the cursor.
      action: async () => {
        const doc = liveDoc();
        const { presentNote, slideAtLine, cursorLine } = await import("../../slides/present");
        await presentNote(doc.content, doc.name, slideAtLine(doc.content, await cursorLine()));
      },
    },
    // Plan 4.19: offered once the Excalidraw canvas lands (src/canvas/engine.ts).
    ...(EXCALIDRAW_CANVAS_ENABLED
      ? [
          {
            id: "canvas.migrateToExcalidraw",
            label: t("cmd.canvas.migrate"),
            hint: t("cmd.canvas.migrate.hint"),
            icon: cmdIcons.Sparkles,
            group: t("group.view"),
            action: () => {
              void import("../../canvas/migrateCommand")
                .then((m) => m.runCanvasMigration())
                .catch((err: unknown) => log.error("canvas migration failed", err));
            },
          },
        ]
      : []),
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
