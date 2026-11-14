import { useMemo } from "react";
import YAML from "yaml";
import { RefreshCw } from "lucide-react";
import { EChart } from "./EChart";
import { useFetchSource } from "./useFetchSource";
import { t } from "../i18n";

interface Props {
  source: string;
  meta?: string;
}

function parseSpec(source: string): {
  option: Record<string, unknown> | null;
  error?: string;
} {
  const trimmed = source.trim();
  if (!trimmed) return { option: null, error: "(empty chart spec)" };
  // Try JSON first.
  try {
    const o = JSON.parse(trimmed);
    if (o && typeof o === "object") return { option: o };
  } catch {
    /* why: fall through to YAML */
  }
  try {
    const o = YAML.parse(trimmed);
    if (o && typeof o === "object")
      return { option: o as Record<string, unknown> };
  } catch (e) {
    return { option: null, error: (e as Error).message };
  }
  return { option: null, error: "Could not parse chart spec." };
}

export default function ChartBlock({ source, meta }: Props) {
  const { effectiveSource, loading, error: fetchError, url, remote, refetch } =
    useFetchSource(source, meta);
  const { option, error } = useMemo(
    () => parseSpec(effectiveSource),
    [effectiveSource],
  );
  const heightMatch = meta?.match(/height=(\d+)/);
  const height = heightMatch ? Number(heightMatch[1]) : 360;
  if (fetchError) {
    return (
      <div className="chart-block" style={{ padding: "1rem" }}>
        <div style={{ color: "hsl(0 80% 60%)", fontSize: 13 }}>
          {t("block.chart.fetchFailed", { error: fetchError })}
        </div>
      </div>
    );
  }
  if (!option) {
    return (
      <div className="chart-block" style={{ padding: "1rem" }}>
        <div style={{ color: "hsl(0 80% 60%)", fontSize: 13 }}>
          {t("block.chart.error", { error: error ?? t("block.common.unknown") })}
        </div>
      </div>
    );
  }
  return (
    <div className="chart-block">
      <div className="chart-block-header">
        <span>{t("plugin.chart")}{remote && url ? ` ${t("block.common.live")}` : ""}</span>
        {url && (
          <button
            type="button"
            onClick={refetch}
            title={t("block.common.refetchUrl", { url })}
            style={{
              marginInlineStart: "auto",
              border: "none",
              background: "transparent",
              color: "hsl(var(--fg-muted))",
              cursor: loading ? "wait" : "pointer",
              padding: 4,
              borderRadius: 6,
            }}
            disabled={loading}
            aria-label={t("plugin.chart.refetch")}
          >
            <RefreshCw
              size={13}
              style={{ animation: loading ? "spin 1s linear infinite" : "none" }}
            />
          </button>
        )}
      </div>
      <div style={{ padding: "0.5rem" }}>
        <EChart option={option} height={height} />
      </div>
    </div>
  );
}
