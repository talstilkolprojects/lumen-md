import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "./useFocusTrap";
import {
  Search,
  FileText,
  FolderOpen,
  Save,
  Sun,
  Moon,
  Eye,
  Pencil,
  Columns2,
  Sparkles,
  BarChart3,
  Map,
  Network,
  Table,
  Calculator,
  Quote,
  Download,
  PanelRightOpen,
  Printer,
  Music2,
  Box,
  Workflow,
  Link,
  SquarePlay as Youtube,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { t } from "../i18n";
import { rankCommands } from "./paletteSearch";
import "./CommandPalette.css";
import { HelpButton } from "./HelpButton";
import { announceCommand } from "../research/usability/commandEvents";
import { countCommand } from "../metrics/count";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
  icon?: LucideIcon;
  group?: string;
  action: () => void;
  /**
   * The action deletes or replaces what the person made (plan W3.2): it
   * asks first ("confirm") or offers an undo ("undo").
   * scripts/check-destructive.mjs holds every command to it.
   */
  destructive?: "confirm" | "undo";
  /** Sub-commands — renders as expandable group in palette */
  children?: Command[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}

export function CommandPalette({ open, onClose, commands }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [tab, setTab] = useState<"main" | "advanced" | "all">("main");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  /** What had focus before the palette opened: it gets focus back on close (see the focus trap below). */
  const previousFocusRef = useRef<Element | null>(null);

  // Items the toolbar menus already expose. The palette de-duplicates those
  // away from the default browse list — when the user starts typing we still
  // search across them, so they remain discoverable. This keeps each action
  // reachable from exactly one visible surface (toolbar) plus the palette
  // search, instead of every command appearing in both.
  const TOOLBAR_DUPLICATE_IDS = new Set([
    "file.new",
    "file.open",
    "file.save",
    "file.saveAs",
    "file.exportHtml",
    "file.exportPdf",
    "file.print",
    "file.insertText",
    "edit.undo",
    "edit.redo",
    "edit.cut",
    "edit.copy",
    "edit.paste",
    "edit.selectAll",
    "edit.delete",
    "view.source",
    "view.split",
    "view.preview",
    "view.wysiwyg",
    "view.outline",
    "view.workspace",
    "view.pageView",
    "view.rtl",
    "view.theme",
    "view.scroll",
    "view.scrollSync",
    "help.focusMode",
    "help.shortcuts",
    "help.tour",
    "help.commandPalette",
  ]);

  const RECENT_GROUPS = new Set([t("group.recent"), "Recent", "recent"]);

  // The hand-curated "Essentials" — Main tab shows only these by default,
  // so the palette opens to a short list of the most-used flows. Everything
  // else is reachable via the Advanced tab or by typing a search query.
  const MAIN_ESSENTIAL_IDS = new Set([
    "view.search",          // Search workspace ⇧⌘F
    "view.smartSearch",     // Smart (semantic + BM25) search
    "view.findReplace",     // Find & Replace ⌘H
    "view.graphView",       // Knowledge Graph
    "view.versionHistory",  // Version History
    "view.canvas",          // Canvas / Whiteboard
    "view.plugins",         // Plugin Gallery
    "ai.settings",          // AI: Configure Connection
    "ai.localToggle",       // 🧠 Local AI (web-llm) on/off
    "tools.autoTag",        // 🏷️ Auto-tag this note
    "tools.suggestLinks",   // 🔗 Suggest wiki-links
    "tools.checkGrammar",   // 📝 Check grammar (LanguageTool)
    "voice.start",          // 🎙 Voice to Markdown
    "voice.dictate",
    "encrypt.document",     // 🔒 Encrypt Document
    "decrypt.document",     // 🔓 Decrypt Document
    "vault.encrypt",
    "vault.decrypt",
    "template.meetingNotes",
    "template.dailyJournal",
    "template.weeklyReview",
    "git.clone",
    "git.commitPush",
    "git.commit",
    "git.pull",
    "collab.start",
    "collab.stop",
    "collab.copy",
    "collab.leave",
  ]);

  function isToolbarDuplicate(c: Command): boolean {
    if (TOOLBAR_DUPLICATE_IDS.has(c.id)) return true;
    // AI prompts and Insert blocks are reachable from their own floating
    // buttons in the document — drop them from the default browse view, but
    // keep them searchable when the user types a query.
    if (c.id.startsWith("ai.prompt.")) return true;
    if (c.id.startsWith("insert.")) return true;
    return false;
  }

  function isMainEssential(c: Command): boolean {
    if (RECENT_GROUPS.has(c.group ?? "")) return true;
    if (MAIN_ESSENTIAL_IDS.has(c.id)) return true;
    return false;
  }

  // A fresh palette on every open, reset while rendering the open itself.
  // The palette stays mounted while closed, so this used to happen in the
  // effect below: the first frame of a reopened palette still showed the
  // last query, and when the effect ran late, its reset landed after
  // the user's (or a test's) first keystrokes and wiped them (plan 0.5:
  // the "Escape during palette typing" and "a version is kept" e2e flakes).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery("");
      setActive(0);
      setTab("main");
    }
  }

  // Focus the input in the same frame the palette appears, before paint:
  // the input is already in the DOM here (it renders with `open`). A
  // deferred focus (setTimeout 0) left a window in which keys typed right
  // after the palette became visible still went to the editor — Chromium
  // runs input events before pending timers — so a busy machine opened the
  // palette with an empty query and the typed command was never found.
  useLayoutEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement;
      inputRef.current?.focus();
    } else {
      // Clear on close too: the reset above runs only after the reopened
      // palette's first paint, which would show the last query for a frame
      // (and a test reading the input then sees it — the Escape e2e flake).
      setQuery("");
      setActive(0);
      // Restore focus to whatever opened the palette.
      const prev = previousFocusRef.current as HTMLElement | null;
      prev?.focus?.();
    }
  }, [open]);

  // Focus trap while open. Escape at document level closes it even when
  // focus drifted out of the input (e.g. after a child sub-menu expansion).
  // The layout effect above already moved focus to the input when the trap
  // starts, so the palette restores focus itself (to what opened it).
  useFocusTrap(dialogRef, { active: open, onEscape: onClose, restoreFocus: false });

  // Flatten commands with children for searching
  const flatAll = useMemo(() => {
    const out: Command[] = [];
    for (const cmd of commands) {
      out.push(cmd);
      if (cmd.children) out.push(...cmd.children);
    }
    return out;
  }, [commands]);

  const search = useMemo(() => rankCommands(flatAll, query), [flatAll, query]);
  // "/" lists the agent skills (plan W7.1), loaded only when typed.
  const [skillItems, setSkillItems] = useState<Command[]>([]);
  const slash = query.trimStart().startsWith("/");
  useEffect(() => {
    if (!slash) return;
    let live = true;
    void import("../agents/skills/ui")
      .then((m) => m.skillPaletteItems(query.trimStart()))
      .then((items) => {
        if (live) setSkillItems(items.map((it) => ({ ...it, group: t("skills.heading"), action: () => { onClose(); it.action(); } })));
      })
      .catch(() => live && setSkillItems([]));
    return () => {
      live = false;
    };
  }, [slash, query, onClose]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.startsWith("/")) return skillItems;

    // If searching, search across ALL commands (including children), ranked —
    // and in the other keyboard layout too (plan W2.8).
    if (q) return search.items;

    // Otherwise filter top-level by tab. The palette deliberately suppresses
    // commands that already live in the toolbar (File / Edit / View / Help)
    // so the default browse list highlights the *additional* power-user
    // actions (insert blocks, AI templates, Git, plugins, recents). Searching
    // re-enables the full list above.
    let list = commands.filter((c) => !isToolbarDuplicate(c));
    if (tab === "main") {
      // Default browse: a tight curated list of the truly central flows
      // (search, knowledge graph, history, encryption, voice, key templates,
      // git/collab) plus recent files. Everything else is one tab away.
      list = list.filter(isMainEssential);
    } else if (tab === "advanced") {
      list = list.filter((c) => !isMainEssential(c));
    }

    // Expand children of expanded parents
    const out: Command[] = [];
    for (const cmd of list) {
      out.push(cmd);
      if (cmd.children && expanded.has(cmd.id)) {
        out.push(...cmd.children);
      }
    }
    return out;
  }, [query, commands, search, tab, expanded, skillItems]);

  useEffect(() => {
    if (active >= filtered.length) setActive(0);
  }, [filtered, active]);

  // Auto-scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-cmd-index="${active}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[active];
      if (cmd) {
        // If the command has children, expand/collapse instead of executing
        if (cmd.children) {
          setExpanded((prev) => {
            const next = new Set(prev);
            next.has(cmd.id) ? next.delete(cmd.id) : next.add(cmd.id);
            return next;
          });
          return;
        }
        onClose();
        // Defer slightly so the palette unmounts before the action (e.g. file dialog) runs.
        setTimeout(() => {
          announceCommand(cmd.id);
          void cmd.action();
        }, 0);
        countCommand(cmd.id);
      }
    } else if (e.key === "Backspace" && !query) {
      // When query is empty, Backspace collapses the last expanded sub-menu
      if (expanded.size > 0) {
        e.preventDefault();
        setExpanded((prev) => {
          const next = new Set(prev);
          const last = [...next].pop();
          if (last) next.delete(last);
          return next;
        });
      }
    }
  }

  if (!open) return null;

  const TABS: { key: "main" | "advanced" | "all"; label: string; emoji: string }[] = [
    { key: "main", label: "Main", emoji: "📁" },
    { key: "advanced", label: "Advanced", emoji: "⚡" },
    { key: "all", label: "All", emoji: "🔍" },
  ];

  return (
    <div
      className="cmd-palette-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("palette.placeholder")}
    >
      <div
        ref={dialogRef}
        className="cmd-palette"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cmd-palette-search">
          <Search size={16} style={{ opacity: 0.6, flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder={t("palette.placeholder")}
            aria-label={t("palette.placeholder")}
            aria-autocomplete="list"
            aria-controls="cmd-listbox"
            aria-activedescendant={filtered.length > 0 ? `cmd-item-${active}` : undefined}
            spellCheck={false}
          />
          <HelpButton topic="getting-started/shortcuts#anywhere-in-the-app" />
        </div>

        {/* ─── Category Tabs ─── */}
        {!query.trim() && (
          <div style={{
            display: "flex",
            gap: 2,
            padding: "4px 8px",
            borderBottom: "1px solid hsl(var(--border))",
          }}>
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => { setTab(t.key); setActive(0); }}
                style={{
                  flex: 1,
                  padding: "5px 8px",
                  borderRadius: 6,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: tab === t.key ? 600 : 400,
                  background: tab === t.key ? "hsl(var(--accent) / 0.15)" : "transparent",
                  color: tab === t.key ? "hsl(var(--accent))" : "hsl(var(--fg-muted))",
                }}
              >
                {t.emoji} {t.label}
              </button>
            ))}
          </div>
        )}

        {query.trim() && search.variant && (
          <div className="cmd-palette-empty" role="status" data-testid="palette-layout-hint" dir="auto" style={{ padding: "6px 14px", textAlign: "start" }}>
            {t("palette.layoutHint", { text: search.variant })}
          </div>
        )}
        <div
          className="cmd-palette-list"
          ref={listRef}
          id="cmd-listbox"
          role="listbox"
          // Reachable by Tab so it can be scrolled by keyboard (axe: scrollable-region-focusable).
          tabIndex={0}
          aria-label={t("palette.placeholder")}
        >
          {filtered.length === 0 && (
            <div className="cmd-palette-empty">{t("palette.noMatch")}</div>
          )}
          {(() => {
            let lastGroup = "";
            return filtered.map((cmd, i) => {
              const Icon = cmd.icon ?? Sparkles;
              const showHeader = cmd.group && cmd.group !== lastGroup;
              if (cmd.group) lastGroup = cmd.group;
              return (
                <React.Fragment key={cmd.id}>
                  {showHeader && (
                    <div
                      style={{
                        padding: "8px 14px 4px",
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        color: "hsl(var(--fg-muted))",
                        borderTop: i > 0 ? "1px solid hsl(var(--border) / 0.4)" : "none",
                        marginTop: i > 0 ? 4 : 0,
                        userSelect: "none",
                      }}
                    >
                      {cmd.group}
                    </div>
                  )}
                  <div
                    id={`cmd-item-${i}`}
                    data-cmd-index={i}
                    className={`cmd-palette-item ${i === active ? "active" : ""}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => {
                      if (cmd.children) {
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          next.has(cmd.id) ? next.delete(cmd.id) : next.add(cmd.id);
                          return next;
                        });
                        return;
                      }
                      onClose();
                      setTimeout(() => {
                        announceCommand(cmd.id);
                        void cmd.action();
                      }, 0);
                      countCommand(cmd.id);
                    }}
                  >
                    <Icon size={15} style={{ opacity: 0.75, flexShrink: 0 }} />
                    <span className="cmd-palette-label">{cmd.label}</span>
                    {cmd.hint && (
                      <span className="cmd-palette-hint">{cmd.hint}</span>
                    )}
                    {cmd.shortcut && (
                      <span className="cmd-palette-shortcut">{cmd.shortcut}</span>
                    )}
                    {cmd.children && (
                      <span style={{ fontSize: 10, opacity: 0.5, marginInlineStart: 4 }}>
                        {expanded.has(cmd.id) ? "▼" : "▶"}
                      </span>
                    )}
                  </div>
                </React.Fragment>
              );
            });
          })()}
        </div>
        <div className="cmd-palette-footer">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> {t("palette.navigate")}
          </span>
          <span>
            <kbd>↵</kbd> {t("palette.select")}
          </span>
          <span>
            <kbd>Esc</kbd> {t("palette.close")}
          </span>
        </div>
      </div>
    </div>
  );
}

// Icons re-exported so App.tsx can build a command list without re-importing
export const cmdIcons = {
  FileText,
  FolderOpen,
  Save,
  Sun,
  Moon,
  Eye,
  Pencil,
  Columns2,
  Sparkles,
  BarChart3,
  Map,
  Network,
  Table,
  Calculator,
  Quote,
  Download,
  PanelRightOpen,
  Printer,
  Music2,
  Box,
  Workflow,
  Link,
  Youtube,
};
