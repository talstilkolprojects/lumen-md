/**
 * The ECharts option builders of the chart-suggestion engine (split out of
 * suggest.ts, plan W4.11): one per chart kind, each from the column profiles.
 */
import type { DataSet } from "./csv";
import { t } from "../i18n";
import type { ChartKind, MapMarkerSpec, ChartSuggestion, ColumnProfile } from "./suggestTypes";
import { parseLooseNumber, timeKey } from "./columnProfile";

// ── Helpers ────────────────────────────────────────────────────────────

const PALETTE = [
  "#7c5cff",
  "#22d3ee",
  "#f472b6",
  "#facc15",
  "#34d399",
  "#fb923c",
  "#60a5fa",
  "#a78bfa",
  "#f87171",
  "#2dd4bf",
];

const AXIS_LABEL = { color: "#9aa3b2" };
const AXIS_LINE = { lineStyle: { color: "#3a3f4b" } };
const SPLIT_LINE = { lineStyle: { color: "#2a2f3a" } };

function baseOption(): Record<string, unknown> {
  return {
    color: PALETTE,
    grid: { left: 50, right: 24, top: 36, bottom: 40, containLabel: true },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: { top: 6, textStyle: { color: "#9aa3b2" } },
    textStyle: { fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
  };
}

function num(row: Record<string, unknown>, p: ColumnProfile): number | null {
  return parseLooseNumber(row[p.key]);
}

export function catKey(row: Record<string, unknown>, p: ColumnProfile): string {
  const v = row[p.key];
  return v === null || v === undefined || v === "" ? "—" : String(v);
}

export function fmtNum(n: number): string {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e6 || abs < 1e-3) return n.toExponential(2);
  return String(Number(n.toPrecision(4)));
}

function names(ps: ColumnProfile[]): string {
  return ps.map((p) => p.name).join(", ");
}

/** Percentages are averaged when a category repeats; everything else sums. */
export function aggregate(
  rows: DataSet["rows"],
  keyOf: (r: Record<string, unknown>) => string,
  measures: ColumnProfile[],
): Map<string, number[]> {
  const acc = new Map<string, { sum: number[]; n: number[] }>();
  for (const r of rows) {
    const k = keyOf(r);
    let a = acc.get(k);
    if (!a) {
      a = { sum: measures.map(() => 0), n: measures.map(() => 0) };
      acc.set(k, a);
    }
    measures.forEach((m, i) => {
      const v = num(r, m);
      if (v === null) return;
      a!.sum[i] += v;
      a!.n[i] += 1;
    });
  }
  const out = new Map<string, number[]>();
  for (const [k, a] of acc) {
    out.set(
      k,
      measures.map((m, i) => (m.semantic === "percent" && a.n[i] > 0 ? a.sum[i] / a.n[i] : a.sum[i])),
    );
  }
  return out;
}

export function pairs(rows: DataSet["rows"], x: ColumnProfile, y: ColumnProfile): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const r of rows) {
    const a = num(r, x);
    const b = num(r, y);
    if (a !== null && b !== null) out.push([a, b]);
  }
  return out;
}

// ── Builders ───────────────────────────────────────────────────────────

function timeLabel(raw: unknown, p: ColumnProfile): string {
  if (p.timeFormat === "date" && typeof raw === "number") {
    const iso = new Date(raw).toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
  }
  return String(raw);
}

export function buildLine(
  ds: DataSet,
  x: ColumnProfile,
  ys: ColumnProfile[],
  by?: ColumnProfile,
): ChartSuggestion {
  // Order the axis by the time key, aggregating duplicate timestamps.
  const keyed = new Map<string, number>();
  for (const r of ds.rows) {
    const raw = r[x.key];
    if (raw === null || raw === undefined || raw === "") continue;
    const k = timeKey(raw, x.timeFormat ?? "date");
    if (k === null) continue;
    keyed.set(timeLabel(raw, x), k);
  }
  const labels = [...keyed.entries()].sort((a, b) => a[1] - b[1]).map(([l]) => l);
  const xKey = (r: Record<string, unknown>) => timeLabel(r[x.key], x);

  let series: Array<Record<string, unknown>>;
  if (by) {
    const groups = new Map<string, DataSet["rows"]>();
    for (const r of ds.rows) {
      const g = catKey(r, by);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(r);
    }
    series = [...groups.entries()].map(([g, rows]) => {
      const agg = aggregate(rows, xKey, ys);
      return {
        name: g,
        type: "line",
        smooth: true,
        showSymbol: labels.length <= 24,
        connectNulls: true,
        data: labels.map((l) => agg.get(l)?.[0] ?? null),
      };
    });
  } else {
    const agg = aggregate(ds.rows, xKey, ys);
    series = ys.map((y, i) => ({
      name: y.name,
      type: "line",
      smooth: true,
      showSymbol: labels.length <= 24,
      areaStyle: ys.length === 1 ? { opacity: 0.18 } : undefined,
      data: labels.map((l) => agg.get(l)?.[i] ?? null),
    }));
  }

  return {
    id: `line:${x.key}:${ys.map((y) => y.key).join("+")}${by ? `:by:${by.key}` : ""}`,
    kind: "line",
    label: by
      ? t("chart.label.lineBy", { y: ys[0].name, x: x.name, by: by.name })
      : t("chart.label.line", { y: names(ys), x: x.name }),
    reason: by
      ? t("chart.reason.lineBy", { x: x.name, n: labels.length, by: by.name, k: series.length })
      : t("chart.reason.line", { x: x.name, n: labels.length }),
    score: 100,
    option: {
      ...baseOption(),
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: labels, boundaryGap: false, axisLabel: AXIS_LABEL, axisLine: AXIS_LINE },
      yAxis: { type: "value", axisLabel: AXIS_LABEL, splitLine: SPLIT_LINE },
      series,
    },
  };
}

function topCategories(ds: DataSet, cat: ColumnProfile, measure: ColumnProfile, limit: number) {
  const agg = aggregate(ds.rows, (r) => catKey(r, cat), [measure]);
  return [...agg.entries()]
    .sort((a, b) => b[1][0] - a[1][0])
    .slice(0, limit)
    .map(([k]) => k);
}

export function buildBar(
  ds: DataSet,
  cat: ColumnProfile,
  measures: ColumnProfile[],
  opts: { stacked?: boolean; top?: number; score: number; reason: string },
): ChartSuggestion {
  const agg = aggregate(ds.rows, (r) => catKey(r, cat), measures);
  const labels = opts.top ? topCategories(ds, cat, measures[0], opts.top) : [...agg.keys()];
  const kind: ChartKind = opts.stacked ? "stackedBar" : "bar";
  const label = opts.stacked
    ? t("chart.label.stackedBar", { y: names(measures), x: cat.name })
    : opts.top
      ? t("chart.label.barTop", { n: opts.top, x: cat.name, y: measures[0].name })
      : t("chart.label.bar", { y: names(measures), x: cat.name });
  return {
    id: `${kind}:${cat.key}:${measures.map((m) => m.key).join("+")}${opts.top ? `:top${opts.top}` : ""}`,
    kind,
    label,
    reason: opts.reason,
    score: opts.score,
    option: {
      ...baseOption(),
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: { ...AXIS_LABEL, interval: 0, rotate: labels.length > 6 ? 30 : 0 },
        axisLine: AXIS_LINE,
      },
      yAxis: { type: "value", axisLabel: AXIS_LABEL, splitLine: SPLIT_LINE },
      series: measures.map((m, i) => ({
        name: m.name,
        type: "bar",
        barMaxWidth: 36,
        ...(opts.stacked ? { stack: "total", emphasis: { focus: "series" } } : {}),
        data: labels.map((l) => agg.get(l)?.[i] ?? 0),
        itemStyle: opts.stacked && i < measures.length - 1 ? undefined : { borderRadius: [4, 4, 0, 0] },
      })),
    },
  };
}

export function buildPie(ds: DataSet, cat: ColumnProfile, m: ColumnProfile, score: number, reason: string): ChartSuggestion {
  const agg = aggregate(ds.rows, (r) => catKey(r, cat), [m]);
  return {
    id: `pie:${cat.key}:${m.key}`,
    kind: "pie",
    label: t("chart.label.pie", { y: m.name, x: cat.name }),
    reason,
    score,
    option: {
      ...baseOption(),
      tooltip: { trigger: "item" },
      legend: { orient: "vertical", left: 8, top: "middle", textStyle: { color: "#9aa3b2" } },
      series: [
        {
          name: m.name,
          type: "pie",
          radius: ["45%", "72%"],
          itemStyle: { borderRadius: 6, borderColor: "transparent", borderWidth: 2 },
          label: { color: "#9aa3b2" },
          data: [...agg.entries()].map(([name, v]) => ({ name, value: v[0] })),
        },
      ],
    },
  };
}

function valueAxis(name: string) {
  return { type: "value", name, nameTextStyle: AXIS_LABEL, axisLabel: AXIS_LABEL, splitLine: SPLIT_LINE, scale: true };
}

export function buildScatter(
  ds: DataSet,
  x: ColumnProfile,
  y: ColumnProfile,
  by: ColumnProfile | undefined,
  score: number,
  reason: string,
): ChartSuggestion {
  let series: Array<Record<string, unknown>>;
  if (by) {
    const groups = new Map<string, Array<[number, number]>>();
    for (const r of ds.rows) {
      const a = num(r, x);
      const b = num(r, y);
      if (a === null || b === null) continue;
      const k = catKey(r, by);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push([a, b]);
    }
    series = [...groups.entries()].map(([name, data]) => ({ name, type: "scatter", symbolSize: 9, data }));
  } else {
    series = [{ type: "scatter", symbolSize: 9, data: pairs(ds.rows, x, y) }];
  }
  return {
    id: `scatter:${x.key}:${y.key}${by ? `:by:${by.key}` : ""}`,
    kind: "scatter",
    label: by
      ? t("chart.label.scatterBy", { y: y.name, x: x.name, by: by.name })
      : t("chart.label.scatter", { y: y.name, x: x.name }),
    reason,
    score,
    option: { ...baseOption(), tooltip: { trigger: "item" }, xAxis: valueAxis(x.name), yAxis: valueAxis(y.name), series },
  };
}

/** Sturges' rule, clamped to 5–30 bins. */
export function histogramBins(values: number[]): Array<{ from: number; to: number; count: number }> {
  if (values.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) return [{ from: min, to: max, count: values.length }];
  const k = Math.max(5, Math.min(30, Math.ceil(Math.log2(values.length) + 1)));
  const width = (max - min) / k;
  const bins = Array.from({ length: k }, (_, i) => ({ from: min + i * width, to: min + (i + 1) * width, count: 0 }));
  for (const v of values) {
    const i = Math.min(k - 1, Math.floor((v - min) / width));
    bins[i].count++;
  }
  return bins;
}

export function buildHistogram(ds: DataSet, m: ColumnProfile, score: number): ChartSuggestion {
  const values = ds.rows.map((r) => num(r, m)).filter((v): v is number => v !== null);
  const bins = histogramBins(values);
  return {
    id: `histogram:${m.key}`,
    kind: "histogram",
    label: t("chart.label.histogram", { x: m.name }),
    reason: t("chart.reason.histogram", { n: values.length, x: m.name, k: bins.length }),
    score,
    option: {
      ...baseOption(),
      legend: { show: false },
      xAxis: {
        type: "category",
        name: m.name,
        nameTextStyle: AXIS_LABEL,
        data: bins.map((b) => `${fmtNum(b.from)}–${fmtNum(b.to)}`),
        axisLabel: { ...AXIS_LABEL, rotate: bins.length > 8 ? 30 : 0 },
        axisLine: AXIS_LINE,
      },
      yAxis: { type: "value", minInterval: 1, axisLabel: AXIS_LABEL, splitLine: SPLIT_LINE },
      series: [{ name: m.name, type: "bar", barCategoryGap: "4%", data: bins.map((b) => b.count) }],
    },
  };
}

const MAX_MAP_MARKERS = 500;

export function buildMap(ds: DataSet, lat: ColumnProfile, lon: ColumnProfile, labelCol?: ColumnProfile): ChartSuggestion {
  const markers: MapMarkerSpec[] = [];
  for (const r of ds.rows) {
    const a = num(r, lat);
    const b = num(r, lon);
    if (a === null || b === null) continue;
    markers.push(labelCol ? { lat: a, lng: b, label: catKey(r, labelCol) } : { lat: a, lng: b });
    if (markers.length >= MAX_MAP_MARKERS) break;
  }
  return {
    id: `map:${lat.key}:${lon.key}`,
    kind: "map",
    label: t("chart.label.map", { n: markers.length }),
    reason: t("chart.reason.map", { lat: lat.name, lon: lon.name }),
    score: 105,
    map: { markers },
    option: {
      ...baseOption(),
      tooltip: { trigger: "item" },
      xAxis: { ...valueAxis(lon.name), min: -180, max: 180, scale: false },
      yAxis: { ...valueAxis(lat.name), min: -90, max: 90, scale: false },
      series: [{ type: "scatter", symbolSize: 8, data: markers.map((m) => [m.lng, m.lat, m.label ?? ""]) }],
    },
  };
}

export function buildRadar(ds: DataSet, cat: ColumnProfile, measures: ColumnProfile[]): ChartSuggestion {
  const groups = new Map<string, { sum: number[]; n: number[] }>();
  for (const r of ds.rows) {
    const k = catKey(r, cat);
    if (!groups.has(k)) groups.set(k, { sum: measures.map(() => 0), n: measures.map(() => 0) });
    const g = groups.get(k)!;
    measures.forEach((m, i) => {
      const v = num(r, m);
      if (v === null) return;
      g.sum[i] += v;
      g.n[i] += 1;
    });
  }
  return {
    id: `radar:${cat.key}:${measures.map((m) => m.key).join("+")}`,
    kind: "radar",
    label: t("chart.label.radar", { y: names(measures), x: cat.name }),
    reason: t("chart.reason.radar", { k: measures.length, n: groups.size }),
    score: 50,
    option: {
      ...baseOption(),
      tooltip: {},
      radar: {
        indicator: measures.map((m) => ({ name: m.name, max: m.max ?? 100 })),
        splitLine: SPLIT_LINE,
        axisName: AXIS_LABEL,
      },
      series: [
        {
          type: "radar",
          areaStyle: { opacity: 0.18 },
          data: [...groups.entries()].map(([name, g]) => ({
            name,
            value: measures.map((_, i) => (g.n[i] ? g.sum[i] / g.n[i] : 0)),
          })),
        },
      ],
    },
  };
}

export function buildSummary(ds: DataSet, measures: ColumnProfile[]): ChartSuggestion {
  const means = measures.map((m) => {
    const vs = ds.rows.map((r) => num(r, m)).filter((v): v is number => v !== null);
    return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 0;
  });
  return {
    id: "summary",
    kind: "bar",
    label: t("chart.label.summary"),
    reason: t("chart.reason.summary"),
    score: 30,
    option: {
      ...baseOption(),
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: measures.map((m) => m.name), axisLabel: AXIS_LABEL },
      yAxis: { type: "value", axisLabel: AXIS_LABEL },
      series: [{ type: "bar", barMaxWidth: 36, itemStyle: { borderRadius: [4, 4, 0, 0] }, data: means }],
    },
  };
}
