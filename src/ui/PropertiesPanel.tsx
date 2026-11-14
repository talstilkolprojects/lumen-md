/**
 * Properties panel (plan 4.9): the note's YAML frontmatter as typed fields —
 * text, number, date, list, checkbox, link. Every edit goes through
 * ../properties/frontmatter, which rewrites only the edited value, so the
 * rest of the note (comments, order, quoting, line endings) is untouched.
 * Values already used for a key anywhere in the vault are offered as
 * completions (from the in-memory workspace index).
 *
 * Loaded lazily (App mounts it only while open); logical CSS only, so it
 * mirrors correctly in Hebrew / Arabic.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ExternalLink, Plus, SlidersHorizontal, X } from "lucide-react";
import { t } from "../i18n";
import { toast } from "../store/useToastStore";
import { onWorkspaceChanged } from "../storage/workspaceEvents";
import { headingSlug } from "../lib/slug";
import {
  collectPropertySuggestions,
  convertValue,
  parseProperties,
  rankSuggestions,
  removeProperty,
  setProperty,
  type Property,
  type PropertySuggestions,
  type PropertyType,
  type PropertyValue,
} from "../properties/frontmatter";

interface Props {
  open: boolean;
  onClose: () => void;
  /** The note's current text. */
  text: string;
  /** Apply an edit to the note's current text (the editor's, not a stale copy). */
  applyEdit: (edit: (text: string) => string) => void;
}

const TYPES: PropertyType[] = ["text", "number", "date", "list", "checkbox", "link"];
const TYPE_STORE = "lumen.propertyTypes";

function typeLabel(type: PropertyType): string {
  switch (type) {
    case "text":
      return t("props.type.text");
    case "number":
      return t("props.type.number");
    case "date":
      return t("props.type.date");
    case "list":
      return t("props.type.list");
    case "checkbox":
      return t("props.type.checkbox");
    case "link":
      return t("props.type.link");
  }
}

/** Types the user picked for a key (a remembered per-viewer convenience). */
function loadTypes(): Record<string, PropertyType> {
  try {
    const v = JSON.parse(localStorage.getItem(TYPE_STORE) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function saveTypes(types: Record<string, PropertyType>) {
  try {
    localStorage.setItem(TYPE_STORE, JSON.stringify(types));
  } catch {
    /* private mode: types are not remembered */
  }
}

const inputStyle: React.CSSProperties = {
  inlineSize: "100%",
  minInlineSize: 0,
  paddingBlock: 3,
  paddingInline: 6,
  fontSize: 12,
  borderRadius: 5,
  border: "1px solid hsl(var(--border))",
  background: "hsl(var(--bg))",
  color: "hsl(var(--fg))",
};
const iconBtn: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "hsl(var(--fg-muted))",
  cursor: "pointer",
  padding: 3,
  borderRadius: 5,
  display: "inline-flex",
  flexShrink: 0,
};

/** A text-like input that commits on Enter / blur, and follows outside changes while not focused. */
function CommitInput({
  value,
  onCommit,
  type = "text",
  list,
  label,
}: {
  value: string;
  onCommit: (v: string) => void;
  type?: string;
  list?: string;
  label: string;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      type={type}
      dir="auto"
      value={draft}
      list={list}
      aria-label={label}
      style={inputStyle}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        // Pickers (date) commit as soon as a value is chosen.
        if (type === "date" || type === "datetime-local") onCommit(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(value);
        }
      }}
    />
  );
}

function linkInner(v: string): string {
  const m = /^\[\[([^\]]*)\]\]$/.exec(v.trim());
  return m ? m[1] : v;
}

function ListEditor({ prop, items, suggestions, onChange }: { prop: string; items: string[]; suggestions: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const listId = useId();
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    setDraft("");
    if (!items.includes(v)) onChange([...items, v]);
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
      {items.map((item, i) => (
        <span
          key={`${item}-${i}`}
          dir="auto"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 2,
            paddingBlock: 1,
            paddingInline: "8px 2px",
            borderRadius: 999,
            fontSize: 11,
            background: "hsl(var(--accent) / 0.12)",
            color: "hsl(var(--fg))",
          }}
        >
          {item}
          <button
            type="button"
            style={{ ...iconBtn, padding: 1 }}
            aria-label={t("props.removeItem", { item })}
            title={t("props.removeItem", { item })}
            onClick={() => onChange(items.filter((_, j) => j !== i))}
          >
            <X size={10} aria-hidden />
          </button>
        </span>
      ))}
      <input
        dir="auto"
        value={draft}
        list={listId}
        placeholder={t("props.addItem")}
        aria-label={t("props.addItemTo", { key: prop })}
        style={{ ...inputStyle, inlineSize: "auto", flex: 1, minInlineSize: 70 }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !draft && items.length) {
            onChange(items.slice(0, -1));
          }
        }}
      />
      <datalist id={listId}>
        {suggestions.filter((s) => !items.includes(s)).map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}

function ValueEditor({
  prop,
  type,
  suggestions,
  noteNames,
  onChange,
}: {
  prop: Property;
  type: PropertyType;
  suggestions: string[];
  noteNames: string[];
  onChange: (v: PropertyValue) => void;
}) {
  const listId = useId();
  const v = prop.value;
  const label = t("props.value", { key: prop.key });
  if (!prop.editable) {
    return (
      <span style={{ fontSize: 11, color: "hsl(var(--fg-muted))" }} title={t("props.readOnly")}>
        {t("props.readOnly")}
      </span>
    );
  }
  const datalist = (options: string[]) => (
    <datalist id={listId}>
      {options.map((s) => (
        <option key={s} value={s} />
      ))}
    </datalist>
  );
  switch (type) {
    case "checkbox":
      return <input type="checkbox" aria-label={label} checked={v === true} onChange={(e) => onChange(e.target.checked)} />;
    case "number":
      return (
        <CommitInput
          type="number"
          label={label}
          value={typeof v === "number" ? String(v) : v === null ? "" : String(v)}
          onCommit={(s) => onChange(s.trim() === "" ? null : Number.isFinite(Number(s)) ? Number(s) : String(s))}
        />
      );
    case "date": {
      const s = typeof v === "string" ? v.trim() : "";
      // Pickers only for values they can show whole: a date, or a date and
      // minutes. Seconds or a time zone would be cut off — edit those as text.
      const dateOnly = s === "" || /^\d{4}-\d{2}-\d{2}$/.test(s);
      const minutes = /^(\d{4}-\d{2}-\d{2})([T ])(\d{2}:\d{2})$/.exec(s);
      if (!dateOnly && !minutes) {
        return <CommitInput label={label} value={s} onCommit={(next) => onChange(next.trim() || null)} />;
      }
      return (
        <CommitInput
          type={minutes ? "datetime-local" : "date"}
          label={label}
          value={minutes ? `${minutes[1]}T${minutes[3]}` : s}
          // Keep the separator the value was written with.
          onCommit={(next) => onChange(next ? (minutes ? next.replace("T", minutes[2]) : next) : null)}
        />
      );
    }
    case "list":
      return <ListEditor prop={prop.key} items={Array.isArray(v) ? v.map(String) : v === null ? [] : [String(v)]} suggestions={suggestions} onChange={onChange} />;
    case "link": {
      const s = typeof v === "string" ? v : v === null ? "" : String(v);
      const inner = linkInner(s);
      const isUrl = /^https?:\/\//.test(s);
      return (
        <div style={{ display: "flex", gap: 2, alignItems: "center", minInlineSize: 0 }}>
          <CommitInput
            label={label}
            value={inner}
            list={listId}
            onCommit={(next) => onChange(!next.trim() ? null : /^https?:\/\//.test(next) ? next.trim() : `[[${next.trim()}]]`)}
          />
          {datalist(noteNames)}
          {inner && (
            <button
              type="button"
              style={iconBtn}
              aria-label={t("props.openLink", { target: inner })}
              title={t("props.openLink", { target: inner })}
              onClick={() => (isUrl ? window.open(s, "_blank", "noopener,noreferrer") : void openNote(inner))}
            >
              <ExternalLink size={12} aria-hidden />
            </button>
          )}
        </div>
      );
    }
    default:
      return (
        <>
          <CommitInput label={label} value={v === null ? "" : String(v)} list={listId} onCommit={(s) => onChange(s === "" ? null : s)} />
          {datalist(suggestions)}
        </>
      );
  }
}

/** Open the note a `[[link]]` names, the way a wiki link in the preview does. */
async function openNote(target: string) {
  try {
    const [{ listWorkspace }, { resolveWikiTarget, splitWikiTarget }] = await Promise.all([
      import("../storage/workspace"),
      import("../renderer/wikiLinks"),
    ]);
    const { note, heading } = splitWikiTarget(target.split("|")[0]);
    const path = resolveWikiTarget(note, (await listWorkspace()).map((f) => f.path));
    // `[[Guide#Setup]]` opens at that heading, like a wiki link in the preview.
    if (path) window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: heading ? { path, heading: headingSlug(heading) } : { path } }));
    else toast.error(t("props.linkMissing", { target: note }));
  } catch {
    /* no workspace */
  }
}

export function PropertiesPanel({ open, onClose, text, applyEdit }: Props) {
  const parsed = useMemo(() => parseProperties(text), [text]);
  const [types, setTypes] = useState<Record<string, PropertyType>>(loadTypes);
  const [vault, setVault] = useState<{ suggestions: PropertySuggestions; notes: string[] } | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newType, setNewType] = useState<PropertyType>("text");
  const keyListId = useId();

  // Vault-wide names and values, from the workspace index; refreshed when the vault changes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const { ensureIndex, indexedFiles } = await import("../storage/workspaceIndex");
        await ensureIndex();
        const files = indexedFiles();
        if (cancelled) return;
        setVault({
          suggestions: collectPropertySuggestions(files),
          notes: files.filter((f) => /\.(md|markdown)$/i.test(f.path)).map((f) => f.name.replace(/\.(md|markdown)$/i, "")),
        });
      } catch {
        /* no workspace: no suggestions */
      }
    };
    void refresh();
    const off = onWorkspaceChanged(() => void refresh(), { debounceMs: 800 });
    return () => {
      cancelled = true;
      off();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const edit = useCallback(
    (fn: (text: string) => string) => {
      try {
        applyEdit(fn);
      } catch (e) {
        toast.error(t("props.writeFailed", { error: e instanceof Error ? e.message : String(e) }));
      }
    },
    [applyEdit],
  );

  if (!open) return null;

  const typeOf = (p: Property): PropertyType => (p.editable ? types[p.key] ?? p.type : p.type);
  const changeType = (p: Property, to: PropertyType) => {
    const next = { ...types, [p.key]: to };
    setTypes(next);
    saveTypes(next);
    edit((cur) => setProperty(cur, p.key, convertValue(p.value, to)));
  };
  const present = new Set(parsed.properties.map((p) => p.key));
  const addProperty = () => {
    const key = newKey.trim();
    if (!key) return;
    if (present.has(key)) {
      toast.error(t("props.keyExists", { key }));
      return;
    }
    const initial: PropertyValue = newType === "list" ? [] : newType === "checkbox" ? false : newType === "date" ? new Date().toISOString().slice(0, 10) : newType === "number" ? 0 : null;
    const next = { ...types, [key]: newType };
    setTypes(next);
    saveTypes(next);
    edit((cur) => setProperty(cur, key, initial));
    setNewKey("");
  };

  return (
    <aside
      role="complementary"
      aria-label={t("props.title")}
      data-testid="properties-panel"
      style={{
        position: "fixed",
        insetInlineEnd: 0,
        insetBlockStart: 48,
        insetBlockEnd: 0,
        inlineSize: 320,
        maxInlineSize: "100vw",
        background: "hsl(var(--bg))",
        borderInlineStart: "1px solid hsl(var(--border))",
        zIndex: 70,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          paddingBlock: 10,
          paddingInline: 14,
          borderBlockEnd: "1px solid hsl(var(--border))",
        }}
      >
        <SlidersHorizontal size={14} aria-hidden />
        <span style={{ fontWeight: 600, fontSize: 13 }}>{t("props.title")}</span>
        <button type="button" onClick={onClose} aria-label={t("props.close")} title={t("props.close")} style={{ ...iconBtn, marginInlineStart: "auto" }}>
          <X size={14} />
        </button>
      </header>

      <div style={{ flex: 1, overflowY: "auto", paddingBlock: 8, paddingInline: 12 }}>
        {parsed.status === "invalid" && (
          <div role="alert" style={{ fontSize: 12, color: "hsl(0 70% 55%)", lineHeight: 1.5, paddingBlockEnd: 8 }}>
            {t("props.invalid", { error: parsed.error ?? "" })}
          </div>
        )}
        {parsed.status !== "invalid" && parsed.properties.length === 0 && (
          <div style={{ fontSize: 12, color: "hsl(var(--fg-muted))", paddingBlockEnd: 8 }}>{t("props.empty")}</div>
        )}
        {parsed.properties.map((p) => {
          const type = typeOf(p);
          return (
            <div
              key={p.key}
              data-property={p.key}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(70px, 34%) 1fr auto",
                gap: 6,
                alignItems: "center",
                paddingBlock: 4,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minInlineSize: 0 }}>
                <span dir="auto" title={p.key} style={{ fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.key}
                </span>
                {p.editable && (
                  <select
                    value={type}
                    aria-label={t("props.type", { key: p.key })}
                    onChange={(e) => changeType(p, e.target.value as PropertyType)}
                    style={{ ...inputStyle, fontSize: 10, paddingBlock: 1, color: "hsl(var(--fg-muted))" }}
                  >
                    {TYPES.map((ty) => (
                      <option key={ty} value={ty}>
                        {typeLabel(ty)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div style={{ minInlineSize: 0 }}>
                <ValueEditor
                  prop={p}
                  type={type}
                  suggestions={rankSuggestions(vault?.suggestions.values.get(p.key))}
                  noteNames={vault?.notes ?? []}
                  onChange={(value) => edit((cur) => setProperty(cur, p.key, value))}
                />
              </div>
              <button
                type="button"
                style={iconBtn}
                aria-label={t("props.remove", { key: p.key })}
                title={t("props.remove", { key: p.key })}
                onClick={() => edit((cur) => removeProperty(cur, p.key))}
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>

      {parsed.status !== "invalid" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            addProperty();
          }}
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            paddingBlock: 10,
            paddingInline: 12,
            borderBlockStart: "1px solid hsl(var(--border))",
          }}
        >
          <input
            dir="auto"
            value={newKey}
            list={keyListId}
            placeholder={t("props.addKey")}
            aria-label={t("props.addKey")}
            onChange={(e) => setNewKey(e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          />
          <datalist id={keyListId}>
            {rankSuggestions(vault?.suggestions.keys, present).map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
          <select value={newType} aria-label={t("props.newType")} onChange={(e) => setNewType(e.target.value as PropertyType)} style={{ ...inputStyle, inlineSize: "auto" }}>
            {TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {typeLabel(ty)}
              </option>
            ))}
          </select>
          <button type="submit" style={{ ...iconBtn, color: "hsl(var(--accent))" }} aria-label={t("props.add")} title={t("props.add")} disabled={!newKey.trim()}>
            <Plus size={14} aria-hidden />
          </button>
        </form>
      )}
    </aside>
  );
}

export default PropertiesPanel;
