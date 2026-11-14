/**
 * The rows of the file tree (split out of FileTree.tsx, plan W4.11): one
 * folder or file per row, rendered recursively from a shared context.
 */
import { ChevronDown, ChevronRight, FilePlus2, FileText, FolderPlus, FolderOpen, Folder as FolderIcon, Pencil, Trash2 } from "lucide-react";
import type { WorkspaceNode } from "../storage/workspace";
import { t } from "../i18n";

/**
 * The children of one folder to render: the first `limit` rows (folders
 * first, as listed) plus the active note and its folder; `hidden` is how
 * many are left out. `limit` null: everything. A vault of 10,000 root
 * folders is as limited as one of 10,000 root notes.
 */
export function visibleChildren(
  nodes: WorkspaceNode[],
  limit: number | null,
  activePath: string | null,
): { shown: WorkspaceNode[]; hidden: number } {
  if (limit === null || nodes.length <= limit) return { shown: nodes, hidden: 0 };
  let hidden = 0;
  const shown = nodes.filter((n, i) => {
    // The active note, and the folder on its way, always stay.
    if (i < limit || n.path === activePath || (activePath?.startsWith(n.path + "/") ?? false)) return true;
    hidden++;
    return false;
  });
  return { shown, hidden };
}

interface RenderCtx {
  activePath: string | null;
  collapsed: Set<string>;
  editingPath: string | null;
  editValue: string;
  setEditValue: (s: string) => void;
  setEditingPath: (p: string | null) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  toggle: (path: string) => void;
  open: (node: WorkspaceNode) => void;
  commitRename: (oldPath: string) => void;
  remove: (node: WorkspaceNode) => void;
  newFile: (parent: string) => void;
  newFolder: (parent: string) => void;
  selectedPaths: Set<string>;
  toggleSelect: (path: string) => void;
  openContextMenu: (x: number, y: number, node: WorkspaceNode) => void;
  fileLimit: number | null;
  shownAll: Set<string>;
  showAll: (dir: string) => void;
}

/** The rows of one folder's children, with "show N more" when a large vault limits them. */
export function renderChildren(nodes: WorkspaceNode[], dir: string, depth: number, ctx: RenderCtx): React.ReactNode {
  const { shown, hidden } = visibleChildren(nodes, ctx.shownAll.has(dir) ? null : ctx.fileLimit, ctx.activePath);
  return (
    <>
      {shown.map((child) => renderNode(child, depth, ctx))}
      {hidden > 0 && (
        <li role="none">
          <button
            type="button"
            className="file-tree-item file-tree-more"
            style={{ paddingInlineStart: 6 + depth * 12 }}
            onClick={() => ctx.showAll(dir)}
          >
            {t("tree.showMore", { count: String(hidden) })}
          </button>
        </li>
      )}
    </>
  );
}

function renderNode(
  node: WorkspaceNode,
  depth: number,
  ctx: RenderCtx,
): React.ReactNode {
  const isFolder = node.kind === "directory";
  const isOpen = !ctx.collapsed.has(node.path);
  const isActive = node.path === ctx.activePath;
  const isEditing = ctx.editingPath === node.path;
  const isSelected = ctx.selectedPaths.has(node.path);

  return (
    <li
      key={node.path}
      role="treeitem"
      aria-expanded={isFolder ? isOpen : undefined}
      aria-selected={isActive}
    >
      <div
        className={`file-tree-item ${isActive ? "active" : ""}${isSelected ? " selected" : ""}`}
        data-path={node.path}
        onContextMenu={(e) => {
          e.preventDefault();
          ctx.openContextMenu(e.clientX, e.clientY, node);
        }}
        style={{
          paddingInlineStart: 6 + depth * 12,
          background: isSelected
            ? "hsl(var(--accent) / 0.18)"
            : undefined,
        }}
      >
        {isFolder ? (
          <button
            type="button"
            className="file-tree-chevron"
            onClick={() => ctx.toggle(node.path)}
            title={isOpen ? t("tree.collapse") : t("tree.expand")}
            aria-label={isOpen ? t("tree.collapse") : t("tree.expand")}
          >
            {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        ) : (
          <span style={{ width: 14, display: "inline-block" }} />
        )}

        {isFolder ? (
          isOpen ? (
            <FolderOpen size={14} style={{ flexShrink: 0, opacity: 0.8 }} />
          ) : (
            <FolderIcon size={14} style={{ flexShrink: 0, opacity: 0.8 }} />
          )
        ) : (
          <FileText size={14} style={{ flexShrink: 0, opacity: 0.7 }} />
        )}

        {isEditing ? (
          <input
            ref={ctx.inputRef as React.RefObject<HTMLInputElement>}
            className="file-tree-input"
            aria-label={t("tree.renameItem", { name: node.name })}
            value={ctx.editValue}
            onChange={(ev) => ctx.setEditValue(ev.target.value)}
            onBlur={() => ctx.commitRename(node.path)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter") ctx.commitRename(node.path);
              else if (ev.key === "Escape") ctx.setEditingPath(null);
            }}
          />
        ) : (
          <button
            type="button"
            className="file-tree-name"
            onClick={(e) => {
              // ⌘-click / Ctrl-click → toggle multi-selection rather than
              // opening the file. This lets users build up a set for bulk
              // delete / move without leaving the keyboard.
              if (e.metaKey || e.ctrlKey) {
                e.preventDefault();
                ctx.toggleSelect(node.path);
                return;
              }
              if (isFolder) ctx.toggle(node.path);
              else ctx.open(node);
            }}
            onDoubleClick={() => {
              ctx.setEditingPath(node.path);
              ctx.setEditValue(node.name);
            }}
            title={node.path}
            aria-checked={isSelected ? true : undefined}
          >
            {node.name}
          </button>
        )}

        {isFolder && (
          <>
            <button
              type="button"
              className="file-tree-action"
              title={t("tree.newFileHere")}
              aria-label={t("tree.newFileHere")}
              onClick={(e) => {
                e.stopPropagation();
                ctx.newFile(node.path);
              }}
            >
              <FilePlus2 size={13} />
            </button>
            <button
              type="button"
              className="file-tree-action"
              title={t("tree.newSubfolder")}
              aria-label={t("tree.newSubfolder")}
              onClick={(e) => {
                e.stopPropagation();
                ctx.newFolder(node.path);
              }}
            >
              <FolderPlus size={13} />
            </button>
          </>
        )}
        {!isFolder && (
          <button
            type="button"
            className="file-tree-action"
            title={t("tree.rename")}
            aria-label={t("tree.rename")}
            onClick={(e) => {
              e.stopPropagation();
              ctx.setEditingPath(node.path);
              ctx.setEditValue(node.name);
            }}
          >
            <Pencil size={13} />
          </button>
        )}
        <button
          type="button"
          className="file-tree-action"
          title={t("tree.delete")}
          aria-label={t("tree.delete")}
          onClick={(e) => {
            e.stopPropagation();
            ctx.remove(node);
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {isFolder && isOpen && node.children && (
        <ul className="file-tree-list" role="group">
          {renderChildren(node.children, node.path, depth + 1, ctx)}
        </ul>
      )}
    </li>
  );
}
