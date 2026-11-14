/**
 * InsightsBlock — accepts JSONL or a JSON array, computes a probability table
 * + co-occurrence matrix + conclusions, and offers one-click suggestions for
 * spinning the dataset out into new markdown documents. All analysis runs
 * locally; no external model is contacted.
 *
 * Wired into the renderer pipeline as ```insights / ```jsonl fences.
 */

import { useMemo, useState, type ReactNode } from "react";
import {
  Sparkles,
  Table2,
  BarChart3,
  Network,
  Lightbulb,
  FileStack,
  Wand2,
} from "lucide-react";
import {
  coOccurrence,
  coOccurrenceHeatmapOption,
  describeDataset,
  deriveConclusions,
  deriveSuggestions,
  frequencyBarOption,
  frequencyPieOption,
  frequencyTable,
  groupBarOption,
  groupSummary,
  parseJsonRecords,
  pct,
  type InsightSuggestion,
} from "../data/insights";
import {
  cooccurrenceDoc,
  frequencyDoc,
  splitByField,
  summaryReport,
  tasklistByField,
  type GeneratedDoc,
} from "../data/insightsExport";
import {
  isOPFSAvailable,
  uniqueWorkspaceName,
  writeWorkspaceFile,
} from "../storage/workspace";
import { useAppStore } from "../store/useStore";
import { toast } from "../store/useToastStore";
import { EChart } from "./EChart";
import { t, tPlural } from "../i18n";
import { tRich } from "../i18n/rich";

interface Props {
  source: string;
  meta?: string;
}

type View = "conclusions" | "probability" | "charts" | "cooccur" | "suggest" | "raw";

export default function InsightsBlock({ source, meta }: Props) {
  const parsed = useMemo(() => {
    try {
      return { records: parseJsonRecords(source), error: null as string | null };
    } catch (e) {
      return { records: [], error: (e as Error).message };
    }
  }, [source]);

  const shape = useMemo(() => describeDataset(parsed.records), [parsed.records]);
  const [view, setView] = useState<View>("conclusions");
  const [probField, setProbField] = useState<string>("");
  const [groupField, setGroupField] = useState<string>("");

  const activeProbField =
    probField || shape.arrayFields[0] || shape.groupableFields[0] || "";
  const activeGroupField =
    groupField || shape.groupableFields[0] || shape.arrayFields[0] || "";

  const freq = useMemo(
    () => (activeProbField ? frequencyTable(parsed.records, activeProbField) : null),
    [parsed.records, activeProbField],
  );
  const cooc = useMemo(
    () =>
      activeProbField && shape.arrayFields.includes(activeProbField)
        ? coOccurrence(parsed.records, activeProbField, 12)
        : null,
    [parsed.records, activeProbField, shape.arrayFields],
  );
  const groups = useMemo(
    () => (activeGroupField ? groupSummary(parsed.records, activeGroupField) : []),
    [parsed.records, activeGroupField],
  );
  const conclusions = useMemo(
    () => deriveConclusions(parsed.records, shape),
    [parsed.records, shape],
  );
  const suggestions = useMemo(() => deriveSuggestions(shape), [shape]);
  const titleMatch = meta?.match(/title=["']([^"']+)["']/);

  if (parsed.error) {
    return (
      <ErrorCard message={t("block.insights.parseError", { error: parsed.error })} />
    );
  }
  if (parsed.records.length === 0) {
    return (
      <ErrorCard message={t("block.insights.empty")} />
    );
  }

  return (
    <div className="chart-block insights-block">
      <div className="chart-block-header">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Sparkles size={13} style={{ opacity: 0.7 }} />
          {titleMatch?.[1] ??
            t("block.insights.header", { records: parsed.records.length, fields: shape.fields.length })}
        </span>
        <div className="chart-block-tabs" role="tablist">
          <ViewTab view={view} target="conclusions" set={setView} icon={<Lightbulb size={12} />} label={t("block.insights.tab.conclusions")} />
          <ViewTab view={view} target="probability" set={setView} icon={<Table2 size={12} />} label={t("block.insights.tab.probabilities")} />
          <ViewTab view={view} target="charts" set={setView} icon={<BarChart3 size={12} />} label={t("block.insights.tab.charts")} />
          {shape.arrayFields.length > 0 && (
            <ViewTab view={view} target="cooccur" set={setView} icon={<Network size={12} />} label={t("block.insights.tab.cooccur")} />
          )}
          <ViewTab view={view} target="suggest" set={setView} icon={<Wand2 size={12} />} label={t("block.insights.tab.suggestions")} />
          <ViewTab view={view} target="raw" set={setView} icon={<FileStack size={12} />} label={t("block.insights.tab.records")} />
        </div>
      </div>

      <FieldPickers
        view={view}
        shape={shape}
        probField={activeProbField}
        groupField={activeGroupField}
        setProbField={setProbField}
        setGroupField={setGroupField}
      />

      {view === "conclusions" && (
        <Conclusions list={conclusions} />
      )}
      {view === "probability" && freq && (
        <ProbabilityTable freq={freq} />
      )}
      {view === "charts" && (
        <ChartsView
          freqOption={freq ? frequencyBarOption(freq) : null}
          pieOption={freq ? frequencyPieOption(freq) : null}
          groupOption={groups.length > 0 ? groupBarOption(groups) : null}
          probLabel={activeProbField}
          groupLabel={activeGroupField}
        />
      )}
      {view === "cooccur" && cooc && cooc.labels.length > 0 && (
        <div style={{ padding: "0.5rem" }}>
          <EChart option={coOccurrenceHeatmapOption(cooc)} height={420} />
        </div>
      )}
      {view === "cooccur" && (!cooc || cooc.labels.length === 0) && (
        <Empty message={t("block.insights.pickArrayField")} />
      )}
      {view === "suggest" && (
        <SuggestionsList records={parsed.records} suggestions={suggestions} />
      )}
      {view === "raw" && (
        <RawRecords records={parsed.records} fields={shape.fields} />
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────

function ViewTab({
  view,
  target,
  set,
  icon,
  label,
}: {
  view: View;
  target: View;
  set: (v: View) => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={view === target}
      className={`chart-block-tab ${view === target ? "active" : ""}`}
      onClick={() => set(target)}
    >
      <span style={{ display: "inline", marginRight: 4 }}>{icon}</span>
      {label}
    </button>
  );
}

function FieldPickers({
  view,
  shape,
  probField,
  groupField,
  setProbField,
  setGroupField,
}: {
  view: View;
  shape: ReturnType<typeof describeDataset>;
  probField: string;
  groupField: string;
  setProbField: (s: string) => void;
  setGroupField: (s: string) => void;
}) {
  if (view !== "probability" && view !== "charts" && view !== "cooccur") return null;
  const probOptions = view === "cooccur" ? shape.arrayFields : shape.fields;
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        flexWrap: "wrap",
        padding: "0.5rem 0.85rem",
        borderBottom: "1px solid hsl(var(--border))",
        background: "hsl(var(--bg-subtle))",
        fontSize: 12,
        color: "hsl(var(--fg-muted))",
        alignItems: "center",
      }}
    >
      <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
        {t("block.insights.field")}
        <select
          value={probField}
          onChange={(e) => setProbField(e.target.value)}
          style={selectStyle}
          aria-label={t("block.insights.probabilityField")}
        >
          {probOptions.map((f) => (
            <option key={f} value={f}>
              {f}
              {shape.arrayFields.includes(f) ? `  ${t("block.insights.arrayTag")}` : ""}
            </option>
          ))}
        </select>
      </label>
      {view === "charts" && shape.groupableFields.length > 0 && (
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          {t("block.insights.groupBy")}
          <select
            value={groupField}
            onChange={(e) => setGroupField(e.target.value)}
            style={selectStyle}
            aria-label={t("block.insights.groupField")}
          >
            {shape.groupableFields.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  background: "hsl(var(--bg))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 4,
  color: "hsl(var(--fg))",
  fontSize: 12,
  padding: "2px 6px",
};

function Conclusions({ list }: { list: ReturnType<typeof deriveConclusions> }) {
  return (
    <ul style={{ padding: "0.85rem 1.25rem", margin: 0, lineHeight: 1.6 }}>
      {list.map((c) => (
        <li key={c.id} style={{ marginBottom: 8 }}>
          <strong>{c.headline}</strong>
          {c.detail && (
            <div style={{ color: "hsl(var(--fg-muted))", fontSize: 13 }}>
              {c.detail}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function ProbabilityTable({ freq }: { freq: ReturnType<typeof frequencyTable> }) {
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>{t("block.insights.col.value")}</th>
            <th className="num">{t("block.insights.col.count")}</th>
            <th className="num">{t("block.insights.col.probability")}</th>
            <th className="num">{t("block.insights.col.bar")}</th>
          </tr>
        </thead>
        <tbody>
          {freq.entries.map((e) => {
            const max = freq.entries[0]?.count ?? 1;
            const w = max === 0 ? 0 : Math.round((e.count / max) * 120);
            return (
              <tr key={e.value}>
                <td>{e.value}</td>
                <td className="num">{e.count}</td>
                <td className="num">{pct(e.probability)}</td>
                <td className="num" style={{ width: 130 }}>
                  <div
                    style={{
                      width: w,
                      height: 8,
                      background: "linear-gradient(90deg,#7c5cff,#22d3ee)",
                      borderRadius: 4,
                    }}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div
        style={{
          padding: "0.5rem 0.85rem",
          fontSize: 12,
          color: "hsl(var(--fg-muted))",
          borderTop: "1px solid hsl(var(--border))",
        }}
      >
        {tRich("block.insights.freqSummary", { field: <code>{freq.field}</code>, total: freq.total, distinct: freq.entries.length })}
      </div>
    </div>
  );
}

function ChartsView({
  freqOption,
  pieOption,
  groupOption,
  probLabel,
  groupLabel,
}: {
  freqOption: Record<string, unknown> | null;
  pieOption: Record<string, unknown> | null;
  groupOption: Record<string, unknown> | null;
  probLabel: string;
  groupLabel: string;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: "0.5rem" }}>
      {freqOption && (
        <div>
          <Caption text={`Bar · ${probLabel}`} />
          <EChart option={freqOption} height={300} />
        </div>
      )}
      {pieOption && (
        <div>
          <Caption text={`Share · ${probLabel}`} />
          <EChart option={pieOption} height={300} />
        </div>
      )}
      {groupOption && (
        <div style={{ gridColumn: "1 / -1" }}>
          <Caption text={`Per-group · ${groupLabel}`} />
          <EChart option={groupOption} height={260} />
        </div>
      )}
      {!freqOption && !groupOption && (
        <Empty message={t("block.insights.pickField")} />
      )}
    </div>
  );
}

function Caption({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: "hsl(var(--fg-muted))",
        padding: "4px 4px 0",
      }}
    >
      {text}
    </div>
  );
}

function SuggestionsList({
  records,
  suggestions,
}: {
  records: ReturnType<typeof parseJsonRecords>;
  suggestions: InsightSuggestion[];
}) {
  const openTab = useAppStore((s) => s.openTab);
  const opfs = isOPFSAvailable();

  async function applySuggestion(s: InsightSuggestion) {
    let docs: GeneratedDoc[] = [];
    try {
      switch (s.kind) {
        case "split-by-field":
          if (s.field) docs = splitByField(records, s.field);
          break;
        case "tasklist-by-field":
          if (s.field) docs = tasklistByField(records, s.field);
          break;
        case "summary-report":
          docs = [summaryReport(records)];
          break;
        case "frequency-doc":
          if (s.field) docs = [frequencyDoc(records, s.field)];
          break;
        case "cooccurrence-doc":
          if (s.field) docs = [cooccurrenceDoc(records, s.field)];
          break;
      }
    } catch (e) {
      toast.error("Insights generation failed", (e as Error).message);
      return;
    }
    if (docs.length === 0) {
      toast.info("Nothing to generate for that suggestion.");
      return;
    }

    if (!opfs) {
      // No workspace — open the first doc in a tab so the user still gets value.
      const first = docs[0];
      openTab({ name: basename(first.name), content: first.content, workspaceName: null });
      toast.info(
        docs.length === 1
          ? "Opened generated doc in a new tab"
          : `Opened 1 of ${docs.length} generated docs`,
        "Workspace storage isn't available in this browser.",
      );
      return;
    }

    let written = 0;
    let firstWritten: string | null = null;
    for (const d of docs) {
      try {
        const path = await uniqueWorkspaceName(d.name);
        await writeWorkspaceFile(path, d.content);
        if (!firstWritten) firstWritten = path;
        written++;
      } catch (e) {
        toast.error("Insights write failed", (e as Error).message);
        break;
      }
    }
    if (written > 0) {
      window.dispatchEvent(new Event("lumen-workspace-changed"));
      toast.success(
        written === 1 ? `Created ${firstWritten}` : `Created ${written} files`,
        written === 1 ? undefined : "All under insights/ in your workspace.",
      );
      if (firstWritten) {
        openTab({
          name: basename(firstWritten),
          content: docs[0].content,
          workspaceName: firstWritten,
        });
      }
    }
  }

  return (
    <div style={{ padding: "0.5rem" }}>
      {!opfs && (
        <div
          style={{
            margin: "0 0 8px",
            padding: "8px 10px",
            border: "1px solid hsl(var(--border))",
            borderRadius: 6,
            fontSize: 12,
            color: "hsl(var(--fg-muted))",
            background: "hsl(var(--bg-subtle))",
          }}
        >
          {t("block.insights.noWorkspace")}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 8 }}>
        {suggestions.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => applySuggestion(s)}
            style={{
              textAlign: "left",
              padding: 12,
              border: "1px solid hsl(var(--border))",
              borderRadius: 8,
              background: "hsl(var(--bg-subtle))",
              color: "hsl(var(--fg))",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 13 }}>{s.title}</span>
            <span style={{ fontSize: 12, color: "hsl(var(--fg-muted))" }}>
              {s.description}
            </span>
            {s.estCount && (
              <span style={{ fontSize: 11, color: "hsl(var(--accent))" }}>
                {tPlural("block.insights.estFiles", s.estCount)}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function RawRecords({
  records,
  fields,
}: {
  records: ReturnType<typeof parseJsonRecords>;
  fields: string[];
}) {
  const cap = 200;
  const visible = records.slice(0, cap);
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {fields.map((f) => (
              <th key={f} style={{ textAlign: "left" }}>
                {f}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((r, i) => (
            <tr key={i}>
              {fields.map((f) => (
                <td key={f}>{formatCell(r[f])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {records.length > cap && (
        <div
          style={{
            padding: "0.5rem 0.85rem",
            fontSize: 12,
            color: "hsl(var(--fg-muted))",
            borderTop: "1px solid hsl(var(--border))",
          }}
        >
          {t("block.insights.showing", { shown: cap, total: records.length })}
        </div>
      )}
    </div>
  );
}

// Returns a plain string. Always rendered through React's standard text
// path (`{formatCell(...)}`), which auto-escapes any HTML in the value —
// so user-supplied `<script>` payloads can't execute. If anyone ever
// pipes the result into `dangerouslySetInnerHTML`, sanitize first.
function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function Empty({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: "1.5rem",
        textAlign: "center",
        color: "hsl(var(--fg-muted))",
        fontSize: 13,
      }}
    >
      {message}
    </div>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div className="chart-block" style={{ padding: "1rem" }}>
      <div style={{ color: "hsl(0 80% 60%)", fontSize: 13 }}>⚠︎ {message}</div>
    </div>
  );
}
