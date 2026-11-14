/**
 * Live SQL preview — runs the fence body against an in-memory SQLite database
 * via sql.js (SQLite compiled to WebAssembly), lazy-loaded from a CDN on first
 * run. Each block gets a fresh database, so a CREATE/INSERT/SELECT script runs
 * end-to-end. Results render as tables.
 */
import { useRef, useState } from "react";
import { Database, Play, Code2 } from "lucide-react";
import { t } from "../i18n";

interface Props {
  source: string;
  meta?: string;
}

interface QueryResult {
  columns: string[];
  values: unknown[][];
}
interface SqlDatabase {
  exec: (sql: string) => QueryResult[];
  close: () => void;
}
interface SqlJsStatic {
  Database: new () => SqlDatabase;
}

let sqlPromise: Promise<SqlJsStatic> | null = null;

async function getSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      // Self-hosted runtime: bundled from the npm package, no CDN. The old
      // jsDelivr <script> loader was silently blocked by the app's CSP
      // (script-src 'self'), so SQL blocks NEVER worked in production —
      // caught by the live-exec e2e. Local hosting also makes it work
      // offline.
      const [mod, wasm] = await Promise.all([
        import("sql.js"),
        import("sql.js/dist/sql-wasm.wasm?url"),
      ]);
      const init = mod.default as unknown as (cfg: {
        locateFile: (f: string) => string;
      }) => Promise<SqlJsStatic>;
      return init({ locateFile: () => wasm.default });
    })().catch((err) => {
      sqlPromise = null;
      throw err;
    });
  }
  return sqlPromise;
}

type RunState = "idle" | "loading" | "running" | "success" | "error";

export default function LiveSqlBlock({ source, meta }: Props) {
  const heightMatch = meta?.match(/height=(\d+)/);
  const height = heightMatch ? Number(heightMatch[1]) : 280;
  const [results, setResults] = useState<QueryResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<RunState>("idle");
  const [showSource, setShowSource] = useState(false);
  const runSeq = useRef(0);

  async function run() {
    const seq = ++runSeq.current;
    setResults([]);
    setError(null);
    setState("loading");
    let SQL: SqlJsStatic;
    try {
      SQL = await getSql();
    } catch (err) {
      if (seq !== runSeq.current) return;
      setState("error");
      setError(`Failed to load the SQLite runtime (sql.js). ${(err as Error).message}`);
      return;
    }
    if (seq !== runSeq.current) return;
    setState("running");
    const db = new SQL.Database();
    try {
      const res = db.exec(source);
      if (seq !== runSeq.current) return;
      setResults(res);
      setState("success");
    } catch (err) {
      if (seq !== runSeq.current) return;
      setError(String((err as Error).message ?? err));
      setState("error");
    } finally {
      db.close();
    }
  }

  const stateLabel = {
    idle: "Not run",
    loading: "Loading SQLite…",
    running: "Running…",
    success: results.length ? "Completed" : "OK (no rows)",
    error: "Error",
  }[state];

  return (
    <div className="chart-block">
      <div className="chart-block-header">
        <span>
          <Database size={12} style={{ display: "inline", marginInlineEnd: 4 }} />
          {t("block.liveSql.title")}
        </span>
        <div className="chart-block-tabs">
          <button
            type="button"
            className="chart-block-tab"
            onClick={run}
            disabled={state === "loading" || state === "running"}
            title={t("block.liveSql.run")}
            aria-label={t("block.liveSql.run")}
          >
            <Play size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
            {t("block.common.run")}
          </button>
          <button
            type="button"
            className={`chart-block-tab ${showSource ? "active" : ""}`}
            onClick={() => setShowSource((v) => !v)}
            aria-pressed={showSource}
            title={t("block.common.toggleSource")}
          >
            <Code2 size={11} style={{ display: "inline", marginInlineEnd: 4 }} />
            {t("block.common.source")}
          </button>
        </div>
      </div>
      {showSource && (
        <pre
          style={{
            margin: 0,
            padding: "0.75rem 1rem",
            background: "hsl(var(--bg-muted))",
            color: "hsl(var(--fg))",
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            fontSize: 12,
            overflow: "auto",
            maxHeight: 200,
            whiteSpace: "pre",
          }}
        >
          <code>{source}</code>
        </pre>
      )}
      <div
        style={{
          marginBottom: 6,
          fontSize: 11,
          color: state === "error" ? "hsl(0 80% 65%)" : "hsl(var(--fg-muted))",
          textAlign: "right",
        }}
      >
        SQL: {stateLabel}
      </div>
      <div style={{ maxHeight: height, overflow: "auto", padding: "0 4px 8px" }}>
        {error ? (
          <div style={{ color: "hsl(0 80% 65%)", fontFamily: "monospace", fontSize: 12 }}>
            {error}
          </div>
        ) : results.length === 0 ? (
          <span style={{ color: "hsl(var(--fg-muted))", fontStyle: "italic", fontSize: 12 }}>
            {state === "success" ? t("block.liveSql.noResult") : t("block.liveSql.prompt")}
          </span>
        ) : (
          results.map((r, i) => (
            <table key={i} className="data-table" style={{ marginBottom: 12, fontSize: 13 }}>
              <thead>
                <tr>
                  {r.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.values.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci}>{cell === null ? "NULL" : String(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ))
        )}
      </div>
    </div>
  );
}
