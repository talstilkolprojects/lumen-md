/**
 * The bar a database view shows while rows are selected (plan W7.4): pick a
 * field and an action, see how many notes will change, apply to all of them
 * as one undoable step. Loaded lazily, with its strings, on the first
 * selection.
 */
import { useMemo, useState } from "react";
import { t } from "../i18n";
import "./bulkEditStrings";
import type { PropertyType } from "../properties/frontmatter";
import { columnType, parseCellInput } from "./databaseEdit";
import { wouldChange, type BulkOp, type BulkSkip } from "./bulkEdit";
import { lastBulkEditAt, runBulkEdit, undoBulkChanges, undoLastBulkEdit, type BulkUndoResult } from "./bulkEditRun";
import { registerAppUndo } from "../storage/appUndo";
import { toast, useToastStore } from "../store/useToastStore";

export interface BulkRow {
  path: string;
  fm: Record<string, unknown>;
}

type OpKind = BulkOp["kind"];
const TYPES: PropertyType[] = ["text", "number", "date", "list", "checkbox", "link"];

function reportUndo(r: BulkUndoResult | null): void {
  if (!r) return;
  toast.success(t("bulkEdit.undone", { n: String(r.restored) }));
  if (r.conflicts.length) toast.warn(t("bulkEdit.undoConflicts", { n: String(r.conflicts.length) }), r.conflicts.slice(0, 10).join("\n"));
}

// Ctrl+Z outside an editor undoes the newest bulk edit when it is newer than the newest delete.
registerAppUndo({ at: lastBulkEditAt, undo: () => void undoLastBulkEdit().then(reportUndo) });

/** The operation the form describes, or null while it is incomplete. */
export function opFrom(kind: OpKind, key: string, value: string, to: PropertyType, type: PropertyType): BulkOp | null {
  const k = key.trim();
  if (!k) return null;
  switch (kind) {
    case "set":
      return { kind, key: k, value: parseCellInput(value, type) };
    case "addTag":
    case "removeTag":
      return value.trim() ? { kind, key: k, tag: value } : null;
    case "clear":
      return { kind, key: k };
    case "convert":
      return { kind, key: k, to };
  }
}

interface Props {
  selected: BulkRow[];
  /** Every loaded row: a field's type comes from all of them. */
  allRows: BulkRow[];
  fields: string[];
  onClear: () => void;
}

export default function BulkEditBar({ selected, allRows, fields, onClear }: Props) {
  const [kind, setKind] = useState<OpKind>("set");
  const [key, setKey] = useState(fields.includes("tags") ? "tags" : (fields[0] ?? ""));
  const [value, setValue] = useState("");
  const [to, setTo] = useState<PropertyType>("text");
  const [progress, setProgress] = useState<{ done: number; n: number } | null>(null);
  const type = useMemo(() => columnType(allRows.map((r) => r.fm[key]), key), [allRows, key]);
  const op = opFrom(kind, key, value, to, type);
  const changing = op ? selected.filter((r) => wouldChange(r.fm, op)).length : 0;

  const apply = async () => {
    if (!op || progress) return;
    setProgress({ done: 0, n: selected.length });
    try {
      const r = await runBulkEdit(selected.map((s) => s.path), op, (done, n) => setProgress({ done, n }));
      if (r.changes.length) {
        useToastStore.getState().push({
          kind: "success",
          title: t("bulkEdit.done", { n: String(r.changes.length), s: (r.ms / 1000).toFixed(1) }),
          ttlMs: 15_000,
          action: { label: t("bulkEdit.undo"), run: () => void undoBulkChanges(r.changes).then(reportUndo) },
        });
      }
      const why = new Map<BulkSkip | "failed", number>();
      for (const s of r.skipped) if (s.why !== "unchanged") why.set(s.why, (why.get(s.why) ?? 0) + 1);
      for (const [w, n] of why) toast.warn(t("bulkEdit.skipped", { n: String(n), why: t(`bulkEdit.why.${w}`) }));
    } finally {
      setProgress(null);
    }
  };

  const label = { fontSize: 11, color: "hsl(var(--fg-muted))" } as const;
  const button = { fontSize: 12, padding: "3px 10px", borderRadius: 6, border: "1px solid hsl(var(--border))", background: "hsl(var(--bg))", color: "inherit", cursor: "pointer" } as const;
  return (
    <div
      role="region"
      aria-label={t("bulkEdit.title")}
      data-testid="bulk-edit-bar"
      style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end", padding: 8, borderBlockEnd: "1px solid hsl(var(--border))", background: "hsl(var(--bg-subtle))", fontSize: 12 }}
    >
      <strong data-testid="bulk-selected">{t("bulkEdit.selected", { n: String(selected.length) })}</strong>
      <label style={{ display: "grid", gap: 2 }}>
        <span style={label}>{t("bulkEdit.field")}</span>
        <input list="bulk-edit-fields" value={key} dir="auto" onChange={(e) => setKey(e.target.value)} data-testid="bulk-field" style={{ inlineSize: 120 }} />
        <datalist id="bulk-edit-fields">
          {fields.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </label>
      <label style={{ display: "grid", gap: 2 }}>
        <span style={label}>{t("bulkEdit.op")}</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as OpKind)} data-testid="bulk-op">
          {(["set", "addTag", "removeTag", "clear", "convert"] as const).map((k) => (
            <option key={k} value={k}>
              {t(`bulkEdit.op.${k}`)}
            </option>
          ))}
        </select>
      </label>
      {(kind === "set" || kind === "addTag" || kind === "removeTag") && (
        <label style={{ display: "grid", gap: 2 }}>
          <span style={label}>{t("bulkEdit.value")}</span>
          <input
            value={value}
            dir="auto"
            type={kind === "set" && type === "date" ? "date" : "text"}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void apply();
            }}
            data-testid="bulk-value"
            style={{ inlineSize: 160 }}
          />
        </label>
      )}
      {kind === "convert" && (
        <label style={{ display: "grid", gap: 2 }}>
          <span style={label}>{t("bulkEdit.toType")}</span>
          <select value={to} onChange={(e) => setTo(e.target.value as PropertyType)} data-testid="bulk-type">
            {TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {t(`bulkEdit.type.${ty}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      <span role="status" data-testid="bulk-preview" style={{ ...label, alignSelf: "center" }}>
        {progress ? t("bulkEdit.applying", { done: String(progress.done), n: String(progress.n) }) : t("bulkEdit.preview", { n: String(changing), total: String(selected.length) })}
      </span>
      <button type="button" style={{ ...button, fontWeight: 600 }} disabled={!op || changing === 0 || !!progress} onClick={() => void apply()} data-testid="bulk-apply">
        {t("bulkEdit.apply", { n: String(changing) })}
      </button>
      <button type="button" style={button} onClick={onClear} disabled={!!progress}>
        {t("bulkEdit.clearSelection")}
      </button>
    </div>
  );
}
