/**
 * Trash panel (T46): what was deleted in the last 30 days, with Restore
 * and Delete forever.
 */
import { useCallback, useEffect, useState, useRef } from "react";
import { useFocusTrap } from "./useFocusTrap";
import { Trash2, X } from "lucide-react";
import { t, getLocale } from "../i18n";
import { emptyTrash, listTrash, restoreFromTrashIfPresent, TRASH_KEEP_MS, type TrashItem } from "../storage/trash";
import { onWorkspaceChanged } from "../storage/workspaceEvents";
import { toast } from "../store/useToastStore";
import { EmptyState } from "./EmptyState";
import { uiConfirm } from "./PromptDialog";
import { HelpButton } from "./HelpButton";
import "./trashPanelStrings";

interface Props {
  open: boolean;
  onClose: () => void;
}

const btn: React.CSSProperties = { padding: "4px 10px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };

export function TrashPanel({ open, onClose }: Props) {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const reload = useCallback(async () => setItems(await listTrash()), []);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  // Ctrl+Z outside the editor (or a delete) can change the trash while the
  // panel is open: show what is in it now, not what was when it opened.
  useEffect(() => {
    if (!open) return;
    return onWorkspaceChanged((c) => {
      if (c.kind === "structure") void reload();
    }, { debounceMs: 100 });
  }, [open, reload]);

  // Focus stays in the dialog while it is open and returns on close; Escape closes it (plan 10.1).
  const trapRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(trapRef, { active: open, onEscape: onClose });

  if (!open) return null;

  const restore = async (i: TrashItem) => {
    // Null when it was restored meanwhile (e.g. by Ctrl+Z): just show the list as it is.
    const where = await restoreFromTrashIfPresent(i.id);
    if (where !== null) {
      window.dispatchEvent(new Event("lumen-workspace-changed"));
      toast.success(t("trash.restored", { path: where }));
    }
    await reload();
  };
  const forever = async (i: TrashItem) => {
    if (!(await uiConfirm({ message: t("trash.deleteForeverConfirm", { path: i.originalPath }) }))) return;
    await emptyTrash({ id: i.id });
    await reload();
  };
  const all = async () => {
    if (!(await uiConfirm({ message: t("trash.emptyAllConfirm", { n: items?.length ?? 0 }) }))) return;
    await emptyTrash();
    await reload();
  };
  const daysLeft = (i: TrashItem) => Math.max(0, Math.ceil((i.trashedAt + TRASH_KEEP_MS - Date.now()) / 86_400_000));

  return (
    <div className="cmd-palette-backdrop" onClick={onClose} ref={trapRef} role="dialog" aria-modal="true" aria-label={t("trash.title")}>
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560, padding: 0, display: "flex", flexDirection: "column", maxHeight: "80vh" }}>
        <header style={{ padding: "12px 16px", borderBottom: "1px solid hsl(var(--border))", display: "flex", gap: 10, alignItems: "center" }}>
          <Trash2 size={16} />
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, flex: 1 }}>{t("trash.title")}</h2>
          {!!items?.length && (
            <button type="button" style={btn} onClick={() => void all()}>
              {t("trash.emptyAll")}
            </button>
          )}
          <HelpButton topic="workspace/panels#trash" />
          <button type="button" style={btn} onClick={onClose} aria-label={t("trash.close")}>
            <X size={14} />
          </button>
        </header>
        <div style={{ overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          {items && items.length === 0 && <EmptyState style={{ fontSize: 13 }} message={t("trash.empty")} action={{ label: t("trash.backToNotes"), onClick: onClose }} />}
          {items?.map((i) => (
            <div key={i.id} data-testid="trash-item" style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 8px", borderRadius: 6, background: "hsl(var(--bg-subtle))" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} dir="auto">{i.originalPath}</div>
                <div style={{ fontSize: 11, color: "hsl(var(--fg-muted))" }}>
                  {new Date(i.trashedAt).toLocaleString(getLocale())} · {t("trash.daysLeft", { n: String(daysLeft(i)) })}
                </div>
              </div>
              <button type="button" style={btn} onClick={() => void restore(i)}>{t("trash.restore")}</button>
              <button type="button" style={btn} onClick={() => void forever(i)}>{t("trash.deleteForever")}</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
