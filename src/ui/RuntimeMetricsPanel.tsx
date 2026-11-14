import { useEffect, useMemo, useState } from "react";
import type { VitalName, VitalsSample } from "../lib/webVitals";
import { RefreshCw, Eraser, X } from "lucide-react";
import { clearRuntimeMetrics, getRuntimeMetricsSnapshot, type RuntimeMetricSnapshotRow } from "../lib/runtimeMetrics";
import { t, getLocale } from "../i18n";
import { showAiToast } from "./AiToast";

interface Props {
  onClose: () => void;
}

type ViewMode = "categories" | "operations";

function shortNumber(value: number): string {
  return value.toLocaleString(getLocale());
}

function shortPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatDate(time: number): string {
  if (!time) return "—";
  return new Date(time).toLocaleString(getLocale());
}

function renderRow(row: RuntimeMetricSnapshotRow) {
  return (
    <tr key={row.label}>
      <td style={{ padding: "8px 10px", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }}>{row.label}</td>
      <td style={{ padding: "8px 10px" }}>{shortNumber(row.total)}</td>
      <td style={{ padding: "8px 10px" }}>{shortPercent(row.successRate)}</td>
      <td style={{ padding: "8px 10px" }}>{shortPercent(row.retryRatio * 100)}</td>
      <td style={{ padding: "8px 10px" }}>{shortNumber(row.avgMs)}ms</td>
      <td style={{ padding: "8px 10px" }}>{shortNumber(row.p95Ms)}ms</td>
      <td style={{ padding: "8px 10px" }}>{shortNumber(row.totalRetries)}</td>
      <td style={{ padding: "8px 10px" }}>{shortPercent(row.timeoutRate * 100)}</td>
      <td style={{ padding: "8px 10px" }}>{shortPercent(row.rateLimitRate * 100)}</td>
    </tr>
  );
}

const RATING_COLOR: Record<VitalsSample["rating"], string> = {
  good: "hsl(140 60% 40%)",
  "needs-improvement": "hsl(35 90% 45%)",
  poor: "hsl(0 70% 50%)",
};

/**
 * This session's Web Vitals (plan 12.4) — measured on this device and never
 * sent. The module loads lazily, like its observers in main.tsx.
 */
function LocalVitals() {
  const [state, setState] = useState<{ names: readonly VitalName[]; latest: Partial<Record<VitalName, VitalsSample>> } | null>(null);
  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    void import("../lib/webVitals")
      .then((m) => {
        if (!alive) return;
        const read = () => setState({ names: m.VITAL_NAMES, latest: m.vitalsSnapshot() });
        read();
        off = m.subscribeVitals(read);
      })
      .catch(() => {
        /* why: chunk failed to load — the section stays empty */
      });
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  if (!state) return null;
  return (
    <div data-testid="local-vitals" style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", alignItems: "baseline" }}>
      <strong style={{ fontWeight: 600, color: "hsl(var(--fg))" }}>{t("runtimeMetrics.vitals")}</strong>
      {state.names.map((name) => {
        const s = state.latest[name];
        const value = !s ? "—" : name === "CLS" ? s.value.toFixed(3) : `${shortNumber(Math.round(s.value))}ms`;
        return (
          <span key={name} data-vital={name} data-rating={s?.rating ?? "none"}>
            {name}: <bdi dir="ltr" style={{ color: s ? RATING_COLOR[s.rating] : undefined, fontWeight: 600 }}>{value}</bdi>
          </span>
        );
      })}
    </div>
  );
}

export function RuntimeMetricsPanel({ onClose }: Props) {
  const [tick, setTick] = useState(0);
  const [mode, setMode] = useState<ViewMode>("categories");
  const snapshot = useMemo(() => getRuntimeMetricsSnapshot(), [tick]);
  const rows = useMemo(() => {
    const values =
      mode === "categories"
        ? Object.values(snapshot.categories)
        : Object.values(snapshot.operations);
    return values
      .slice()
      .sort((a, b) => b.total - a.total)
      .slice(0, 20);
  }, [mode, snapshot]);

  const hasData = rows.length > 0;
  const totalRequests = useMemo(
    () =>
      Object.values(snapshot.categories).reduce(
        (sum, row) => sum + row.total,
        0,
      ),
    [snapshot],
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        background: "hsl(var(--bg) / 0.72)",
        backdropFilter: "blur(5px)",
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
      onClick={onClose}
    >
      <section
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "min(1080px, 96vw)",
          maxHeight: "84vh",
          borderRadius: 16,
          border: "1px solid hsl(var(--border))",
          background: "hsl(var(--bg))",
          boxShadow: "0 20px 60px hsl(0 0% 0% / 0.35)",
          color: "hsl(var(--fg))",
          overflow: "auto",
          padding: 16,
          fontFamily: "inherit",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 12,
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: 16 }}>{t("runtimeMetrics.title")}</h3>
            <p style={{ margin: "6px 0 0", color: "hsl(var(--fg-muted))", fontSize: 12 }}>
              {t("runtimeMetrics.subtitle")}
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              onClick={() => setMode(mode === "categories" ? "operations" : "categories")}
              style={{
                padding: "7px 10px",
                borderRadius: 8,
                border: "1px solid hsl(var(--border))",
                background: "hsl(var(--bg-subtle))",
                fontSize: 12,
                cursor: "pointer",
                color: "hsl(var(--fg))",
              }}
            >
              {mode === "categories" ? t("runtimeMetrics.section.operations") : t("runtimeMetrics.section.categories")}
            </button>
            <button
              type="button"
              onClick={() => setTick((value) => value + 1)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "7px 10px",
                borderRadius: 8,
                border: "1px solid hsl(var(--border))",
                background: "hsl(var(--bg-subtle))",
                fontSize: 12,
                cursor: "pointer",
                color: "hsl(var(--fg))",
              }}
            >
              <RefreshCw size={13} />
              {t("runtimeMetrics.refresh")}
            </button>
            <button
              type="button"
              onClick={() => {
                clearRuntimeMetrics();
                setTick((value) => value + 1);
                showAiToast(t("runtimeMetrics.cleared"), "success");
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "7px 10px",
                borderRadius: 8,
                border: "1px solid hsl(var(--border))",
                background: "hsl(var(--bg-subtle))",
                fontSize: 12,
                cursor: "pointer",
                color: "hsl(var(--fg))",
              }}
            >
              <Eraser size={13} />
              {t("runtimeMetrics.clear")}
            </button>
            <button
              type="button"
              onClick={onClose}
              title={t("runtimeMetrics.close")}
              style={{
                marginInlineStart: 6,
                padding: "6px",
                width: 32,
                height: 32,
                borderRadius: 8,
                border: "1px solid hsl(var(--border))",
                background: "hsl(var(--bg-subtle))",
                cursor: "pointer",
                color: "hsl(var(--fg-muted))",
              }}
            >
              <X size={15} />
            </button>
          </div>
        </header>
        <section style={{ display: "grid", gap: 10, fontSize: 12.5, color: "hsl(var(--fg-subtle))" }}>
          <LocalVitals />
          <div style={{ display: "flex", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
            <span>{t("runtimeMetrics.totalRequests")}: {shortNumber(totalRequests)}</span>
            <span>{t("runtimeMetrics.lastUpdated")}: {formatDate(snapshot.lastUpdatedAt)}</span>
          </div>
          {hasData ? (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.25 }}>
              <thead>
                <tr style={{ textAlign: "start", color: "hsl(var(--fg-muted))", borderBottom: "1px solid hsl(var(--border))" }}>
                  <th style={{ padding: "8px 10px" }}>{t("runtimeMetrics.column.label")}</th>
                  <th style={{ padding: "8px 10px" }}>{t("runtimeMetrics.column.total")}</th>
                  <th style={{ padding: "8px 10px" }}>{t("runtimeMetrics.column.success")}</th>
                  <th style={{ padding: "8px 10px" }}>{t("runtimeMetrics.column.retries")}</th>
                  <th style={{ padding: "8px 10px" }}>{t("runtimeMetrics.column.avgMs")}</th>
                  <th style={{ padding: "8px 10px" }}>{t("runtimeMetrics.column.p95Ms")}</th>
                  <th style={{ padding: "8px 10px" }}>{t("runtimeMetrics.column.totalRetries")}</th>
                  <th style={{ padding: "8px 10px" }}>{t("runtimeMetrics.column.timeouts")}</th>
                  <th style={{ padding: "8px 10px" }}>{t("runtimeMetrics.column.rateLimits")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(renderRow)}
              </tbody>
            </table>
          ) : (
            <div style={{ color: "hsl(var(--fg-subtle))", padding: "20px 8px" }}>{t("runtimeMetrics.noData")}</div>
          )}
        </section>
      </section>
    </div>
  );
}

