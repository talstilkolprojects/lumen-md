/** Types of the chart-suggestion engine (split out of suggest.ts, plan W4.11; it re-exports them). */

export type ChartKind =
  | "bar"
  | "stackedBar"
  | "line"
  | "area"
  | "pie"
  | "scatter"
  | "histogram"
  | "map"
  | "heatmap"
  | "radar";

export interface MapMarkerSpec {
  lat: number;
  lng: number;
  label?: string;
}

export interface ChartSuggestion {
  /** Stable id (kind + columns) — unique within one result list. */
  id: string;
  kind: ChartKind;
  label: string;
  /** Why this chart fits the data (localised, one sentence). */
  reason: string;
  /** ECharts option object (for `map`, a lon/lat scatter fallback). */
  option: Record<string, unknown>;
  score: number;
  /** For `map`: markers for the Leaflet map block. */
  map?: { markers: MapMarkerSpec[] };
}

// ── Column profiling ───────────────────────────────────────────────────

export type SemanticType =
  | "time"
  | "numeric"
  | "percent"
  | "currency"
  | "latitude"
  | "longitude"
  | "id"
  | "categorical"
  | "text"
  | "empty";

export type TimeFormat = "date" | "year" | "quarter" | "month" | "clock";

export interface ColumnProfile {
  key: string;
  name: string;
  semantic: SemanticType;
  /** Distinct non-null values. */
  distinct: number;
  /** Non-null cells. */
  filled: number;
  timeFormat?: TimeFormat;
  min?: number;
  max?: number;
  sum?: number;
  /** All non-null numeric values are ≥ 0. */
  nonNegative?: boolean;
}
