/**
 * CodeDoctorBlock — fence ```code-doctor (or ```fix-json) that takes
 * potentially malformed JSON / JSONL, surfaces structural diagnostics
 * with span info, and lets the user apply repairs one-by-one or all at
 * once. The repaired output is rendered inline as a json-table when it
 * parses cleanly, so the user can verify the fix without leaving the
 * block.
 *
 * Engine lives in `src/data/codeDoctor.ts` — pure, tested separately.
 * This file is UI plumbing only.
 */

import { useMemo, useState, type ReactNode } from "react";
import {
  Stethoscope,
  AlertTriangle,
  CheckCircle2,
  Wand2,
  Copy as CopyIcon,
  FileCode,
  ArrowRightLeft,
} from "lucide-react";
import {
  diagnoseJson,
  diagnoseJsonl,
  isAllScalarRecordList,
  repairJson,
  type Diagnostic,
  type RepairResult,
  type SourceSpan,
} from "../data/codeDoctor";
import { parseJSONTable } from "../data/csv";
import { DataTable } from "./DataTable";
import { toast } from "../store/useToastStore";
import { t, tPlural } from "../i18n";
import { tRich } from "../i18n/rich";

interface Props {
  source: string;
  meta?: string;
}

type View = "diagnose" | "repaired" | "compare";

export default function CodeDoctorBlock({ source, meta }: Props) {
  // Trim leading/trailing whitespace for analysis but preserve original
  // for display so byte-offsets stay meaningful.
  const original = source ?? "";
  const isJsonl = useMemo(() => detectJsonlShape(original), [original]);

  const docDiagnostics = useMemo<Diagnostic[]>(
    () => (isJsonl ? gatherJsonlDiagnostics(original) : diagnoseJson(original)),
    [original, isJsonl],
  );
  const repair: RepairResult = useMemo(
    () => (isJsonl ? repairJsonlDoc(original) : repairJson(original)),
    [original, isJsonl],
  );
  const titleMatch = meta?.match(/title=["']([^"']+)["']/);
  const [view, setView] = useState<View>(repair.parses ? "repaired" : "diagnose");

  const dataTable = useMemo(() => {
    if (!repair.parses) return null;
    // Only build a table preview when the parsed value is an array of
    // plain objects whose values are ALL scalar (string / number /
    // boolean / null). Skipping arrays-of-objects-with-array-values
    // matters because parseJSONTable's inferType stringifies values
    // like [1,2,3] to "1,2,3" and then Date.parse can return a real
    // number on some engines — so an `items` column of arrays gets
    // typed as DATE. Surfacing the raw repaired text alone is more
    // honest than a misleadingly-typed table.
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        repair.output.startsWith("[")
          ? repair.output
          : "[" + jsonlToArrayInner(repair.output) + "]",
      );
    } catch {
      return null;
    }
    // Centralized predicate (see codeDoctor.ts) — kept testable and
    // reusable. Skips arrays of non-objects, mixed shapes, and any
    // record with an array-typed value.
    if (!isAllScalarRecordList(parsed)) return null;
    try {
      return parseJSONTable(JSON.stringify(parsed));
    } catch {
      return null;
    }
  }, [repair.parses, repair.output]);

  return (
    <div className="chart-block code-doctor-block">
      <div className="chart-block-header">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Stethoscope size={13} style={{ opacity: 0.7 }} />
          {titleMatch?.[1] ??
            t("block.codeDoctor.title", { format: isJsonl ? "JSONL" : "JSON" })}
          <StatusPill repair={repair} count={docDiagnostics.length} />
        </span>
        <div className="chart-block-tabs" role="tablist">
          <ViewTab view={view} target="diagnose" set={setView} icon={<AlertTriangle size={12} />} label={t("block.codeDoctor.view.diagnose")} />
          <ViewTab view={view} target="repaired" set={setView} icon={<Wand2 size={12} />} label={t("block.codeDoctor.view.repaired")} />
          <ViewTab view={view} target="compare" set={setView} icon={<ArrowRightLeft size={12} />} label={t("block.codeDoctor.view.compare")} />
        </div>
      </div>
      {view === "diagnose" && (
        <DiagnosePanel
          original={original}
          diagnostics={docDiagnostics}
          repairOutput={repair.output}
        />
      )}
      {view === "repaired" && (
        <RepairedPanel
          repair={repair}
          dataTable={dataTable}
        />
      )}
      {view === "compare" && (
        <ComparePanel original={original} repaired={repair.output} />
      )}
    </div>
  );
}

// ── Sub-views ───────────────────────────────────────────────────────

function StatusPill({
  repair,
  count,
}: {
  repair: RepairResult;
  count: number;
}) {
  if (repair.parses && count === 0 && repair.patches.length === 0) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          color: "hsl(140 60% 60%)",
          fontSize: 11,
          marginInlineStart: 4,
        }}
      >
        <CheckCircle2 size={11} /> {t("block.codeDoctor.clean")}
      </span>
    );
  }
  if (repair.parses) {
    return (
      <span
        style={{
          color: "hsl(140 60% 60%)",
          fontSize: 11,
          marginInlineStart: 4,
        }}
      >
        {tPlural("block.codeDoctor.fixesReady", repair.patches.length)}
      </span>
    );
  }
  return (
    <span
      style={{
        color: "hsl(0 80% 65%)",
        fontSize: 11,
        marginInlineStart: 4,
      }}
    >
      {tPlural("block.codeDoctor.partial", count)}
    </span>
  );
}

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
      {icon}
      {label}
    </button>
  );
}

function DiagnosePanel({
  original,
  diagnostics,
  repairOutput,
}: {
  original: string;
  diagnostics: Diagnostic[];
  repairOutput: string;
}) {
  if (diagnostics.length === 0) {
    return (
      <div
        style={{
          padding: "1rem",
          color: "hsl(var(--fg-muted))",
          fontSize: 13,
        }}
      >
        {t("block.codeDoctor.noIssues")}
      </div>
    );
  }
  // Group diagnostics by code so the user sees a tidy summary first.
  const grouped = new Map<string, Diagnostic[]>();
  for (const d of diagnostics) {
    const arr = grouped.get(d.code) ?? [];
    arr.push(d);
    grouped.set(d.code, arr);
  }
  return (
    <div style={{ padding: "0.75rem" }}>
      <table className="data-table" style={{ marginBottom: 8 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>{t("block.codeDoctor.col.issue")}</th>
            <th className="num">{t("block.codeDoctor.col.count")}</th>
            <th>{t("block.codeDoctor.col.confidence")}</th>
            <th style={{ textAlign: "left" }}>{t("block.codeDoctor.col.example")}</th>
          </tr>
        </thead>
        <tbody>
          {[...grouped.entries()].map(([code, list]) => (
            <tr key={code}>
              <td>
                <code style={{ fontSize: 12 }}>{code}</code>
              </td>
              <td className="num">{list.length}</td>
              <td>
                <ConfidenceChip c={list[0].confidence} />
              </td>
              <td style={{ fontSize: 12, color: "hsl(var(--fg-muted))" }}>
                {snippetAt(original, list[0].span)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <details>
        <summary
          style={{
            cursor: "pointer",
            fontSize: 12,
            color: "hsl(var(--fg-muted))",
          }}
        >
          {t("block.codeDoctor.diagnostics", { n: diagnostics.length })}
        </summary>
        <ul
          style={{
            margin: "8px 0 0",
            padding: "0 0 0 1rem",
            fontSize: 12,
            color: "hsl(var(--fg-muted))",
            lineHeight: 1.6,
          }}
        >
          {diagnostics.map((d, i) => (
            <li key={i}>
              <code>{d.code}</code> {t("block.codeDoctor.charRange", { start: d.span.start, end: d.span.end, message: d.message })}
            </li>
          ))}
        </ul>
      </details>
      {repairOutput !== original && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            border: "1px solid hsl(var(--border))",
            borderRadius: 6,
            background: "hsl(var(--bg-subtle))",
            fontSize: 12,
            color: "hsl(var(--fg-muted))",
          }}
        >
          {tRich("block.codeDoctor.switchHint", { tab: <strong>{t("block.codeDoctor.view.repaired")}</strong> })}
        </div>
      )}
    </div>
  );
}

function RepairedPanel({
  repair,
  dataTable,
}: {
  repair: RepairResult;
  dataTable: ReturnType<typeof parseJSONTable> | null;
}) {
  const onCopy = () => {
    navigator.clipboard?.writeText(repair.output).then(
      () => toast.success("Repaired JSON copied to clipboard."),
      () => toast.error("Could not copy to clipboard."),
    );
  };
  return (
    <div style={{ padding: "0.75rem" }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        {repair.parses ? (
          <span
            style={{
              display: "inline-flex",
              gap: 4,
              alignItems: "center",
              color: "hsl(140 60% 60%)",
              fontSize: 12,
            }}
          >
            <CheckCircle2 size={13} /> {tPlural("block.codeDoctor.parsesCleanly", repair.patches.length)}
          </span>
        ) : (
          <span
            style={{
              display: "inline-flex",
              gap: 4,
              alignItems: "center",
              color: "hsl(40 90% 60%)",
              fontSize: 12,
            }}
          >
            <AlertTriangle size={13} /> {tPlural("block.codeDoctor.bestEffort", repair.remaining.length)}
          </span>
        )}
        <button
          type="button"
          onClick={onCopy}
          style={{
            marginInlineStart: "auto",
            padding: "4px 8px",
            border: "1px solid hsl(var(--border))",
            borderRadius: 4,
            background: "hsl(var(--bg-subtle))",
            color: "hsl(var(--fg))",
            cursor: "pointer",
            fontSize: 12,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <CopyIcon size={12} /> {t("block.common.copy")}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: 10,
          background: "hsl(var(--bg-inset))",
          border: "1px solid hsl(var(--border))",
          borderRadius: 4,
          overflow: "auto",
          fontSize: 12,
          maxHeight: 320,
        }}
      >
        <code>{repair.output}</code>
      </pre>
      {dataTable && (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              fontSize: 12,
              color: "hsl(var(--fg-muted))",
              marginBottom: 4,
            }}
          >
            <FileCode size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
            {t("block.codeDoctor.repairedTable")}
          </div>
          <DataTable data={dataTable} />
        </div>
      )}
    </div>
  );
}

function ComparePanel({
  original,
  repaired,
}: {
  original: string;
  repaired: string;
}) {
  if (original === repaired) {
    return (
      <div
        style={{
          padding: "1rem",
          color: "hsl(var(--fg-muted))",
          fontSize: 13,
        }}
      >
        {t("block.codeDoctor.identical")}
      </div>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 8,
        padding: "0.75rem",
      }}
    >
      <div>
        <div style={Caption}>{t("block.codeDoctor.original")}</div>
        <pre style={CodePane}>
          <code>{original}</code>
        </pre>
      </div>
      <div>
        <div style={Caption}>{t("block.codeDoctor.view.repaired")}</div>
        <pre style={CodePane}>
          <code>{repaired}</code>
        </pre>
      </div>
    </div>
  );
}

const Caption: React.CSSProperties = {
  fontSize: 12,
  color: "hsl(var(--fg-muted))",
  marginBottom: 4,
};
const CodePane: React.CSSProperties = {
  margin: 0,
  padding: 10,
  background: "hsl(var(--bg-inset))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 4,
  overflow: "auto",
  fontSize: 12,
  maxHeight: 360,
  whiteSpace: "pre-wrap",
};

function ConfidenceChip({ c }: { c: Diagnostic["confidence"] }) {
  const color =
    c === "high"
      ? "hsl(140 60% 60%)"
      : c === "medium"
        ? "hsl(40 90% 60%)"
        : "hsl(0 80% 65%)";
  return (
    <span
      style={{
        fontSize: 11,
        color,
        border: `1px solid ${color}`,
        borderRadius: 4,
        padding: "1px 6px",
        textTransform: "capitalize",
      }}
    >
      {c}
    </span>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function snippetAt(text: string, span: SourceSpan): string {
  const slice = text.slice(span.start, Math.min(span.end + 8, text.length));
  return JSON.stringify(slice).slice(0, 60);
}

function detectJsonlShape(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith("[")) return false;
  // Multiple non-blank lines, each starting with `{` → likely JSONL.
  const lines = t.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return false;
  return lines.every((l) => l.trim().startsWith("{"));
}

function gatherJsonlDiagnostics(text: string): Diagnostic[] {
  const lines = diagnoseJsonl(text);
  return lines.flatMap((l) => l.diagnostics);
}

/**
 * Concatenate JSONL into a JSON-array body (without surrounding `[]`)
 * so the caller can wrap it for parseJSONTable. Drops blank lines and
 * places commas between values.
 */
function jsonlToArrayInner(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .join(",\n");
}

/**
 * Run repairJson on the whole JSONL document by repairing each line
 * independently, then concatenating. Useful when ~one line is broken
 * and we don't want a global pass to mangle the rest.
 */
function repairJsonlDoc(text: string): RepairResult {
  const out: string[] = [];
  let allParse = true;
  let combinedPatches: RepairResult["patches"] = [];
  let lineOffset = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) {
      out.push(raw);
      lineOffset += raw.length + 1;
      continue;
    }
    const r = repairJson(raw);
    out.push(r.output);
    if (!r.parses) allParse = false;
    for (const p of r.patches) {
      combinedPatches.push({
        ...p,
        span: {
          start: lineOffset + p.span.start,
          end: lineOffset + p.span.end,
        },
      });
    }
    lineOffset += raw.length + 1;
  }
  const joined = out.join("\n");
  return {
    output: joined,
    patches: combinedPatches,
    remaining: allParse ? [] : gatherJsonlDiagnostics(joined),
    parses: allParse,
  };
}
