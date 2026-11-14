import { useMemo, useState } from "react";
import { parseCSV } from "../data/csv";
import type { DataSet } from "../data/csv";
import { suggestCharts, type ChartSuggestion } from "../data/suggest";
import { DataTable } from "./DataTable";
import { EChart } from "./EChart";
import { ChartSuggestions } from "./ChartSuggestions";
import { showAiToast } from "../ui/AiToast";
import { Table2, BarChart3, Sparkles, RefreshCw } from "lucide-react";
import { log } from "../lib/logger";
import { useFetchSource } from "./useFetchSource";
import { t } from "../i18n";

interface Props {
  source: string;
  lang: "csv" | "tsv";
  meta?: string;
}

type View = "table" | "chart" | "ai-chart";

export default function CsvBlock({ source, lang, meta }: Props) {
  const { effectiveSource, loading: fetching, error: fetchError, url, remote, refetch } =
    useFetchSource(source, meta);
  const data = useMemo<DataSet | null>(() => {
    try {
      return parseCSV(effectiveSource, lang === "tsv" ? "\t" : undefined);
    } catch {
      return null;
    }
  }, [effectiveSource, lang]);

  const suggestions = useMemo<ChartSuggestion[]>(
    () => (data ? suggestCharts(data) : []),
    [data],
  );

  const [view, setView] = useState<View>(
    suggestions.length > 0 && /\bview=chart\b/i.test(meta ?? "")
      ? "chart"
      : "table",
  );
  const [aiLoading, setAiLoading] = useState(false);
  const [aiOption, setAiOption] = useState<any>(null);

  if (fetchError) {
    return (
      <div className="chart-block" style={{ padding: "1rem" }}>
        <div style={{ color: "hsl(0 80% 60%)", fontSize: 13 }}>
          ⚠︎ {lang.toUpperCase()} fetch failed: {fetchError}
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="chart-block" style={{ padding: "1rem" }}>
        <div style={{ color: "hsl(0 80% 60%)", fontSize: 13 }}>
          ⚠︎ Could not parse {lang.toUpperCase()} data.
        </div>
      </div>
    );
  }

  const titleMatch = meta?.match(/title=["']([^"']+)["']/);

  return (
    <div className="chart-block">
      <div className="chart-block-header">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Sparkles size={13} style={{ opacity: 0.7 }} />
          {titleMatch?.[1] ?? `${lang.toUpperCase()} • ${data.rows.length} rows × ${data.columns.length} cols`}
          {remote && (
            <span style={{ fontSize: 10, color: "hsl(var(--accent))", marginInlineStart: 4 }}>
              · live
            </span>
          )}
          {url && (
            <button
              type="button"
              onClick={refetch}
              title={`Refetch ${url}`}
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
              aria-label="Refetch CSV data"
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
            Table
          </button>
          {suggestions.length > 0 && (
            <button
              className={`chart-block-tab ${view === "chart" ? "active" : ""}`}
              onClick={() => setView("chart")}
            >
              <BarChart3 size={12} style={{ display: "inline", marginRight: 4 }} />
              Chart
            </button>
          )}
          <button
            className={`chart-block-tab ${view === "ai-chart" ? "active" : ""}`}
            onClick={async () => {
              setView("ai-chart");
              if (aiOption || aiLoading) return;
              setAiLoading(true);
              const { aiOperation, isAbort } = await import("../ai/aiAbort");
              const op = aiOperation(); // Esc / "AI: Cancel" stops chart generation
              try {
                // The same charter agent as "AI: Chart": schema-checked, retried by the improvement agent.
                const { runAgentOrThrow } = await import("../agents/runtime");
                const { charterAgent } = await import("../agents/defs");
                const option = await runAgentOrThrow(charterAgent, { text: source }, { document: source, ownPrompt: true, signal: op.signal });
                if (!op.signal.aborted) setAiOption(option);
              } catch (e) {
                setAiOption(null);
                if (isAbort(e)) {
                  setView("table"); // why: cancelled — leave the empty AI tab
                  return;
                }
                log.error("AI chart generation failed", e);
                showAiToast(t("toast.aiChartGenerationFailed"), "error");
              } finally {
                op.end();
                setAiLoading(false);
              }
            }}
          >
            <Sparkles size={12} style={{ display: "inline", marginRight: 4 }} />
            AI Chart
          </button>
        </div>
      </div>

      {view === "table" && <DataTable data={data} />}

      {view === "chart" && suggestions.length > 0 && (
        <ChartSuggestions suggestions={suggestions} />
      )}

      {view === "ai-chart" && (
        <div style={{ padding: "0.5rem" }}>
          {aiLoading ? (
            <div style={{ color: "hsl(var(--fg-muted))", fontSize: 13 }}>
              🤖 Generating AI visualization...
            </div>
          ) : aiOption ? (
            <EChart option={aiOption} height={360} />
          ) : (
            <div style={{ color: "hsl(var(--fg-muted))", fontSize: 13 }}>
              No AI visualization available.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

