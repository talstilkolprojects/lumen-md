/**
 * Insights analyzer — turns a JSONL/JSON-array dataset into:
 *   • Frequency tables (probability of every value of a chosen field)
 *   • Per-group counts (rows grouped by a chosen field)
 *   • Co-occurrence matrices for array-valued fields (e.g. tags / task_ids)
 *   • A short list of natural-language conclusions
 *   • Suggestions for derivative documents the user can spin off
 *
 * Pure: no React, no I/O. The block component and exporter call into it.
 * Stays local — never sends data to an external model.
 */

import type { ChartSuggestion } from "./suggest";

export type InsightsRecord = { [key: string]: unknown };

export interface InsightsDataset {
  records: InsightsRecord[];
  /** Field names observed across every row, sorted by frequency desc. */
  fields: string[];
  /** Fields whose values are arrays (potential multi-value/probability fields). */
  arrayFields: string[];
  /** Scalar fields that look like good grouping keys (low cardinality). */
  groupableFields: string[];
  /**
   * Fields whose distinct-value set hit the in-shape detection cap (200
   * distinct values per field). These are deliberately excluded from
   * `groupableFields` because we can't tell whether they're actually
   * low-cardinality. Surfaced so the UI can warn and so silent
   * miscategorisation can't bite later.
   */
  truncatedFields: string[];
}

export interface FrequencyEntry {
  value: string;
  count: number;
  /** count / total. */
  probability: number;
}

export interface FrequencyTable {
  field: string;
  total: number;
  entries: FrequencyEntry[];
}

export interface CoOccurrenceMatrix {
  field: string;
  labels: string[];
  /** matrix[i][j] = times labels[i] and labels[j] appeared together. */
  matrix: number[][];
}

export interface GroupSummary {
  group: string;
  count: number;
  /** 0..1 share of total rows. */
  share: number;
}

export interface Conclusion {
  /** Stable id so the UI can key/skip duplicates. */
  id: string;
  /** Short headline shown in the UI. */
  headline: string;
  /** Optional supporting detail (one line). */
  detail?: string;
}

export interface InsightSuggestion {
  id: string;
  /** Imperative title shown on the action button. */
  title: string;
  /** One-line tooltip. */
  description: string;
  /** Which generator to invoke when the user accepts. */
  kind:
    | "split-by-field"
    | "tasklist-by-field"
    | "summary-report"
    | "frequency-doc"
    | "cooccurrence-doc";
  /** Field this suggestion operates on (if any). */
  field?: string;
  /** Estimated number of files / sections produced. */
  estCount?: number;
}

const ID_LIKE_RE = /^(idx|id|uuid|guid)$/i;

/**
 * Parse JSONL (newline-delimited JSON) or a JSON array. Tolerates blank
 * lines and trailing commas-style mistakes only insofar as JSON.parse
 * tolerates them — the goal is to handle the user's own export, not to
 * be a forgiving JSON5 parser.
 */
export function parseJsonRecords(text: string): InsightsRecord[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Whole-document JSON (array or single object).
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.filter(isObj);
      if (isObj(parsed)) return [parsed];
    } catch {
      /* why: fall through to JSONL */
    }
  }

  // JSONL — one JSON value per line. Skip blanks; surface first parse error
  // with the offending line number so the user knows where to look.
  const out: InsightsRecord[] = [];
  const lines = trimmed.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (Array.isArray(v)) v.forEach((x) => isObj(x) && out.push(x));
      else if (isObj(v)) out.push(v);
    } catch (e) {
      throw new Error(
        `JSONL parse error on line ${i + 1}: ${(e as Error).message}`,
      );
    }
  }
  return out;
}

function isObj(v: unknown): v is InsightsRecord {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Build a high-level summary of the dataset shape — which fields exist,
 * which look like arrays (good candidates for probability/co-occurrence),
 * which look like grouping keys (low cardinality scalars).
 */
export function describeDataset(records: InsightsRecord[]): InsightsDataset {
  const fieldCounts = new Map<string, number>();
  const arrayFieldCounts = new Map<string, number>();
  const distinctValues = new Map<string, Set<string>>();
  const truncated = new Set<string>();
  const DISTINCT_CAP = 200;

  for (const r of records) {
    for (const [k, v] of Object.entries(r)) {
      fieldCounts.set(k, (fieldCounts.get(k) ?? 0) + 1);
      if (Array.isArray(v)) {
        arrayFieldCounts.set(k, (arrayFieldCounts.get(k) ?? 0) + 1);
      } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        let set = distinctValues.get(k);
        if (!set) {
          set = new Set();
          distinctValues.set(k, set);
        }
        if (set.size < DISTINCT_CAP) {
          set.add(String(v));
        } else if (!set.has(String(v))) {
          // Cap reached and this value isn't already counted — mark the
          // field as truncated so we don't silently miscategorise it.
          truncated.add(k);
        }
      }
    }
  }

  const fields = [...fieldCounts.keys()].sort(
    (a, b) => (fieldCounts.get(b) ?? 0) - (fieldCounts.get(a) ?? 0),
  );
  const arrayFields = [...arrayFieldCounts.keys()].filter(
    (k) => (arrayFieldCounts.get(k) ?? 0) >= Math.max(1, records.length * 0.25),
  );
  const groupableFields = fields.filter((k) => {
    if (arrayFieldCounts.has(k)) return false;
    if (ID_LIKE_RE.test(k)) return false;
    // Truncated fields are excluded — we genuinely don't know their
    // cardinality, so we'd rather miss a real group than offer a
    // misleading one.
    if (truncated.has(k)) return false;
    const distinct = distinctValues.get(k)?.size ?? Infinity;
    // Cap at the larger of 8 (so tiny datasets still see useful groups) and
    // 60% of rows (so big datasets don't list near-unique fields as groups).
    const cap = Math.max(8, Math.floor(records.length * 0.6));
    return distinct >= 2 && distinct <= cap;
  });

  return {
    records,
    fields,
    arrayFields,
    groupableFields,
    truncatedFields: [...truncated].sort(),
  };
}

/**
 * Frequency table for a field. If the field is an array, each element
 * counts once per containing record (so a row with `["a","b","a"]` adds
 * 2 to "a" and 1 to "b" — repeats inside one row matter).
 */
export function frequencyTable(records: InsightsRecord[], field: string): FrequencyTable {
  const counts = new Map<string, number>();
  let total = 0;
  for (const r of records) {
    const v = r[field];
    if (Array.isArray(v)) {
      for (const x of v) {
        const key = stringify(x);
        if (key === null) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        total++;
      }
    } else {
      const key = stringify(v);
      if (key === null) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total++;
    }
  }
  const entries: FrequencyEntry[] = [...counts.entries()]
    .map(([value, count]) => ({
      value,
      count,
      probability: total === 0 ? 0 : count / total,
    }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return { field, total, entries };
}

/**
 * Co-occurrence matrix: how often each pair of values from an array-valued
 * field appears in the same record. Diagonal is the per-value record count
 * (number of records containing the value). Top-N cap keeps the matrix
 * readable when there are dozens of distinct labels.
 */
export function coOccurrence(
  records: InsightsRecord[],
  field: string,
  topN = 12,
): CoOccurrenceMatrix {
  const counts = new Map<string, number>();
  for (const r of records) {
    const v = r[field];
    if (!Array.isArray(v)) continue;
    const seen = new Set<string>();
    for (const x of v) {
      const k = stringify(x);
      if (k !== null) seen.add(k);
    }
    for (const k of seen) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const labels = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([k]) => k);
  const idx = new Map(labels.map((l, i) => [l, i]));
  const matrix: number[][] = labels.map(() => labels.map(() => 0));

  for (const r of records) {
    const v = r[field];
    if (!Array.isArray(v)) continue;
    const seen = new Set<string>();
    for (const x of v) {
      const k = stringify(x);
      if (k !== null && idx.has(k)) seen.add(k);
    }
    const ids = [...seen].map((s) => idx.get(s)!).sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++) {
      matrix[ids[i]][ids[i]] += 1;
      for (let j = i + 1; j < ids.length; j++) {
        matrix[ids[i]][ids[j]] += 1;
        matrix[ids[j]][ids[i]] += 1;
      }
    }
  }
  return { field, labels, matrix };
}

/** Per-group row counts (for splitting / per-group reports). */
export function groupSummary(records: InsightsRecord[], field: string): GroupSummary[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    const k = stringify(r[field]);
    if (k === null) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const total = records.length;
  return [...counts.entries()]
    .map(([group, count]) => ({
      group,
      count,
      share: total === 0 ? 0 : count / total,
    }))
    .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group));
}

/**
 * Heuristic conclusions — short bullets that summarise the dataset.
 * Picks the first-array-field's top entries, calls out very rare values,
 * notes scope-of-coverage gaps, etc. Keep it small and obvious; we'd
 * rather miss a subtle observation than print a wrong one.
 */
export function deriveConclusions(
  records: InsightsRecord[],
  shape: InsightsDataset,
): Conclusion[] {
  const out: Conclusion[] = [];
  if (records.length === 0) {
    return [{ id: "empty", headline: "No records to analyze." }];
  }
  out.push({
    id: "rows",
    headline: `${records.length} record${records.length === 1 ? "" : "s"} across ${shape.fields.length} field${shape.fields.length === 1 ? "" : "s"}.`,
  });

  // Per-group summary on the most useful grouping key.
  const groupField = shape.groupableFields[0];
  if (groupField) {
    const groups = groupSummary(records, groupField);
    if (groups.length > 0) {
      const top = groups[0];
      out.push({
        id: `group-${groupField}`,
        headline: `“${groupField}” spans ${groups.length} value${groups.length === 1 ? "" : "s"}; the largest is “${top.group}” with ${top.count} (${pct(top.share)}).`,
      });
    }
  }

  // Headline frequency on the first array field.
  const arrayField = shape.arrayFields[0];
  if (arrayField) {
    const freq = frequencyTable(records, arrayField);
    const top3 = freq.entries.slice(0, 3);
    if (top3.length > 0) {
      out.push({
        id: `freq-${arrayField}`,
        headline: `Most frequent “${arrayField}”: ${top3
          .map((e) => `${e.value} (${pct(e.probability)})`)
          .join(", ")}.`,
        detail:
          freq.entries.length > 3
            ? `${freq.entries.length} distinct values overall; tail is long.`
            : undefined,
      });
    }
    // Very-rare values surface — useful for noticing single-shot tasks.
    const rare = freq.entries.filter((e) => e.count === 1).length;
    if (rare > 0) {
      out.push({
        id: `rare-${arrayField}`,
        headline: `${rare} “${arrayField}” value${rare === 1 ? "" : "s"} appear only once — candidates for review or merging.`,
      });
    }
  }

  // Coverage / completeness — fields that aren't on every row are worth flagging.
  const fieldFill = shape.fields.map((f) => ({
    f,
    fill: records.filter((r) => r[f] !== undefined && r[f] !== null && r[f] !== "").length,
  }));
  const partial = fieldFill.filter((x) => x.fill > 0 && x.fill < records.length);
  if (partial.length > 0) {
    const worst = partial.sort((a, b) => a.fill - b.fill)[0];
    out.push({
      id: `partial-${worst.f}`,
      headline: `Field “${worst.f}” is missing on ${records.length - worst.fill} of ${records.length} rows.`,
    });
  }

  return out;
}

/**
 * Suggestions for derivative documents. Conservative — only surface options
 * that obviously map to the data. The UI lets the user accept any of these
 * with one click; no external model needed.
 */
export function deriveSuggestions(shape: InsightsDataset): InsightSuggestion[] {
  const out: InsightSuggestion[] = [];
  for (const f of shape.groupableFields.slice(0, 3)) {
    const groups = groupSummary(shape.records, f);
    if (groups.length < 2 || groups.length > 200) continue;
    out.push({
      id: `split-${f}`,
      title: `Split into ${groups.length} files by “${f}”`,
      description: `One markdown note per ${f}, listing every record in that bucket.`,
      kind: "split-by-field",
      field: f,
      estCount: groups.length,
    });
    out.push({
      id: `tasklist-${f}`,
      title: `Tasklist per “${f}”`,
      description: `Markdown checklist grouped by ${f}, with every micro-task as a checkbox.`,
      kind: "tasklist-by-field",
      field: f,
      estCount: groups.length,
    });
  }
  for (const f of shape.arrayFields.slice(0, 2)) {
    const freq = frequencyTable(shape.records, f);
    if (freq.entries.length === 0) continue;
    out.push({
      id: `freq-${f}`,
      title: `Probability report for “${f}”`,
      description: `Single document with the full ${freq.entries.length}-row probability table.`,
      kind: "frequency-doc",
      field: f,
    });
    if (freq.entries.length >= 3) {
      out.push({
        id: `cooc-${f}`,
        title: `Co-occurrence matrix for “${f}”`,
        description: `Heat-mappable matrix showing which ${f} values cluster together.`,
        kind: "cooccurrence-doc",
        field: f,
      });
    }
  }
  out.push({
    id: "summary",
    title: "Generate summary report",
    description: "Single doc with conclusions, top frequencies, and the raw record count.",
    kind: "summary-report",
  });
  return out;
}

/** ECharts options for the standard charts the block renders. */
export function frequencyBarOption(
  freq: FrequencyTable,
  topN = 20,
): Record<string, unknown> {
  const top = freq.entries.slice(0, topN);
  return {
    color: ["#7c5cff"],
    grid: { left: 60, right: 24, top: 36, bottom: 56, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: unknown) => {
        const items = Array.isArray(params) ? params : [params];
        const p = items[0] as { name?: string; value?: number; dataIndex?: number };
        const idx = p.dataIndex ?? 0;
        const e = top[idx];
        if (!e) return p.name ?? "";
        return `${e.value}<br/>count ${e.count} • ${pct(e.probability)}`;
      },
    },
    xAxis: {
      type: "category",
      data: top.map((e) => truncate(e.value, 24)),
      axisLabel: { rotate: 30, color: "#9aa3b2" },
    },
    yAxis: { type: "value", axisLabel: { color: "#9aa3b2" } },
    series: [
      {
        type: "bar",
        data: top.map((e) => e.count),
        itemStyle: { borderRadius: [6, 6, 0, 0] },
      },
    ],
  };
}

export function frequencyPieOption(
  freq: FrequencyTable,
  topN = 8,
): Record<string, unknown> {
  const top = freq.entries.slice(0, topN);
  const tail = freq.entries.slice(topN);
  const tailSum = tail.reduce((a, b) => a + b.count, 0);
  const data = top.map((e) => ({ name: truncate(e.value, 24), value: e.count }));
  if (tailSum > 0) data.push({ name: `Other (${tail.length})`, value: tailSum });
  return {
    color: [
      "#7c5cff",
      "#22d3ee",
      "#f472b6",
      "#facc15",
      "#34d399",
      "#fb923c",
      "#60a5fa",
      "#a78bfa",
      "#475569",
    ],
    tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
    legend: { top: 6, textStyle: { color: "#9aa3b2" } },
    series: [
      {
        type: "pie",
        radius: ["40%", "70%"],
        avoidLabelOverlap: true,
        label: { color: "#cbd5e1" },
        data,
      },
    ],
  };
}

export function coOccurrenceHeatmapOption(
  cooc: CoOccurrenceMatrix,
): Record<string, unknown> {
  const data: [number, number, number][] = [];
  let max = 0;
  for (let i = 0; i < cooc.labels.length; i++) {
    for (let j = 0; j < cooc.labels.length; j++) {
      const v = cooc.matrix[i][j];
      if (v > max) max = v;
      data.push([i, j, v]);
    }
  }
  return {
    tooltip: {
      formatter: (p: unknown) => {
        const point = p as { value?: [number, number, number] };
        const v = point.value ?? [0, 0, 0];
        return `${cooc.labels[v[0]]} × ${cooc.labels[v[1]]}<br/>${v[2]}`;
      },
    },
    grid: { left: 100, right: 24, top: 80, bottom: 80, containLabel: true },
    xAxis: {
      type: "category",
      data: cooc.labels.map((l) => truncate(l, 18)),
      axisLabel: { rotate: 45, color: "#9aa3b2" },
      splitArea: { show: true },
    },
    yAxis: {
      type: "category",
      data: cooc.labels.map((l) => truncate(l, 18)),
      axisLabel: { color: "#9aa3b2" },
      splitArea: { show: true },
    },
    visualMap: {
      min: 0,
      max,
      orient: "horizontal",
      left: "center",
      bottom: 8,
      calculable: true,
      textStyle: { color: "#9aa3b2" },
      inRange: { color: ["#1e293b", "#7c5cff", "#f472b6"] },
    },
    series: [
      {
        type: "heatmap",
        data,
        label: { show: false },
        emphasis: { itemStyle: { shadowBlur: 6, shadowColor: "#7c5cff" } },
      },
    ],
  };
}

/** Bar option for per-group counts. */
export function groupBarOption(groups: GroupSummary[]): Record<string, unknown> {
  return {
    color: ["#22d3ee"],
    grid: { left: 60, right: 24, top: 36, bottom: 56, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: unknown) => {
        const items = Array.isArray(params) ? params : [params];
        const p = items[0] as { name?: string; dataIndex?: number };
        const idx = p.dataIndex ?? 0;
        const g = groups[idx];
        if (!g) return p.name ?? "";
        return `${g.group}<br/>${g.count} rows • ${pct(g.share)}`;
      },
    },
    xAxis: {
      type: "category",
      data: groups.map((g) => truncate(g.group, 24)),
      axisLabel: { rotate: 30, color: "#9aa3b2" },
    },
    yAxis: { type: "value", axisLabel: { color: "#9aa3b2" } },
    series: [
      {
        type: "bar",
        data: groups.map((g) => g.count),
        itemStyle: { borderRadius: [6, 6, 0, 0] },
      },
    ],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function stringify(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() ? v : null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export function pct(x: number): string {
  if (!Number.isFinite(x)) return "—";
  if (x === 0) return "0%";
  if (x < 0.001) return "<0.1%";
  return `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
}

/** Re-export ChartSuggestion shape so callers can stay agnostic. */
export type { ChartSuggestion };
