import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import {
  FileText,
  FolderOpen,
  Save,
  Sun,
  Moon,
  PanelRightOpen,
  PanelRightClose,
  Columns2,
  Eye,
  Pencil,
  Sparkles,
  Type,
  Copy,
  Scissors,
  Trash2,
  CheckSquare,
  Undo2,
  Redo2,
  Download,
  Printer,
  Plus,
  Keyboard,
  Maximize2,
  Command as CommandIcon,
  ChevronRight,
  BarChart3,
  Workflow,
  Image as ImageIcon,
  BookOpen,
} from "lucide-react";
import { useAppStore } from "../store/useStore";
import type { ViewMode } from "../store/useStore";
import { t } from "../i18n";
import type { Command } from "./CommandPalette";
import { AuthButton } from "../components/AuthButton";

interface Props {
  onOpen: () => void;
  onSave: (saveAs?: boolean) => void;
  onNew: () => void;
  onCommandPalette: () => void;
  onInsertText?: () => void;
  onPasteText?: () => void;
  onFocusMode?: () => void;
  onShortcuts?: () => void;
  onTour?: () => void;
  /** Restore the bundled Welcome.md tour document. Surfaced at the bottom
   *  of the File menu so first-timers can find it again. */
  onShowWelcome?: () => void;
  commands?: Command[];
}

const MODES: {
  value: ViewMode;
  icon: typeof Pencil;
  labelKey: string;
  descKey: string;
  shortcut: string;
}[] = [
  { value: "source", icon: Pencil, labelKey: "mode.source", descKey: "desc.viewSource", shortcut: "⌘1" },
  { value: "split", icon: Columns2, labelKey: "mode.split", descKey: "desc.viewSplit", shortcut: "⌘2" },
  { value: "preview", icon: Eye, labelKey: "mode.preview", descKey: "desc.viewPreview", shortcut: "⌘3" },
  { value: "wysiwyg", icon: Sparkles, labelKey: "mode.wysiwyg", descKey: "desc.viewWysiwyg", shortcut: "⌘4" },
];

// Subcategories used to group Insert commands. Order here determines render order.
const INSERT_GROUPS: {
  id: string;
  sectionKey: string;
  Icon: typeof BarChart3;
  matches: (id: string) => boolean;
}[] = [
  {
    id: "tablesCharts",
    sectionKey: "toolbar.section.tablesCharts",
    Icon: BarChart3,
    matches: (id) => /insert\.(table|chart|csv|json|tsv|datatable)/i.test(id),
  },
  {
    id: "diagrams",
    sectionKey: "toolbar.section.diagrams",
    Icon: Workflow,
    matches: (id) => /insert\.(mermaid|graphviz|dot|plantuml|puml)/i.test(id),
  },
  {
    id: "media",
    sectionKey: "toolbar.section.media",
    Icon: ImageIcon,
    matches: (id) => /insert\.(map|geojson|abc|music|model|3d|embed|html(?:preview)?)/i.test(id),
  },
  {
    id: "mathRefs",
    sectionKey: "toolbar.section.mathRefs",
    Icon: BookOpen,
    matches: (id) => /insert\.(math|callout|admonition|bibtex|wiki|reference)/i.test(id),
  },
];

export function Toolbar({
  onOpen,
  onSave,
  onNew,
  onCommandPalette,
  onInsertText,
  onPasteText,
  onFocusMode,
  onShortcuts,
  onShowWelcome,
  onTour,
  commands = [],
}: Props) {
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
  const setTheme = useAppStore((s) => s.setTheme);
  const showOutline = useAppStore((s) => s.showOutline);
  const toggleOutline = useAppStore((s) => s.toggleOutline);
  const showWorkspace = useAppStore((s) => s.showWorkspace);
  const toggleWorkspace = useAppStore((s) => s.toggleWorkspace);
  const doc = useAppStore((s) => s.doc);
  const rtl = useAppStore((s) => s.rtl);
  const toggleRtl = useAppStore((s) => s.toggleRtl);
  const syncScroll = useAppStore((s) => s.syncScroll);
  const toggleSyncScroll = useAppStore((s) => s.toggleSyncScroll);
  const splitAxis = useAppStore((s) => s.splitAxis);
  const setSplitAxis = useAppStore((s) => s.setSplitAxis);
  const pageView = useAppStore((s) => s.pageView);
  const togglePageView = useAppStore((s) => s.togglePageView);
  const theme = useAppStore((s) => s.theme);
  const isDark = theme === "dark";

  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuBarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openMenu) return;
    function close(e: MouseEvent) {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    }
    // Escape closes an open menu, as every menu does; the e2e that
    // "checked" this used to wait 150 ms and look at nothing.
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpenMenu(null);
      }
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  function exec(fn: () => void) {
    setOpenMenu(null);
    fn();
  }

  // Insert commands grouped into subcategories.
  const insertCommands = commands.filter((c) => c.id.startsWith("insert."));
  const insertGroups = INSERT_GROUPS.map((g) => ({
    ...g,
    items: insertCommands.filter((c) => g.matches(c.id)),
  })).filter((g) => g.items.length > 0);
  const ungroupedInsert = insertCommands.filter(
    (c) => !INSERT_GROUPS.some((g) => g.matches(c.id)),
  );

  // Export/print commands resolved from the central command list.
  const exportHtmlCmd = commands.find((c) => c.id === "file.exportHtml");
  const exportPdfCmd = commands.find((c) => c.id === "file.exportPdf");
  const exportPptxCmd = commands.find((c) => c.id === "file.exportPptx");
  const printCmd = commands.find((c) => c.id === "file.print");

  return (
    <header className="titlebar">
      {/* ─── Logo: opens the command palette ─── */}
      <button
        onClick={onCommandPalette}
        title={`${t("toolbar.commandPalette")} (⌘K) — ${t("desc.commandPalette")}`}
        aria-label={t("toolbar.commandPalette")}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 2,
          padding: "4px 10px",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <div
          aria-hidden
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            background: "var(--gradient-brand)",
            color: "white",
            fontWeight: 700,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "var(--shadow-accent)",
          }}
        >
          L
        </div>
        <span style={{ fontSize: 9, fontWeight: 600, color: "hsl(var(--fg-muted))", lineHeight: 1 }}>
          {t("toolbar.menu")}
        </span>
      </button>

      <div style={{ width: 1, height: 20, background: "hsl(var(--border))", margin: "0 2px", flexShrink: 0 }} />

      {/* ─── Menu Bar ─── */}
      <div ref={menuBarRef} style={{ display: "flex", gap: 0, alignItems: "center" }}>
        {/* ─── File ─── */}
        <MenuBarItem
          label={t("toolbar.fileMenu")}
          tooltip={t("toolbar.menuTooltip.file")}
          isOpen={openMenu === "file"}
          onToggle={() => setOpenMenu(openMenu === "file" ? null : "file")}
          onHover={() => openMenu && setOpenMenu("file")}
        >
          <MenuSection label={t("toolbar.section.documents")} />
          <MenuItem icon={<FileText size={14} />} label={t("toolbar.new")} description={t("desc.new")} hint="⌘N" onClick={() => exec(onNew)} />
          <MenuItem icon={<FolderOpen size={14} />} label={t("toolbar.open")} description={t("desc.open")} hint="⌘O" onClick={() => exec(onOpen)} />
          <MenuItem icon={<Save size={14} />} label={t("toolbar.save")} description={t("desc.save")} hint="⌘S" onClick={() => exec(() => onSave(false))} />
          <MenuItem icon={<Save size={14} />} label={t("toolbar.saveAs")} description={t("desc.saveAs")} hint="⇧⌘S" onClick={() => exec(() => onSave(true))} />
          <MenuDivider />
          <MenuSection label={t("toolbar.section.export")} />
          {exportHtmlCmd && (
            <MenuItem icon={<Download size={14} />} label={t("toolbar.exportHtml")} description={t("desc.exportHtml")} onClick={() => exec(exportHtmlCmd.action)} />
          )}
          {exportPdfCmd && (
            <MenuItem icon={<Download size={14} />} label={t("toolbar.exportPdf")} description={t("desc.exportPdf")} onClick={() => exec(exportPdfCmd.action)} />
          )}
          {exportPptxCmd && (
            <MenuItem icon={<Download size={14} />} label={exportPptxCmd.label} description={exportPptxCmd.hint} onClick={() => exec(exportPptxCmd.action)} />
          )}
          {printCmd && (
            <MenuItem icon={<Printer size={14} />} label={t("toolbar.print")} description={t("desc.print")} hint="⌘P" onClick={() => exec(printCmd.action)} />
          )}
          <MenuDivider />
          <MenuSection label={t("toolbar.section.workspace")} />
          <MenuItem
            icon={<FolderOpen size={14} />}
            label={t("toolbar.workspace")}
            description={t("desc.workspace")}
            active={showWorkspace}
            onClick={() => exec(toggleWorkspace)}
          />
          {onShowWelcome && (
            <>
              <MenuDivider />
              <MenuItem
                icon={<Sparkles size={14} />}
                label={t("toolbar.openWelcome")}
                description={t("desc.openWelcome")}
                onClick={() => exec(onShowWelcome)}
              />
            </>
          )}
        </MenuBarItem>

        {/* ─── Edit ─── */}
        <MenuBarItem
          label={t("toolbar.editMenu")}
          tooltip={t("toolbar.menuTooltip.edit")}
          isOpen={openMenu === "edit"}
          onToggle={() => setOpenMenu(openMenu === "edit" ? null : "edit")}
          onHover={() => openMenu && setOpenMenu("edit")}
        >
          <MenuSection label={t("toolbar.section.history")} />
          <MenuItem icon={<Undo2 size={14} />} label={t("toolbar.undo")} description={t("desc.undo")} hint="⌘Z" onClick={() => exec(() => document.execCommand("undo"))} />
          <MenuItem icon={<Redo2 size={14} />} label={t("toolbar.redo")} description={t("desc.redo")} hint="⇧⌘Z" onClick={() => exec(() => document.execCommand("redo"))} />
          <MenuDivider />
          <MenuSection label={t("toolbar.section.clipboard")} />
          <MenuItem icon={<Scissors size={14} />} label={t("toolbar.cut")} description={t("desc.cut")} hint="⌘X" onClick={() => exec(() => document.execCommand("cut"))} />
          <MenuItem icon={<Copy size={14} />} label={t("toolbar.copy")} description={t("desc.copy")} hint="⌘C" onClick={() => exec(() => document.execCommand("copy"))} />
          {onPasteText && (
            <MenuItem icon={<Type size={14} />} label={t("toolbar.paste")} description={t("desc.paste")} onClick={() => exec(onPasteText)} />
          )}
          <MenuDivider />
          <MenuSection label={t("toolbar.section.selection")} />
          <MenuItem icon={<CheckSquare size={14} />} label={t("toolbar.selectAll")} description={t("desc.selectAll")} hint="⌘A" onClick={() => exec(() => document.execCommand("selectAll"))} />
          <MenuItem icon={<Trash2 size={14} />} label={t("toolbar.delete")} description={t("desc.delete")} onClick={() => exec(() => document.execCommand("delete"))} />
        </MenuBarItem>

        {/* ─── Insert ─────────────────────────────────────────────────
            The Smart Insert pane (📝 Insert anything…) is the headline
            entry — it auto-detects URL embeds, CSV, JSON, SQL, Mermaid,
            GeoJSON, math, code, etc. The categorical sub-menus below
            stay for users who prefer to browse by block type. */}
        <MenuBarItem
          label={t("toolbar.insertMenu")}
          tooltip={t("toolbar.menuTooltip.insert")}
          isOpen={openMenu === "insert"}
          onToggle={() => setOpenMenu(openMenu === "insert" ? null : "insert")}
          onHover={() => openMenu && setOpenMenu("insert")}
        >
          {onInsertText && (
            <>
              <MenuItem
                icon={<Sparkles size={14} />}
                label={t("toolbar.insertSmart")}
                description={t("desc.insertSmart")}
                hint="⌘⇧V"
                onClick={() => exec(onInsertText)}
              />
              <MenuDivider />
              <MenuSection label={t("toolbar.section.specific")} />
            </>
          )}
          {insertGroups.length === 0 && ungroupedInsert.length === 0 ? (
            <div style={{ padding: "8px 12px", fontSize: 12, color: "hsl(var(--fg-muted))" }}>
              {t("toolbar.insertMenu")}
            </div>
          ) : (
            <>
              {insertGroups.map((g) => (
                <SubMenuItem
                  key={g.id}
                  icon={<g.Icon size={14} />}
                  label={t(g.sectionKey)}
                  description={`${g.items.length}`}
                >
                  {g.items.map((cmd) => {
                    const Icon = cmd.icon;
                    return (
                      <MenuItem
                        key={cmd.id}
                        icon={Icon ? <Icon size={14} /> : <Plus size={14} />}
                        label={cmd.label}
                        description={cmd.hint}
                        onClick={() => exec(cmd.action)}
                      />
                    );
                  })}
                </SubMenuItem>
              ))}
              {ungroupedInsert.length > 0 && (
                <>
                  <MenuDivider />
                  <MenuSection label={t("toolbar.section.tools")} />
                  {ungroupedInsert.map((cmd) => {
                    const Icon = cmd.icon;
                    return (
                      <MenuItem
                        key={cmd.id}
                        icon={Icon ? <Icon size={14} /> : <Plus size={14} />}
                        label={cmd.label}
                        description={cmd.hint}
                        onClick={() => exec(cmd.action)}
                      />
                    );
                  })}
                </>
              )}
            </>
          )}
        </MenuBarItem>

        {/* ─── View ─── */}
        <MenuBarItem
          label={t("toolbar.viewMode")}
          tooltip={t("toolbar.menuTooltip.view")}
          isOpen={openMenu === "view"}
          onToggle={() => setOpenMenu(openMenu === "view" ? null : "view")}
          onHover={() => openMenu && setOpenMenu("view")}
        >
          <MenuSection label={t("toolbar.viewMode")} />
          {MODES.map((m) => (
            <MenuItem
              key={m.value}
              icon={<m.icon size={14} />}
              label={t(m.labelKey)}
              description={t(m.descKey)}
              hint={m.shortcut}
              active={mode === m.value}
              onClick={() => exec(() => setMode(m.value))}
            />
          ))}
          <MenuDivider />
          <MenuSection label={t("toolbar.appearance")} />
          <MenuItem
            icon={isDark ? <Sun size={14} /> : <Moon size={14} />}
            label={isDark ? t("toolbar.lightMode") : t("toolbar.darkMode")}
            description={isDark ? t("desc.lightMode") : t("desc.darkMode")}
            onClick={() => exec(() => setTheme(isDark ? "light" : "dark"))}
          />
          <MenuItem
            icon={<Type size={14} />}
            label={rtl ? t("toolbar.ltr") : t("toolbar.rtl")}
            description={t("desc.toggleRtl")}
            onClick={() => exec(toggleRtl)}
          />
          <MenuDivider />
          <MenuSection label={t("toolbar.panels")} />
          <MenuItem
            icon={showOutline ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
            label={showOutline ? t("toolbar.outline.hide") : t("toolbar.outline.show")}
            description={t("desc.outline")}
            onClick={() => exec(toggleOutline)}
          />
          <MenuItem
            icon={<Columns2 size={14} />}
            label={syncScroll === "all" ? t("toolbar.scrollLinked") : t("toolbar.scrollIndependent")}
            description={t("desc.syncScroll")}
            onClick={() => exec(toggleSyncScroll)}
          />
          <MenuSection label={t("toolbar.splitAxis")} />
          <MenuItem
            icon={<Columns2 size={14} />}
            label={t("toolbar.splitAxis.auto")}
            description={t("desc.splitAxis.auto")}
            active={splitAxis === "auto"}
            onClick={() => exec(() => setSplitAxis("auto"))}
          />
          <MenuItem
            icon={<Columns2 size={14} />}
            label={t("toolbar.splitAxis.horizontal")}
            description={t("desc.splitAxis.horizontal")}
            active={splitAxis === "horizontal"}
            onClick={() => exec(() => setSplitAxis("horizontal"))}
          />
          <MenuItem
            icon={<Columns2 size={14} style={{ transform: "rotate(90deg)" }} />}
            label={t("toolbar.splitAxis.vertical")}
            description={t("desc.splitAxis.vertical")}
            active={splitAxis === "vertical"}
            onClick={() => exec(() => setSplitAxis("vertical"))}
          />
          <MenuDivider />
          <MenuItem
            icon={<Eye size={14} />}
            label={pageView ? t("toolbar.pageView.on") : t("toolbar.pageView.off")}
            description={t("desc.pageView")}
            onClick={() => exec(togglePageView)}
          />
        </MenuBarItem>

        {/* ─── Help ─── */}
        <MenuBarItem
          label={t("toolbar.helpMenu")}
          tooltip={t("toolbar.menuTooltip.help")}
          isOpen={openMenu === "help"}
          onToggle={() => setOpenMenu(openMenu === "help" ? null : "help")}
          onHover={() => openMenu && setOpenMenu("help")}
        >
          <MenuItem
            icon={<Maximize2 size={14} />}
            label={t("toolbar.focusMode")}
            description={t("desc.focusMode")}
            hint="⇧⌘F"
            onClick={() => exec(() => onFocusMode?.())}
          />
          <MenuItem
            icon={<Keyboard size={14} />}
            label={t("toolbar.shortcuts")}
            description={t("desc.shortcuts")}
            hint="⌘/"
            onClick={() => exec(() => onShortcuts?.())}
          />
          <MenuItem
            icon={<Eye size={14} />}
            label={t("toolbar.tour")}
            description={t("desc.tour")}
            onClick={() => exec(() => onTour?.())}
          />
          <MenuDivider />
          <MenuItem
            icon={<CommandIcon size={14} />}
            label={t("toolbar.commandPalette")}
            description={t("desc.commandPalette")}
            hint="⌘K"
            onClick={() => exec(onCommandPalette)}
          />
        </MenuBarItem>
      </div>

      {/* ─── Center: file name ─── */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            color: "hsl(var(--fg-muted))",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 360,
          }}
          title={doc.name}
        >
          {doc.name}
          {doc.dirty && <span style={{ color: "hsl(var(--accent))", marginInlineStart: 4 }}>•</span>}
        </div>
      </div>

      {/* ─── Right: account / sign-in ─── */}
      <AuthButton />

      {/* The Logo on the
          left already opens the command palette, and the same action lives
          under Help → Command palette. Keeping it in one place avoids
          duplicating functions across the toolbar. */}
    </header>
  );
}

/* ─── Menu Bar Button ─── */

function MenuBarItem({
  label,
  tooltip,
  children,
  isOpen,
  onToggle,
  onHover,
}: {
  label: string;
  tooltip?: string;
  children: React.ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  onHover: () => void;
}) {
  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={onToggle}
        onMouseEnter={onHover}
        title={tooltip ?? label}
        aria-label={tooltip ? `${label} — ${tooltip}` : label}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        style={{
          padding: "5px 10px",
          border: "none",
          borderRadius: 4,
          background: isOpen ? "hsl(var(--accent) / 0.12)" : "transparent",
          color: isOpen ? "hsl(var(--accent))" : "hsl(var(--fg))",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 500,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </button>
      {isOpen && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 2px)",
            insetInlineStart: 0,
            minWidth: 280,
            maxWidth: "min(320px, calc(100vw - 24px))",
            maxHeight: "70vh",
            overflowY: "auto",
            background: "hsl(var(--bg))",
            border: "1px solid hsl(var(--border-strong))",
            borderRadius: 10,
            boxShadow: "var(--shadow-lg)",
            zIndex: 9999,
            padding: "6px 0",
            animation: "cmdSlideIn var(--duration-fast) var(--ease-out)",
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/* ─── Menu Helpers ─── */

function MenuSection({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: "6px 14px 2px",
        fontSize: 10,
        color: "hsl(var(--fg-muted))",
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
      }}
    >
      {label}
    </div>
  );
}

function MenuDivider() {
  return <div style={{ height: 1, background: "hsl(var(--border))", margin: "4px 0" }} />;
}

/**
 * Collapsible submenu — used inside long parent menus to fold a category
 * (e.g. Insert → Diagrams) behind a single row marked with a chevron.
 * Hovering or clicking the row reveals a popout to the side.
 */
function SubMenuItem({
  icon,
  label,
  description,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const cancelClose = () => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 160);
  };

  // Compute the portal position from the trigger's bounding rect. We portal
  // the popout to <body> so it isn't clipped by the parent menu's
  // `overflow-y: auto` (CSS spec forces both axes to clip when one is auto).
  // RTL flip: open to the LEFT of the trigger when the document is RTL.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const isRtl = document.documentElement.dir === "rtl";
    const submenuWidth = Math.min(560, window.innerWidth * 0.8);
    const left = isRtl
      ? Math.max(8, rect.left - submenuWidth - 4)
      : Math.min(window.innerWidth - submenuWidth - 8, rect.right + 4);
    setPos({ top: rect.top - 6, left });
  }, [open]);

  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={scheduleClose}
    >
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((s) => !s)}
        title={description ?? label}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          padding: "7px 14px",
          border: "none",
          background: open ? "hsl(var(--accent) / 0.10)" : "transparent",
          color: open ? "hsl(var(--accent))" : "hsl(var(--fg))",
          fontSize: 13,
          cursor: "pointer",
          textAlign: "start",
        }}
      >
        <span style={{ flexShrink: 0 }}>{icon}</span>
        <span style={{ flex: 1, fontWeight: 500 }}>{label}</span>
        {description && (
          <span style={{ fontSize: 11, color: "hsl(var(--fg-muted))" }}>{description}</span>
        )}
        <ChevronRight size={14} aria-hidden style={{ flexShrink: 0, opacity: 0.7 }} />
      </button>
      {open && pos &&
        createPortal(
          <div
            role="menu"
            className="lumen-submenu-horizontal"
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            style={{
              position: "fixed",
              top: pos.top,
              // design-allow: viewport coordinates from getBoundingClientRect are physical
              left: pos.left,
              // Horizontal grid — submenus are dense palettes of categories so
              // browsing them sideways scans much faster than a tall column.
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(170px, 1fr))",
              gap: 2,
              width: "min(560px, 80vw)",
              maxHeight: "70vh",
              overflowY: "auto",
              background: "hsl(var(--bg))",
              border: "1px solid hsl(var(--border-strong))",
              borderRadius: 10,
              boxShadow: "var(--shadow-lg)",
              zIndex: 10000,
              padding: 8,
              animation: "cmdSlideIn var(--duration-fast) var(--ease-out)",
            }}
          >
            {children}
          </div>,
          document.body,
        )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  description,
  hint,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  description?: string;
  hint?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      title={description ?? label}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        width: "100%",
        padding: description ? "8px 14px" : "7px 14px",
        border: "none",
        background: active ? "hsl(var(--accent) / 0.12)" : "transparent",
        color: active ? "hsl(var(--accent))" : "hsl(var(--fg))",
        fontSize: 13,
        cursor: "pointer",
        textAlign: "start",
      }}
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLElement).style.background = "hsl(var(--accent) / 0.06)";
      }}
      onMouseLeave={(e) => {
        if (!active) (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
    >
      <span style={{ marginTop: 1, flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontWeight: 500 }}>{label}</span>
          {hint && (
            <span style={{ fontSize: 11, color: "hsl(var(--fg-muted))", flexShrink: 0 }}>
              {hint}
            </span>
          )}
        </span>
        {description && (
          <span style={{ fontSize: 11, color: "hsl(var(--fg-muted))", lineHeight: 1.3 }}>
            {description}
          </span>
        )}
      </span>
    </button>
  );
}
