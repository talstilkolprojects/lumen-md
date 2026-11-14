/** Editing: formatting, suggesting mode and inserting blocks. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { useAppStore } from "../../store/useStore";
import { t } from "../../i18n";
import { BLOCK_SNIPPETS } from "../../snippets";
import { buildFormatCommands } from "../../editor/formatCommands";
import { buildSuggestingCommands } from "../../editor/suggestingCommands";
import { detectIsMac } from "../../lib/detectIsMac";
import type { CommandContext } from "./context";

/** Format (Prettier, lazy) and suggesting mode (track changes, CriticMarkup). */
export function buildEditCommands({ getEditorView, suggestingMode, toggleSuggestingMode }: CommandContext): Command[] {
  return [
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
      getContent: () => useAppStore.getState().doc.content,
      setContent: (s: string) => useAppStore.getState().setContent(s),
      suggesting: suggestingMode,
      toggle: toggleSuggestingMode,
    }).map((c) => ({ ...c, icon: cmdIcons.Pencil })),
  ];
}

/** Insert a block (chart, table, diagram, math, embed…). */
export function buildInsertCommands({ insertSnippet }: CommandContext): Command[] {
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
  ];
}
