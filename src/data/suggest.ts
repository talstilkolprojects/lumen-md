/**
 * Chart-suggestion engine for tabular blocks (csv / tsv / json-table / data).
 *
 * Two pure stages:
 *
 *   1. `profileColumns(ds)` — classify every column semantically on top of
 *      the parser's storage type: time (dates, years, quarters, month
 *      names, clock times), numeric / percent / currency (including
 *      "12%", "$1,200", "(300)", "1 234" strings the CSV parser leaves as
 *      text), latitude / longitude, row ids, categorical (with
 *      cardinality) and free text.
 *   2. `suggestCharts(ds)` — score every chart that fits the profile and
 *      return them ranked, each with an i18n'ed label + reason the UI
 *      shows as alternatives:
 *
 *        map          lat + lon columns
 *        line         time axis × numeric (multi-series by measure or by
 *                     a small category)
 *        pie          one measure over ≤ 6 non-negative slices; preferred
 *                     when the slices add up to ~100 or are percentages
 *        stackedBar   ≥ 2 comparable measures over ≤ 20 categories
 *        bar          categorical × numeric (≤ 20 categories; top-20 when
 *                     there are 21–50)
 *        scatter      two numeric measures (boosted when correlated)
 *        histogram    one measure with many rows
 *        radar        ≥ 3 measures for ≤ 6 items
 *        summary bar  fallback: averages of numeric columns
 *
 * The return shape (`kind`, `label`, `option`, `score`) is unchanged for
 * existing callers; `id`, `reason` and the optional `map` spec are new.
 */

import type { DataSet } from "./csv";
import { t } from "../i18n";
import type { ChartSuggestion, SemanticType, ColumnProfile } from "./suggestTypes";
export type { ChartKind, MapMarkerSpec, ChartSuggestion, SemanticType, TimeFormat, ColumnProfile } from "./suggestTypes";
import { profileColumns } from "./columnProfile";
export { profileColumns, parseLooseNumber } from "./columnProfile";
import { buildLine, buildBar, buildPie, buildScatter, buildHistogram, buildMap, buildRadar, buildSummary, catKey, fmtNum, pairs, aggregate } from "./chartBuilders";
export { histogramBins } from "./chartBuilders";

/** Numeric-ish semantic types that can be plotted as a measure. */
const MEASURE_TYPES: ReadonlySet<SemanticType> = new Set(["numeric", "percent", "currency"]);

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

// ── Ranking ────────────────────────────────────────────────────────────

/** Thresholds, exported so tests and docs stay in sync with the code. */
export const SUGGEST_LIMITS = {
  barMaxCategories: 20,
  barTopMaxCategories: 50,
  pieMaxSlices: 6,
  lineByMaxSeries: 8,
  histogramMinRows: 20,
  histogramMinDistinct: 8,
  radarMaxItems: 6,
  strongCorrelation: 0.6,
} as const;

/** Two measures are "comparable" (worth stacking) when they share a unit/scale. */
function comparable(ms: ColumnProfile[]): boolean {
  const units = new Set(ms.map((m) => m.semantic));
  if (units.size > 1) return false;
  const maxes = ms.map((m) => Math.max(Math.abs(m.max ?? 0), Math.abs(m.min ?? 0)) || 1);
  return Math.max(...maxes) / Math.min(...maxes) <= 10;
}

export function suggestCharts(ds: DataSet): ChartSuggestion[] {
  if (ds.rows.length === 0 || ds.columns.length === 0) return [];
  const profiles = profileColumns(ds);
  const rowCount = ds.rows.length;

  const measures = profiles.filter((p) => MEASURE_TYPES.has(p.semantic));
  const times = profiles.filter((p) => p.semantic === "time" && p.distinct >= 2);
  const cats = profiles.filter((p) => p.semantic === "categorical" && p.distinct >= 1);
  const lat = profiles.find((p) => p.semantic === "latitude");
  const lon = profiles.find((p) => p.semantic === "longitude");
  const L = SUGGEST_LIMITS;

  const out: ChartSuggestion[] = [];

  // Map: lat/lon pair.
  if (lat && lon) {
    const labelCol = cats[0] ?? profiles.find((p) => p.semantic === "text");
    out.push(buildMap(ds, lat, lon, labelCol));
  }

  // Line: time axis × measures (or one measure split by a small category).
  if (times.length >= 1 && measures.length >= 1) {
    const x = times[0];
    const by = cats.find((c) => c.distinct >= 2 && c.distinct <= L.lineByMaxSeries);
    if (measures.length === 1 && by) out.push(buildLine(ds, x, measures, by));
    else out.push(buildLine(ds, x, measures.slice(0, 4)));
  }

  // Categorical comparisons.
  const cat = cats.find((c) => c.distinct >= 2) ?? cats[0];
  if (cat && measures.length >= 1) {
    const first = measures[0];
    if (cat.distinct <= L.barMaxCategories) {
      const ms = measures.slice(0, 4);
      const stackable = ms.length >= 2 && ms.every((m) => m.nonNegative) && comparable(ms);
      out.push(
        buildBar(ds, cat, ms, {
          score: stackable ? 89 : 90,
          reason:
            ms.length > 1
              ? t("chart.reason.barGrouped", { n: cat.distinct, k: ms.length })
              : t("chart.reason.bar", { n: cat.distinct, y: first.name }),
        }),
      );
      if (ms.length >= 2 && ms.every((m) => m.nonNegative)) {
        out.push(
          buildBar(ds, cat, ms, {
            stacked: true,
            score: stackable ? 91 : 62,
            reason: stackable
              ? t("chart.reason.stackedBar", { k: ms.length })
              : t("chart.reason.stackedBarMixed", { k: ms.length }),
          }),
        );
      }
    } else if (cat.distinct <= L.barTopMaxCategories) {
      out.push(
        buildBar(ds, cat, [first], {
          top: L.barMaxCategories,
          score: 60,
          reason: t("chart.reason.barTop", { total: cat.distinct, n: L.barMaxCategories }),
        }),
      );
    }

    // Pie: single measure, few non-negative slices.
    if (cat.distinct >= 2 && cat.distinct <= L.pieMaxSlices && first.nonNegative) {
      const agg = aggregate(ds.rows, (r) => catKey(r, cat), [first]);
      const total = [...agg.values()].reduce((a, v) => a + v[0], 0);
      if (total > 0) {
        const sumsTo100 = Math.abs(total - 100) <= 1.5 || Math.abs(total - 1) <= 0.015;
        const single = measures.length === 1;
        let score: number;
        let reason: string;
        if (sumsTo100) {
          score = single ? 92 : 80;
          reason = t("chart.reason.pieSum", { n: agg.size, total: fmtNum(total) });
        } else if (first.semantic === "percent") {
          score = single ? 86 : 76;
          reason = t("chart.reason.piePercent", { y: first.name, n: agg.size });
        } else {
          score = single ? 72 : 58;
          reason = t("chart.reason.pie", { n: agg.size });
        }
        out.push(buildPie(ds, cat, first, score, reason));
      }
    }

    // Radar: ≥ 3 measures for a handful of items.
    if (cat.distinct <= L.radarMaxItems && measures.length >= 3) {
      out.push(buildRadar(ds, cat, measures.slice(0, 6)));
    }
  }

  // Scatter: two measures.
  if (measures.length >= 2) {
    const [x, y] = measures;
    const ps = pairs(ds.rows, x, y);
    const r = pearson(ps.map((p) => p[0]), ps.map((p) => p[1]));
    const strong = Math.abs(r) >= L.strongCorrelation && ps.length >= 4;
    const noAxis = times.length === 0 && !cat;
    const by = cats.find((c) => c.distinct >= 2 && c.distinct <= 10);
    out.push(
      buildScatter(
        ds,
        x,
        y,
        by,
        (strong ? 84 : 70) + (noAxis ? 10 : 0),
        strong
          ? t("chart.reason.scatterCorr", { x: x.name, y: y.name, r: r.toFixed(2) })
          : t("chart.reason.scatter", { x: x.name, y: y.name }),
      ),
    );
  }

  // Histogram: distribution of a single measure with enough rows.
  if (measures.length >= 1 && rowCount >= L.histogramMinRows) {
    const m = measures[0];
    if (m.distinct >= L.histogramMinDistinct) {
      const noAxis = times.length === 0 && !cat;
      out.push(buildHistogram(ds, m, noAxis ? (measures.length === 1 ? 82 : 74) : 55));
    }
  }

  // Fallback: no axis at all → compare averages.
  if (out.length === 0 && measures.length >= 1) out.push(buildSummary(ds, measures));

  const seen = new Set<string>();
  return out
    .filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
    .sort((a, b) => b.score - a.score);
}
