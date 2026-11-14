import { useMemo, useState } from "react";
import { parseJSONTable } from "../data/csv";
import type { DataSet } from "../data/csv";
import { suggestCharts, type ChartSuggestion } from "../data/suggest";
import { DataTable } from "./DataTable";
import { ChartSuggestions } from "./ChartSuggestions";
import { Table2, BarChart3, Sparkles, RefreshCw } from "lucide-react";
import { useFetchSource } from "./useFetchSource";
import { t } from "../i18n";

interface Props {
  source: string;
  meta?: string;
}

export default function JsonTableBlock({ source, meta }: Props) {
  const { effectiveSource, loading: fetching, error: fetchError, url, remote, refetch } =
    useFetchSource(source, meta);
  const result = useMemo<{ data: DataSet | null; error?: string }>(() => {
    try {
      return { data: parseJSONTable(effectiveSource) };
    } catch (e) {
      return { data: null, error: (e as Error).message };
    }
  }, [effectiveSource]);

  const suggestions = useMemo<ChartSuggestion[]>(
    () => (result.data ? suggestCharts(result.data) : []),
    [result.data],
  );

  const [view, setView] = useState<"table" | "chart">("table");

  if (fetchError) {
    return (
      <div className="chart-block" style={{ padding: "1rem" }}>
        <div style={{ color: "hsl(0 80% 60%)", fontSize: 13 }}>
          {t("block.json.fetchFailed", { error: fetchError })}
        </div>
      </div>
    );
  }
  if (!result.data) {
    return (
      <div className="chart-block" style={{ padding: "1rem" }}>
        <div style={{ color: "hsl(0 80% 60%)", fontSize: 13 }}>
          {t("block.json.parseError", { error: result.error ?? t("block.common.unknown") })}
        </div>
      </div>
    );
  }

  const data = result.data;
  const titleMatch = meta?.match(/title=["']([^"']+)["']/);

  return (
    <div className="chart-block">
      <div className="chart-block-header">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Sparkles size={13} style={{ opacity: 0.7 }} />
          {titleMatch?.[1] ??
            t("block.data.summary", { lang: "JSON", rows: data.rows.length, cols: data.columns.length })}
          {remote && (
            <span style={{ fontSize: 10, color: "hsl(var(--accent))", marginInlineStart: 4 }}>
              {t("block.common.live")}
            </span>
          )}
          {url && (
            <button
              type="button"
              onClick={refetch}
              title={t("block.common.refetchUrl", { url })}
              style={{
                marginInlineStart: 4,
                border: "none",
                background: "transparent",
                color: "hsl(var(--fg-muted))",
                cursor: fetching ? "wait" : "pointer",
                padding: 2,
                borderRadius: 6,
              }}
              disabled={fetching}
              aria-label={t("block.json.refetch")}
            >
              <RefreshCw
                size={11}
                style={{ animation: fetching ? "spin 1s linear infinite" : "none" }}
              />
            </button>
          )}
        </span>
        <div className="chart-block-tabs">
          <button
            className={`chart-block-tab ${view === "table" ? "active" : ""}`}
            onClick={() => setView("table")}
          >
            <Table2 size={12} style={{ display: "inline", marginRight: 4 }} />
            {t("block.data.table")}
          </button>
          {suggestions.length > 0 && (
            <button
              className={`chart-block-tab ${view === "chart" ? "active" : ""}`}
              onClick={() => setView("chart")}
            >
              <BarChart3 size={12} style={{ display: "inline", marginRight: 4 }} />
              {t("block.data.chart")}
            </button>
          )}
        </div>
      </div>
      {view === "table" && <DataTable data={data} />}
      {view === "chart" && suggestions.length > 0 && (
        <ChartSuggestions suggestions={suggestions} />
      )}
    </div>
  );
}
