import { useState, useCallback } from "react";
import { Plus, Minus } from "lucide-react";
import { t } from "../i18n";

interface Props {
  /** Initial markdown table text, or empty for a new table */
  initialMarkdown?: string;
  /** Called with the updated markdown table string */
  onUpdate: (markdown: string) => void;
  onClose: () => void;
}

export function MarkdownTableEditor({ initialMarkdown, onUpdate, onClose }: Props) {
  const initial = initialMarkdown ? parseTable(initialMarkdown) : {
    headers: ["Column 1", "Column 2", "Column 3"],
    rows: [["", "", ""], ["", "", ""]],
    alignments: ["left", "left", "left"] as Alignment[],
  };

  const [headers, setHeaders] = useState(initial.headers);
  const [rows, setRows] = useState(initial.rows);
  const [alignments, setAlignments] = useState<Alignment[]>(initial.alignments);

  const cols = headers.length;

  const updateCell = useCallback((row: number, col: number, value: string) => {
    setRows((prev) => {
      const next = prev.map((r) => [...r]);
      next[row][col] = value;
      return next;
    });
  }, []);

  const updateHeader = useCallback((col: number, value: string) => {
    setHeaders((prev) => {
      const next = [...prev];
      next[col] = value;
      return next;
    });
  }, []);

  const addRow = () => setRows((prev) => [...prev, Array(cols).fill("")]);
  const removeRow = () => setRows((prev) => prev.length > 1 ? prev.slice(0, -1) : prev);
  const addCol = () => {
    setHeaders((prev) => [...prev, `Column ${prev.length + 1}`]);
    setRows((prev) => prev.map((r) => [...r, ""]));
    setAlignments((prev) => [...prev, "left"]);
  };
  const removeCol = () => {
    if (cols <= 1) return;
    setHeaders((prev) => prev.slice(0, -1));
    setRows((prev) => prev.map((r) => r.slice(0, -1)));
    setAlignments((prev) => prev.slice(0, -1));
  };

  const cycleAlignment = (col: number) => {
    setAlignments((prev) => {
      const next = [...prev];
      const cycle: Alignment[] = ["left", "center", "right"];
      const idx = cycle.indexOf(next[col]);
      next[col] = cycle[(idx + 1) % 3];
      return next;
    });
  };

  const handleApply = () => {
    onUpdate(toMarkdown(headers, rows, alignments));
    onClose();
  };

  return (
    <div style={{
      position: "fixed",
      inset: 0,
      zIndex: 9999,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "hsl(0 0% 0% / 0.5)",
      backdropFilter: "blur(4px)",
    }}>
      <div style={{
        background: "hsl(var(--bg))",
        border: "1px solid hsl(var(--border-strong))",
        borderRadius: 12,
        boxShadow: "0 20px 60px hsl(0 0% 0% / 0.4)",
        padding: 20,
        maxWidth: "90vw",
        maxHeight: "80vh",
        overflow: "auto",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15, color: "hsl(var(--fg))" }}>{t("mdTable.title")}</h3>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={addCol} className="icon-btn" title={t("mdTable.addCol")} style={{ width: 28, height: 28 }}>
              <Plus size={12} />
            </button>
            <button onClick={removeCol} className="icon-btn" title={t("mdTable.removeCol")} style={{ width: 28, height: 28 }}>
              <Minus size={12} />
            </button>
            <button onClick={addRow} className="icon-btn" title={t("mdTable.addRow")} style={{ width: 28, height: 28 }}>
              <Plus size={12} />
            </button>
            <button onClick={removeRow} className="icon-btn" title={t("mdTable.removeRow")} style={{ width: 28, height: 28 }}>
              <Minus size={12} />
            </button>
          </div>
        </div>

        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i} style={{ padding: 0, borderBottom: "2px solid hsl(var(--border-strong))" }}>
                  <input
                    value={h}
                    aria-label={t("mdTable.columnHeader", { n: i + 1 })}
                    onChange={(e) => updateHeader(i, e.target.value)}
                    style={{
                      width: "100%",
                      minWidth: 80,
                      padding: "6px 8px",
                      border: "1px solid hsl(var(--border))",
                      background: "hsl(var(--bg-subtle))",
                      color: "hsl(var(--fg))",
                      fontSize: 12,
                      fontWeight: 600,
                      textAlign: alignments[i] ?? "left",
                    }}
                  />
                  <button
                    onClick={() => cycleAlignment(i)}
                    aria-label={t("mdTable.cycleAlign", { n: i + 1 })}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "2px 0",
                      border: "none",
                      background: "transparent",
                      color: "hsl(var(--fg-muted))",
                      fontSize: 9,
                      cursor: "pointer",
                    }}
                  >
                    {alignments[i] === "left" ? t("mdTable.align.left") : alignments[i] === "center" ? t("mdTable.align.center") : t("mdTable.align.right")}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci} style={{ padding: 0 }}>
                    <input
                      value={cell}
                      aria-label={t("mdTable.cell", { row: ri + 1, col: ci + 1 })}
                      onChange={(e) => updateCell(ri, ci, e.target.value)}
                      style={{
                        width: "100%",
                        minWidth: 80,
                        padding: "4px 8px",
                        border: "1px solid hsl(var(--border))",
                        background: "transparent",
                        color: "hsl(var(--fg))",
                        fontSize: 12,
                        textAlign: alignments[ci] ?? "left",
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
          <button onClick={onClose} className="icon-btn" style={{ width: "auto", padding: "6px 16px", fontSize: 12 }}>
            {t("dialog.cancel")}
          </button>
          <button onClick={handleApply} style={{
            padding: "6px 16px",
            fontSize: 12,
            borderRadius: 6,
            border: "none",
            background: "hsl(var(--accent))",
            color: "white",
            cursor: "pointer",
            fontWeight: 600,
          }}>
            {t("cmd.insert.table")}
          </button>
        </div>
      </div>
    </div>
  );
}

type Alignment = "left" | "center" | "right";

interface ParsedTable {
  headers: string[];
  rows: string[][];
  alignments: Alignment[];
}

function parseTable(md: string): ParsedTable {
  const lines = md.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return { headers: ["Column 1"], rows: [[""]],  alignments: ["left"] };

  const parseRow = (line: string) =>
    line.split("|").map((c) => c.trim()).filter(Boolean);

  const headers = parseRow(lines[0]);

  // Parse alignment from separator line
  const separators = parseRow(lines[1]);
  const alignments: Alignment[] = separators.map((s) => {
    if (s.startsWith(":") && s.endsWith(":")) return "center";
    if (s.endsWith(":")) return "right";
    return "left";
  });

  const rows = lines.slice(2).map(parseRow);

  // Ensure all rows have same column count
  const cols = headers.length;
  const normalized = rows.map((r) => {
    while (r.length < cols) r.push("");
    return r.slice(0, cols);
  });

  return { headers, rows: normalized.length ? normalized : [[...Array(cols)].map(() => "")], alignments };
}

function toMarkdown(headers: string[], rows: string[][], alignments: Alignment[]): string {
  const pad = (s: string, len: number) => s.padEnd(len);
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length), 3),
  );

  const headerLine = "| " + headers.map((h, i) => pad(h, colWidths[i])).join(" | ") + " |";
  const sepLine =
    "| " +
    alignments
      .map((a, i) => {
        const w = colWidths[i];
        if (a === "center") return ":" + "-".repeat(w - 2) + ":";
        if (a === "right") return "-".repeat(w - 1) + ":";
        return ":" + "-".repeat(w - 1);
      })
      .join(" | ") +
    " |";
  const dataLines = rows.map(
    (row) => "| " + row.map((c, i) => pad(c, colWidths[i])).join(" | ") + " |",
  );

  return [headerLine, sepLine, ...dataLines].join("\n");
}
