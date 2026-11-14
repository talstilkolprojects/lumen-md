import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  FolderPlus,
  FolderOpen,
  Folder as FolderIcon,
  Pencil,
  Trash2,
  RefreshCcw,
} from "lucide-react";
import {
  basename,
  createWorkspaceFolder,
  dirname,
  isOPFSAvailable,
  joinPath,
  listWorkspaceTree,
  readWorkspaceFile,
  uniqueWorkspaceName,
  writeWorkspaceFile,
} from "../storage/workspace";
import type { WorkspaceNode } from "../storage/workspace";
import { t } from "../i18n";
import { uiAlert, uiConfirm, uiPrompt } from "./PromptDialog";
import { FileContextMenu, buildFileActions } from "./FileContextMenu";
import { useAppStore } from "../store/useStore";
import { duplicateFile, movedPath, renamedFileName, safeMoveWithCompanion, trashPaths, undoTrash, withoutCompanions, type MoveResult } from "../storage/fileOps";
import { flushActiveWorkspaceDoc, syncOpenDocsAfterMove } from "../store/openDocs";
import type { TrashItem } from "../storage/trash";
import { toast, useToastStore } from "../store/useToastStore";
import { onWorkspaceChanged } from "../storage/workspaceEvents";

interface Props {
  /** Currently active workspace path (if any). */
  activePath: string | null;
  /** Called when a file is selected for opening. */
  onOpenFile: (path: string, content: string) => void;
  /** Called after the active file is renamed. */
  onActiveRenamed: (newPath: string) => void;
  /** Called after the active file is deleted. */
  onActiveDeleted: () => void;
}

// The month calendar of daily notes (plan 4.12): its own chunk, loaded when shown.
const CalendarPanel = lazy(() => import("./CalendarPanel"));

export function FileTree({
  activePath,
  onOpenFile,
  onActiveRenamed,
  onActiveDeleted,
}: Props) {
  const [tree, setTree] = useState<WorkspaceNode[]>([]);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const tagFilter = useAppStore((s) => s.tagFilter);
  const setTagFilter = useAppStore((s) => s.setTagFilter);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    node: WorkspaceNode;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /** Ask before replacing anything (moves never overwrite silently — T46). */
  const confirmReplace = (path: string) => uiConfirm({ message: t("tree.confirm.replace", { path }) });

  /** Tell the user what a delete did, with Undo. */
  function announceTrash(items: TrashItem[]): void {
    if (!items.length) return;
    useToastStore.getState().push({
      kind: "info",
      title: t("tree.trashed", { count: String(items.length) }),
      ttlMs: 10_000,
      action: {
        label: t("tree.undo"),
        run: () => {
          void undoTrash(items).then(() => refresh());
        },
      },
    });
  }

  function announceMove(linksUpdated: string[]): void {
    if (linksUpdated.length) toast.info(t("tree.linksUpdated", { count: String(linksUpdated.length) }));
  }

  /**
   * `from` is now at `r.path`: open notes follow (a note inside a moved
   * folder too) and get the same link rewrite as the files on disk.
   */
  function afterMove(from: string, r: MoveResult): void {
    syncOpenDocsAfterMove(from, r.path, r.rewrite);
    const nextActive = activePath ? movedPath(activePath, from, r.path) : null;
    if (nextActive) onActiveRenamed(nextActive);
    if (r.linksError) toast.error(t("tree.linksFailed", { error: r.linksError.message }));
  }

  /** "file" / "directory" from the tree, not from the spelling (`project.v1/` is a folder). */
  function kindOf(path: string): "file" | "directory" {
    return findNode(tree, path)?.kind === "directory" ? "directory" : "file";
  }

  function toggleSelect(path: string): void {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }
  function clearSelection(): void {
    setSelectedPaths(new Set());
  }

  /** Bulk delete every selected path. Confirms once for the whole set. */
  async function bulkDelete(): Promise<void> {
    if (selectedPaths.size === 0) return;
    const paths = [...selectedPaths];
    // No confirmation: it goes to the trash, and the toast offers Undo.
    try {
      // Unsaved edits of the active note go with it (and come back on Undo).
      await flushActiveWorkspaceDoc();
      const items = await trashPaths(paths, Object.fromEntries(paths.map((p) => [p, kindOf(p)])));
      if (activePath && paths.some((p) => activePath === p || activePath.startsWith(p + "/"))) onActiveDeleted();
      announceTrash(items);
    } catch (e) {
      await uiAlert({ message: t("tree.alert.deleteFailed", { error: (e as Error).message }) });
    }
    clearSelection();
    await refresh();
  }

  /** Bulk move every selected file into a new parent folder. */
  async function bulkMove(): Promise<void> {
    if (selectedPaths.size === 0) return;
    const target = await uiPrompt({
      message: t("tree.prompt.bulkMoveTarget"),
      defaultValue: "",
    });
    if (target === null) return;
    const dir = target.trim().replace(/^\/+|\/+$/g, "");
    const updated = new Set<string>();
    // A selected PDF and its selected highlights note move as one unit.
    for (const p of withoutCompanions([...selectedPaths])) {
      const name = basename(p);
      const newPath = dir ? `${dir}/${name}` : name;
      try {
        await flushActiveWorkspaceDoc();
        // A PDF's highlights note moves with it (plan 4.14).
        const m = await safeMoveWithCompanion(p, newPath, { confirmReplace, folder: kindOf(p) === "directory" });
        if (!m) continue;
        for (const [from, r] of [[p, m.main], [`${p}.md`, m.companion]] as const) {
          if (!r) continue;
          r.linksUpdated.forEach((x) => updated.add(x));
          afterMove(from, r);
        }
      } catch (e) {
        await uiAlert({ message: t("tree.alert.renameFailed", { error: (e as Error).message }) });
      }
    }
    announceMove([...updated]);
    clearSelection();
    await refresh();
  }

  const available = isOPFSAvailable();

  /**
   * Apply the active tag filter (if any) to the tree. A directory survives
   * the filter when at least one of its descendants is in the allowed
   * path set; that way the user still sees the folder structure leading
   * to the matching files.
   */
  const displayedTree = useMemo<WorkspaceNode[]>(() => {
    if (!tagFilter) return tree;
    const allowed = new Set(tagFilter.paths);
    function prune(node: WorkspaceNode): WorkspaceNode | null {
      if (node.kind === "file") return allowed.has(node.path) ? node : null;
      const kept = (node.children ?? [])
        .map(prune)
        .filter((n): n is WorkspaceNode => n !== null);
      if (kept.length === 0) return null;
      return { ...node, children: kept };
    }
    return tree
      .map(prune)
      .filter((n): n is WorkspaceNode => n !== null);
  }, [tree, tagFilter]);

  const refresh = useMemo(
    () => async () => {
      if (!available) return;
      try {
        const list = await listWorkspaceTree();
        setTree(list);
      } catch {
        setTree([]);
      }
    },
    [available],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    // A save that only changed a file's text leaves the tree as it is (C3).
    return onWorkspaceChanged((c) => {
      if (c.kind === "structure") void refresh();
    }, { debounceMs: 150 });
  }, [refresh]);

  // Auto-expand all ancestors of the active file.
  useEffect(() => {
    if (!activePath) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      let p = dirname(activePath);
      while (p) {
        next.delete(p);
        const up = dirname(p);
        if (up === p) break;
        p = up;
      }
      return next;
    });
  }, [activePath]);

  useEffect(() => {
    if (editingPath) {
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    }
  }, [editingPath]);

  function toggle(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function newFile(parentPath: string) {
    const candidate = joinPath(parentPath, `${t("doc.untitled")}.md`);
    const path = await uniqueWorkspaceName(candidate);
    await writeWorkspaceFile(
      path,
      `# ${basename(path).replace(/\.md$/, "")}\n\n`,
    );
    await refresh();
    const text = await readWorkspaceFile(path);
    onOpenFile(path, text);
  }

  async function newFolder(parentPath: string) {
    const name = (await uiPrompt({ message: t("tree.prompt.folderName") }))?.trim();
    if (!name) return;
    if (/[/\\]/.test(name)) {
      await uiAlert({ message: t("tree.alert.noSlashes") });
      return;
    }
    try {
      await createWorkspaceFolder(joinPath(parentPath, name));
    } catch (e) {
      await uiAlert({
        message: t("tree.alert.folderFailed", { error: (e as Error).message }),
      });
      return;
    }
    await refresh();
  }

  async function open(node: WorkspaceNode) {
    if (node.kind !== "file") return;
    // A PDF opens in the reader (plan 4.14), not as text.
    if (/\.pdf$/i.test(node.path)) {
      window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path: node.path } }));
      return;
    }
    try {
      const text = await readWorkspaceFile(node.path);
      onOpenFile(node.path, text);
    } catch (e) {
      await uiAlert({ message: t("tree.alert.openFailed", { error: (e as Error).message }) });
    }
  }

  async function commitRename(oldPath: string) {
    const next = (editValue || basename(oldPath)).trim();
    setEditingPath(null);
    if (!next || next === basename(oldPath)) return;
    if (next.includes("/")) {
      await uiAlert({ message: t("tree.alert.renameNoSlashes") });
      return;
    }
    const target = joinPath(dirname(oldPath), renamedFileName(oldPath, next));
    try {
      const isFolder = findNode(tree, oldPath)?.kind === "directory";
      await flushActiveWorkspaceDoc();
      const m = await safeMoveWithCompanion(oldPath, isFolder ? joinPath(dirname(oldPath), next) : target, { confirmReplace, folder: isFolder });
      if (!m) return;
      afterMove(oldPath, m.main);
      if (m.companion) afterMove(`${oldPath}.md`, m.companion);
      announceMove([...m.main.linksUpdated, ...(m.companion?.linksUpdated ?? [])]);
      await refresh();
    } catch (e) {
      await uiAlert({
        message: t("tree.alert.renameFailed", { error: (e as Error).message }),
      });
    }
  }

  /** Duplicate a single file as `<name> copy.<ext>` (folders skipped), byte for byte. */
  async function duplicate(node: WorkspaceNode): Promise<void> {
    if (node.kind !== "file") return;
    try {
      await duplicateFile(node.path);
      await refresh();
    } catch (e) {
      await uiAlert({ message: (e as Error).message });
    }
  }

  /** Copy a path string to the clipboard. */
  async function copyPath(node: WorkspaceNode): Promise<void> {
    try {
      await navigator.clipboard.writeText(node.path);
    } catch {
      /* clipboard denied — silently ignore */
    }
  }

  async function remove(node: WorkspaceNode) {
    // Goes to the trash (Undo in the toast; restorable for 30 days).
    try {
      // Unsaved edits of the active note go with it (and come back on Undo).
      await flushActiveWorkspaceDoc();
      const items = await trashPaths([node.path], { [node.path]: node.kind === "directory" ? "directory" : "file" });
      announceTrash(items);
      if (
        activePath &&
        (activePath === node.path || activePath.startsWith(node.path + "/"))
      ) {
        onActiveDeleted();
      }
      await refresh();
    } catch (e) {
      await uiAlert({
        message: t("tree.alert.deleteFailed", { error: (e as Error).message }),
      });
    }
  }

  if (!available) {
    return (
      <aside className="file-tree" aria-label={t("tree.title")}>
        <div className="file-tree-header">{t("tree.title")}</div>
        <div
          style={{
            padding: "1rem",
            fontSize: 12,
            color: "hsl(var(--fg-muted))",
          }}
        >
          {t("tree.opfsUnavailable")}
        </div>
      </aside>
    );
  }

  return (
    <aside className="file-tree" aria-label={t("tree.title")}>
      <div className="file-tree-header">
        <span style={{ fontWeight: 600 }}>{t("tree.title")}</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            className="icon-btn"
            title={t("tree.newFileRoot")}
            aria-label={t("tree.newFileRoot")}
            onClick={() => newFile("")}
            style={{
              width: "auto",
              height: 32,
              padding: "4px 8px",
              display: "flex",
              alignItems: "center",
              gap: 4,
              borderRadius: 6,
              fontSize: 11,
            }}
          >
            <FilePlus2 size={16} />
            <span>{t("toolbar.new")}</span>
          </button>
          <button
            className="icon-btn"
            title={t("tree.newFolderRoot")}
            aria-label={t("tree.newFolderRoot")}
            onClick={() => newFolder("")}
            style={{
              width: "auto",
              height: 32,
              padding: "4px 8px",
              display: "flex",
              alignItems: "center",
              gap: 4,
              borderRadius: 6,
              fontSize: 11,
            }}
          >
            <FolderPlus size={16} />
            <span>{t("tree.newFolderRoot")}</span>
          </button>
          <button
            className="icon-btn"
            title={t("tree.refresh")}
            aria-label={t("tree.refresh")}
            onClick={refresh}
            style={{
              width: 32,
              height: 32,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 6,
            }}
          >
            <RefreshCcw size={16} />
          </button>
        </div>
      </div>
      {tagFilter && (
        <div
          role="status"
          aria-live="polite"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 10px",
            background: "hsl(var(--accent) / 0.10)",
            borderBottom: "1px solid hsl(var(--accent) / 0.30)",
            fontSize: 11,
            color: "hsl(var(--accent))",
            fontWeight: 600,
          }}
        >
          <span>
            {t("tree.tagFilter", {
              tag: tagFilter.tag,
              count: String(tagFilter.paths.length),
            }) ?? `# ${tagFilter.tag} · ${tagFilter.paths.length}`}
          </span>
          <button
            type="button"
            onClick={() => setTagFilter(null)}
            aria-label={
              t("tree.tagFilter.clear") ?? "Clear tag filter"
            }
            title={t("tree.tagFilter.clear") ?? "Clear tag filter"}
            style={{
              marginInlineStart: "auto",
              padding: "2px 6px",
              fontSize: 11,
              border: "none",
              borderRadius: 6,
              background: "transparent",
              color: "hsl(var(--accent))",
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>
      )}
      {displayedTree.length === 0 ? (
        <div
          style={{
            padding: "1rem 0.85rem",
            color: "hsl(var(--fg-muted))",
            fontSize: 12,
          }}
        >
          {tagFilter
            ? (t("tree.tagFilter.empty") ?? "No notes match this tag.")
            : t("tree.emptyHint")}
        </div>
      ) : (
        <>
          {selectedPaths.size > 0 && (
            <div
              role="toolbar"
              aria-label={t("tree.bulkToolbar")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 10px",
                background: "hsl(var(--accent) / 0.10)",
                borderBottom: "1px solid hsl(var(--accent) / 0.30)",
                fontSize: 11,
              }}
            >
              <span style={{ color: "hsl(var(--accent))", fontWeight: 600 }}>
                {t("tree.selectedCount", { count: String(selectedPaths.size) })}
              </span>
              <button
                type="button"
                onClick={bulkMove}
                style={{
                  marginInlineStart: "auto",
                  padding: "3px 9px",
                  fontSize: 11,
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 6,
                  background: "hsl(var(--bg))",
                  color: "hsl(var(--fg))",
                  cursor: "pointer",
                }}
              >
                {t("tree.bulkMove")}
              </button>
              <button
                type="button"
                onClick={bulkDelete}
                style={{
                  padding: "3px 9px",
                  fontSize: 11,
                  border: "1px solid hsl(0 80% 60% / 0.5)",
                  borderRadius: 6,
                  background: "hsl(0 80% 60% / 0.10)",
                  color: "hsl(0 80% 70%)",
                  cursor: "pointer",
                }}
              >
                {t("tree.bulkDelete")}
              </button>
              <button
                type="button"
                onClick={clearSelection}
                aria-label={t("tree.clearSelection")}
                title={t("tree.clearSelection")}
                style={{
                  padding: "3px 7px",
                  fontSize: 11,
                  border: "none",
                  borderRadius: 6,
                  background: "transparent",
                  color: "hsl(var(--fg-muted))",
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            </div>
          )}
          <ul className="file-tree-list" role="tree">
            {displayedTree.map((node) =>
              renderNode(node, 0, {
                activePath,
                collapsed,
                editingPath,
                editValue,
                setEditValue,
                setEditingPath,
                inputRef,
                toggle,
                open,
                commitRename,
                remove,
                newFile,
                newFolder,
                selectedPaths,
                toggleSelect,
                openContextMenu: (x, y, n) => setContextMenu({ x, y, node: n }),
              }),
            )}
          </ul>
        </>
      )}
      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          actions={buildFileActions({
            isFolder: contextMenu.node.kind === "directory",
            onRename: () => {
              setEditingPath(contextMenu.node.path);
              setEditValue(contextMenu.node.name);
            },
            onDuplicate: () => duplicate(contextMenu.node),
            onDelete: () => remove(contextMenu.node),
            onCopyPath: () => copyPath(contextMenu.node),
            onNewFile:
              contextMenu.node.kind === "directory"
                ? () => newFile(contextMenu.node.path)
                : undefined,
            onNewFolder:
              contextMenu.node.kind === "directory"
                ? () => newFolder(contextMenu.node.path)
                : undefined,
          })}
        />
      )}
      <CalendarSlot />
    </aside>
  );
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
            aria-label={`Rename ${node.name}`}
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
          {node.children.map((child) => renderNode(child, depth + 1, ctx))}
        </ul>
      )}
    </li>
  );
}

function findNode(nodes: WorkspaceNode[], path: string): WorkspaceNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const hit = findNode(n.children, path);
      if (hit) return hit;
    }
  }
  return undefined;
}

function CalendarSlot() {
  const show = useAppStore((s) => s.showCalendar);
  if (!show) return null;
  return (
    <Suspense fallback={null}>
      <CalendarPanel />
    </Suspense>
  );
}
