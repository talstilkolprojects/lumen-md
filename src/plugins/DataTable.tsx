import { useMemo, useState } from "react";
import type { DataSet, DataColumn } from "../data/csv";
import { t } from "../i18n";

interface Props {
  data: DataSet;
  /** Cap on visible rows; show "+N more" hint if exceeded. */
  maxRows?: number;
}

export function DataTable({ data, maxRows = 200 }: Props) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const sorted = useMemo(() => {
    if (!sortKey) return data.rows;
    const col = data.columns.find((c) => c.key === sortKey);
    if (!col) return data.rows;
    const dir = sortDir === "asc" ? 1 : -1;
    const copy = [...data.rows];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === "number" && typeof bv === "number")
        return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return copy;
  }, [data, sortKey, sortDir]);

  const visible = sorted.slice(0, maxRows);

  function clickHeader(col: DataColumn) {
    if (sortKey === col.key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(col.key);
      setSortDir("asc");
    }
  }

  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {data.columns.map((c) => (
              <th
                key={c.key}
                className={c.type === "number" ? "num" : ""}
                onClick={() => clickHeader(c)}
                title={t("block.dataTable.columnStats", { type: c.type, distinct: c.distinct, filled: c.filled })}
              >
                {c.name}
                <span className="col-type">{c.type}</span>
                {sortKey === c.key && (
                  <span style={{ marginLeft: 6 }}>
                    {sortDir === "asc" ? "▲" : "▼"}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((row, i) => (
            <tr key={i}>
              {data.columns.map((c) => (
                <td key={c.key} className={c.type === "number" ? "num" : ""}>
                  {formatCell(row[c.key], c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.rows.length > maxRows && (
        <div
          style={{
            padding: "0.5rem 0.85rem",
            fontSize: 12,
            color: "hsl(var(--fg-muted))",
            background: "hsl(var(--bg-muted))",
            borderTop: "1px solid hsl(var(--border))",
          }}
        >
          {t("block.data.showing", { shown: maxRows, total: data.rows.length })}
        </div>
      )}
    </div>
  );
}

function formatCell(value: unknown, col: DataColumn): string {
  if (value === null || value === undefined) return "—";
  if (col.type === "date" && typeof value === "number") {
    const d = new Date(value);
    return d.toISOString().slice(0, 10);
  }
  if (col.type === "number" && typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    if (Math.abs(value) >= 1000) return value.toLocaleString();
    return value.toPrecision(4);
  }
  return String(value);
}
