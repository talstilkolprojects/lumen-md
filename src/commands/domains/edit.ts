/** Editing: formatting, suggesting mode and inserting blocks. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { useAppStore } from "../../store/useStore";
import { t } from "../../i18n";
import { BLOCK_SNIPPETS } from "../../snippets";
import { buildFormatCommands } from "../../editor/formatCommands";
import { buildSuggestingCommands } from "../../editor/suggestingCommands";
import { buildBidiMarksCommands } from "../../editor/bidiMarksCommands";
import { detectIsMac } from "../../lib/detectIsMac";
import { showAiToast } from "../../ui/AiToast";
import type { CommandContext } from "./context";

/** Block links, format (Prettier, lazy) and suggesting mode (track changes, CriticMarkup). */
export function buildEditCommands({ getEditorView, suggestingMode, toggleSuggestingMode }: CommandContext): Command[] {
  return [
    // ── Block references (4.8) ─────────────────────────────────────────
    {
      id: "editor.copyBlockLink",
      label: t("cmd.copyBlockLink"),
      hint: t("cmd.copyBlockLink.hint"),
      icon: cmdIcons.Link,
      group: t("group.insert"),
      action: async () => {
        const view = getEditorView?.() ?? null;
        if (!view) return showAiToast(t("blockLink.sourceOnly"), "info");
        const { copyBlockLink } = await import("../../editor/blockLink");
        try {
          const link = await copyBlockLink(view);
          showAiToast(link ? t("blockLink.copied", { link }) : t("blockLink.noBlock"), link ? "success" : "info");
        } catch {
          showAiToast(t("blockLink.copyFailed"), "error");
        }
      },
    },
    ...buildFormatCommands(
      {
        getView: () => getEditorView?.() ?? null,
        getContent: () => useAppStore.getState().doc.content,
        setContent: (s: string) => useAppStore.getState().setContent(s),
      },
      detectIsMac(),
    ).map((c) => ({ ...c, icon: cmdIcons.Pencil })),
    // ── Suggesting mode (track changes, CriticMarkup) ─────────────────
    ...buildSuggestingCommands({
      getView: () => getEditorView?.() ?? null,
      getContent: () => getEditorView?.()?.state.doc.toString() ?? useAppStore.getState().doc.content,
      setContent: (s: string) => useAppStore.getState().setContent(s),
      suggesting: suggestingMode,
      toggle: toggleSuggestingMode,
    }).map((c) => ({ ...c, icon: cmdIcons.Pencil })),
    // ── Direction controls (W5.4) ─────────────────────────────────────
    ...buildBidiMarksCommands({
      getView: () => getEditorView?.() ?? null,
      getContent: () => useAppStore.getState().doc.content,
      setContent: (s: string) => useAppStore.getState().setContent(s),
    }).map((c) => ({ ...c, icon: cmdIcons.Pencil })),
    // ── Hebrew typography (plan W2.9, dialog loaded on use) ─────────────
    {
      id: "edit.hebrewTypography",
      label: t("cmd.edit.hebrewTypography"),
      hint: t("cmd.edit.hebrewTypography.hint"),
      icon: cmdIcons.Pencil,
      group: t("group.edit"),
      action: async () => {
        const { openTypographyDialog } = await import("../../ui/TypographyDialog");
        openTypographyDialog({
          getView: () => getEditorView?.() ?? null,
          getContent: () => useAppStore.getState().doc.content,
          setContent: (s: string) => useAppStore.getState().setContent(s),
        });
      },
    },
    // ── Outline mode and block operations (plan W2.13) ────────────────
    // Both editors listen for `lumen-outline`; the code is in their lazy chunks.
    ...(() => {
      const mac = detectIsMac();
      const alt = mac ? "⌥" : "Alt+";
      const mod = mac ? "⌘⌥" : "Ctrl+Alt+";
      const shift = mac ? "⇧" : "Shift+";
      const keys: Record<string, string> = {
        moveUp: `${alt}${shift}↑`,
        moveDown: `${alt}${shift}↓`,
        indent: `${mod}→`,
        outdent: `${mod}←`,
        duplicate: `${alt}${shift}D`,
        delete: `${alt}${shift}⌫`,
        fold: `${mod}↑`,
        unfold: `${mod}↓`,
        zoomIn: `${mod}↵`,
      };
      const ids = ["moveUp", "moveDown", "indent", "outdent", "duplicate", "delete", "fold", "unfold", "foldAll", "unfoldAll", "zoomIn", "zoomOut", "toggleMode"] as const;
      return ids.map((cmd) => ({
        id: `outline.${cmd}`,
        label: t(`cmd.outline.${cmd}`),
        hint: cmd === "toggleMode" ? t("cmd.outline.toggleMode.hint") : undefined,
        shortcut: keys[cmd],
        icon: cmdIcons.Pencil,
        group: t("group.edit"),
        action: () => window.dispatchEvent(new CustomEvent("lumen-outline", { detail: { cmd } })),
      }));
    })(),
    // W1.4 — paste from Word, Google Docs and websites, as text or as Markdown (loaded on use).
    ...(["plain", "formatted"] as const).map((mode) => ({
      id: mode === "plain" ? "edit.pastePlain" : "edit.pasteFormatted",
      label: t(mode === "plain" ? "cmd.edit.pastePlain" : "cmd.edit.pasteFormatted"),
      hint: t(mode === "plain" ? "cmd.edit.pastePlain.hint" : "cmd.edit.pasteFormatted.hint"),
      icon: cmdIcons.Pencil,
      group: t("group.edit"),
      action: () =>
        void Promise.all([import("../../paste/pasteCommands"), import("../../store/useToastStore")]).then(async ([{ runPaste }, { useToastStore }]) => {
          const msg = await runPaste(mode);
          if (msg) useToastStore.getState().push({ kind: "warning", title: msg });
        }),
    })),
    // W5.5 — Hebrew copied from a PDF, reversed or with broken final letters (loaded on use).
    {
      id: "edit.fixPdfHebrew",
      label: t("cmd.edit.fixPdfHebrew"),
      hint: t("cmd.edit.fixPdfHebrew.hint"),
      icon: cmdIcons.Pencil,
      group: t("group.edit"),
      action: () => void import("../../paste/pdfPaste").then((m) => m.runFixPdfHebrew()),
    },
  ];
}

/** Insert a block (chart, table, diagram, math, embed…). */
export function buildInsertCommands({ insertSnippet, getEditorView }: CommandContext): Command[] {
  return [
    {
      id: "insert.chart",
      label: t("cmd.insert.chart"),
      hint: t("cmd.insert.chart.hint"),
      icon: cmdIcons.BarChart3,
      group: t("group.insert"),
      action: () => insertSnippet(BLOCK_SNIPPETS.chart),
    },
    {
      id: "insert.csv",
      label: t("cmd.insert.csv"),
      hint: t("cmd.insert.csv.hint"),
      icon: cmdIcons.Table,
      group: t("group.insert"),
      action: () => insertSnippet(BLOCK_SNIPPETS.csv),
    },
    {
      id: "insert.json",
      label: t("cmd.insert.json"),
      hint: t("cmd.insert.csv.hint"),
      icon: cmdIcons.Table,
      group: t("group.insert"),
      action: () => insertSnippet(BLOCK_SNIPPETS.jsonTable),
    },
    {
      id: "insert.mermaid",
      label: t("cmd.insert.mermaid"),
      icon: cmdIcons.Network,
      group: t("group.insert"),
      action: () => insertSnippet(BLOCK_SNIPPETS.mermaid),
    },
    {
      id: "insert.map",
      label: t("cmd.insert.map"),
      icon: cmdIcons.Map,
      group: t("group.insert"),
      action: () => insertSnippet(BLOCK_SNIPPETS.map),
    },
    {
      id: "insert.math",
      label: t("cmd.insert.math"),
      icon: cmdIcons.Calculator,
      group: t("group.insert"),
      action: () => insertSnippet(BLOCK_SNIPPETS.math),
    },
    {
      // W11.H4 — switch the paragraph's direction, saved in the note as an invisible RLM / LRM.
      id: "edit.toggleDirection",
      label: t("cmd.edit.toggleDirection"),
      hint: t("cmd.edit.toggleDirection.hint"),
      shortcut: "⇧⌘X",
      icon: cmdIcons.Pencil,
      group: t("group.edit"),
      action: () => {
        const view = getEditorView?.();
        if (!view) {
          window.dispatchEvent(new CustomEvent("lumen-toggle-direction"));
          return;
        }
        void import("../../editor/paragraphDirection").then((m) => {
          m.toggleParagraphDirection(view);
          view.focus();
        });
      },
    },
    {
      // W5.14 — a formula inside the sentence; Ctrl/⌘+M in the source editor.
      id: "insert.inlineMath",
      label: t("cmd.insert.inlineMath"),
      hint: t("cmd.insert.inlineMath.hint"),
      icon: cmdIcons.Calculator,
      group: t("group.insert"),
      action: () => {
        const view = getEditorView?.();
        if (!view) return insertSnippet("$x$");
        void import("../../editor/mathBidi").then((m) => {
          m.insertInlineMath(view);
          view.focus();
        });
      },
    },
    {
      id: "insert.callout",
      label: t("cmd.insert.callout"),
      hint: t("cmd.insert.callout.hint"),
      icon: cmdIcons.Quote,
      group: t("group.insert"),
      action: () => insertSnippet(BLOCK_SNIPPETS.note),
    },
    {
      id: "insert.graphviz",
      label: t("cmd.insert.graphviz"),
      icon: cmdIcons.Workflow,
      group: t("group.insert"),
      action: () => insertSnippet(BLOCK_SNIPPETS.graphviz),
    },
    {
      id: "insert.plantuml",
      label: t("cmd.insert.plantuml"),
      hint: t("cmd.insert.plantuml.hint"),
      icon: cmdIcons.Workflow,
      group: t("group.insert"),
      action: () => insertSnippet(BLOCK_SNIPPETS.plantuml),
    },
    {
      id: "insert.abc",
      label: t("cmd.insert.abc"),
      icon: cmdIcons.Music2,
      group: t("group.insert"),
      action: () => insertSnippet(BLOCK_SNIPPETS.abc),
    },
    {
      id: "insert.model",
      label: t("cmd.insert.model"),
      hint: t("cmd.insert.model.hint"),
      icon: cmdIcons.Box,
      group: t("group.insert"),
      action: () => insertSnippet(BLOCK_SNIPPETS.model),
    },
    {
      id: "insert.embed",
      label: t("cmd.insert.embed"),
      hint: t("cmd.insert.embed.hint"),
      icon: cmdIcons.Youtube,
      group: t("group.insert"),
      action: () => insertSnippet(BLOCK_SNIPPETS.embed),
    },
    {
      id: "insert.htmlpreview",
      label: t("cmd.insert.htmlpreview"),
      hint: t("cmd.insert.htmlpreview.hint"),
      icon: cmdIcons.Box,
      group: t("group.insert"),
      action: () => insertSnippet(BLOCK_SNIPPETS.htmlpreview),
    },
    {
      id: "insert.bibtex",
      label: t("cmd.insert.bibtex"),
      hint: t("cmd.insert.bibtex.hint"),
      icon: cmdIcons.Quote,
      group: t("group.insert"),
      action: () => insertSnippet(BLOCK_SNIPPETS.bibtex),
    },
    {
      id: "insert.wikilink",
      label: t("cmd.insert.wikilink"),
      hint: "[[Page|label]]",
      icon: cmdIcons.Link,
      group: t("group.insert"),
      action: () => insertSnippet(BLOCK_SNIPPETS.wikilink),
    },
    // ── Handwriting (W5.27): pen / Apple Pencil ink saved as SVG in the note ──
    {
      id: "insert.ink",
      label: t("cmd.insert.ink"),
      hint: t("cmd.insert.ink.hint"),
      icon: cmdIcons.Pencil,
      group: t("group.insert"),
      action: async () => {
        const { drawOrEditInk } = await import("../../ink/inkCommand");
        await drawOrEditInk({
          getView: () => getEditorView?.() ?? null,
          getContent: () => useAppStore.getState().doc.content,
          setContent: (s: string) => useAppStore.getState().setContent(s),
        });
      },
    },
  ];
}
