/**
 * Native-feeling right-click context menu for the file tree.
 *
 * Renders a positioned floating panel with the standard file actions
 * (rename, duplicate, delete, copy path, reveal in Finder is desktop-
 * only and not exposed). Closes on outside click, Escape, or any item
 * activation.
 *
 * Lives separately from `FileTree.tsx` so the tree component stays
 * focused on layout — the menu is mounted at the document root via
 * `createPortal` so it isn't clipped by the file-tree's own overflow.
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Pencil, Copy, Trash2, FilePlus2, FolderPlus, ClipboardCopy } from "lucide-react";
import { t } from "../i18n";

export interface FileContextAction {
  id: string;
  label: string;
  icon: React.ReactNode;
  destructive?: boolean;
  onSelect: () => void;
}

interface Props {
  x: number;
  y: number;
  onClose: () => void;
  actions: FileContextAction[];
}

export function FileContextMenu({ x, y, onClose, actions }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Clamp the menu inside the viewport so it doesn't open off-screen
  // when the user right-clicks near the edge.
  const w = 200;
  const h = actions.length * 30 + 12;
  const left = Math.min(x, window.innerWidth - w - 8);
  const top = Math.min(y, window.innerHeight - h - 8);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={t("contextMenu.title")}
      style={{
        position: "fixed",
        left,
        top,
        minWidth: w,
        background: "hsl(var(--bg))",
        border: "1px solid hsl(var(--border-strong))",
        borderRadius: 10,
        boxShadow: "var(--shadow-lg)",
        zIndex: 10001,
        padding: "6px 0",
        animation: "cmdSlideIn var(--duration-fast) var(--ease-out)",
      }}
    >
      {actions.map((a) => (
        <button
          key={a.id}
          role="menuitem"
          onClick={() => {
            a.onSelect();
            onClose();
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            width: "100%",
            padding: "6px 14px",
            border: "none",
            background: "transparent",
            color: a.destructive ? "hsl(var(--danger))" : "hsl(var(--fg))",
            fontSize: 13,
            cursor: "pointer",
            textAlign: "start",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = a.destructive
              ? "hsl(var(--danger) / 0.10)"
              : "hsl(var(--accent) / 0.10)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "transparent";
          }}
        >
          <span style={{ flexShrink: 0, opacity: 0.85 }}>{a.icon}</span>
          {a.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

/**
 * Convenience helper: build the standard action set for a file or folder.
 * Pass in the callbacks you'd otherwise wire one-by-one.
 */
export function buildFileActions(opts: {
  isFolder: boolean;
  onRename: () => void;
  onDuplicate?: () => void;
  onDelete: () => void;
  onCopyPath: () => void;
  onNewFile?: () => void;
  onNewFolder?: () => void;
}): FileContextAction[] {
  const out: FileContextAction[] = [
    {
      id: "rename",
      label: t("contextMenu.rename"),
      icon: <Pencil size={14} />,
      onSelect: opts.onRename,
    },
  ];
  if (opts.onDuplicate && !opts.isFolder) {
    out.push({
      id: "duplicate",
      label: t("contextMenu.duplicate"),
      icon: <Copy size={14} />,
      onSelect: opts.onDuplicate,
    });
  }
  out.push({
    id: "copyPath",
    label: t("contextMenu.copyPath"),
    icon: <ClipboardCopy size={14} />,
    onSelect: opts.onCopyPath,
  });
  if (opts.isFolder) {
    if (opts.onNewFile) {
      out.push({
        id: "newFile",
        label: t("contextMenu.newFileHere"),
        icon: <FilePlus2 size={14} />,
        onSelect: opts.onNewFile,
      });
    }
    if (opts.onNewFolder) {
      out.push({
        id: "newFolder",
        label: t("contextMenu.newSubfolder"),
        icon: <FolderPlus size={14} />,
        onSelect: opts.onNewFolder,
      });
    }
  }
  out.push({
    id: "delete",
    label: t("contextMenu.delete"),
    icon: <Trash2 size={14} />,
    destructive: true,
    onSelect: opts.onDelete,
  });
  return out;
}
