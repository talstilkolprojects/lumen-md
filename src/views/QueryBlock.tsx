/**
 * QueryBlock — renders a ```query block (plan 11.3 operators, plan W2.12)
 * or a ```dataview block (a subset of Obsidian Dataview) as a list or a
 * table of notes, and keeps it current: every save in the vault re-runs it
 * (vault write events, then the workspace index's catch-up).
 *
 * Loaded on demand by the preview (renderer/components.tsx), so none of it
 * is in the startup bundle. Nothing in a query is evaluated as code: the
 * query language is parsed and interpreted (search/dataview.ts).
 */

import { useEffect, useMemo, useState } from "react";
import { AlertCircle } from "lucide-react";
import { t } from "../i18n";
import { ensureIndex, indexedNotes, searchWorkspace } from "../storage/workspaceIndex";
import { watchVault } from "../storage/vault";
import { onWorkspaceChanged } from "../storage/workspaceEvents";
import { useAppStore } from "../store/useStore";
import { MAX_LIMIT, parseEmbeddedQuery, rowsFor, type QueryNote, type QueryRow } from "../search/embeddedQuery";
import { DataviewError, parseDataview, runDataview, show, type DvResult, type Value } from "../search/dataview";
import "./queryBlockStrings";
import { EmptyState, learnHow } from "../ui/EmptyState";

interface Props {
  source: string;
  lang: string;
}

type Outcome =
  | { kind: "query"; view: "list" | "table"; rows: QueryRow[] }
  | { kind: "dataview"; result: DvResult }
  | { kind: "error"; message: string };

function selfPath(): string | null {
  return useAppStore.getState().doc.workspaceName ?? null;
}

function NoteLink({ path, name }: { path: string; name: string }) {
  return (
    <a className="wiki-link" href="#" data-wiki-target={path.replace(/\.md$/i, "")} dir="auto">
      {name}
    </a>
  );
}

function Cell({ v }: { v: Value }) {
  if (v && typeof v === "object" && !Array.isArray(v) && "link" in v && "display" in v && typeof v.link === "string") {
    return <NoteLink path={v.link} name={String(v.display)} />;
  }
  return <span dir="auto">{show(v)}</span>;
}

export default function QueryBlock({ source, lang }: Props) {
  const isDataview = lang === "dataview";
  const parsed = useMemo(() => {
    if (!isDataview) return { q: parseEmbeddedQuery(source), dv: null, error: null };
    try {
      return { q: null, dv: parseDataview(source), error: null };
    } catch (e) {
      return { q: null, dv: null, error: e instanceof DataviewError ? e.message : String(e) };
    }
  }, [source, isDataview]);
  const [out, setOut] = useState<Outcome | null>(null);
  const [runs, setRuns] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let seq = 0;
    const run = async () => {
      const mine = ++seq;
      try {
        let next: Outcome;
        if (parsed.error) next = { kind: "error", message: parsed.error };
        else if (parsed.dv) {
          await ensureIndex();
          const self = selfPath();
          // W2.22: the text is read from the index for this run, then let go.
          const notes = (await indexedNotes()).filter((f) => f.path !== self);
          next = { kind: "dataview", result: runDataview(parsed.dv, notes) };
        } else {
          const q = parsed.q!;
          if (!q.query.trim()) next = { kind: "error", message: t("query.empty") };
          else {
            const hits = await searchWorkspace(q.query, { limit: MAX_LIMIT + 1 });
            const notes = new Map<string, QueryNote>((await indexedNotes(hits.map((h) => h.path))).map((f) => [f.path, f]));
            next = { kind: "query", view: q.view, rows: rowsFor(q, hits, notes, selfPath()) };
          }
        }
        if (!cancelled && mine === seq) {
          setOut(next);
          setRuns((n) => n + 1);
        }
      } catch (e) {
        if (!cancelled && mine === seq) setOut({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    };
    void run();
    // A save anywhere in the vault: re-run at once (the index re-reads only what changed).
    const offVault = watchVault((e) => {
      if (e.type === "write" || e.type === "delete" || e.type === "rename") void run();
    });
    const offWs = onWorkspaceChanged(() => void run(), { debounceMs: 50 });
    return () => {
      cancelled = true;
      offVault();
      offWs();
    };
  }, [parsed]);

  const problems = parsed.q?.problems ?? [];
  const count = out?.kind === "query" ? out.rows.length : out?.kind === "dataview" ? out.result.rows.length : 0;

  return (
    <div className="chart-block lumen-query-block" data-query-runs={runs} data-query-kind={isDataview ? "dataview" : "query"}>
      <div className="chart-block-header">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 600 }} dir="auto">
            {isDataview ? t("query.dataviewTitle") : parsed.q?.query || t("query.title")}
          </span>
          {out && out.kind !== "error" && <span style={{ fontSize: 11, color: "hsl(var(--fg-muted))" }}>{t("query.count", { count })}</span>}
        </span>
      </div>
      <div style={{ padding: 8 }}>
        {problems.length > 0 && (
          <div style={{ fontSize: 12, color: "hsl(var(--fg-muted))", paddingBottom: 6 }}>{t("query.badOptions", { options: problems.join(", ") })}</div>
        )}
        {!out && <div style={{ fontSize: 12, color: "hsl(var(--fg-muted))" }}>{t("query.loading")}</div>}
        {out?.kind === "error" && (
          <div role="alert" style={{ color: "hsl(0 80% 60%)", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
            <AlertCircle size={14} />
            {t("query.error", { error: out.message })}
          </div>
        )}
        {out && out.kind !== "error" && count === 0 && <EmptyState style={{ padding: 0, fontSize: 13 }} message={t("query.none")} action={learnHow("workspace/embedded-queries#query-blocks")} />}
        {out?.kind === "query" && count > 0 && out.view === "list" && (
          <ul className="lumen-query-list">
            {out.rows.map((r) => (
              <li key={r.path}>
                <NoteLink path={r.path} name={r.name} />
                {r.snippet && (
                  <span style={{ color: "hsl(var(--fg-muted))", fontSize: 12 }} dir="auto">
                    {" — "}
                    {r.snippet}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {out?.kind === "query" && count > 0 && out.view === "table" && (
          <table className="lumen-query-table">
            <thead>
              <tr>
                <th>{t("query.col.note")}</th>
                <th>{t("query.col.folder")}</th>
                <th>{t("query.col.modified")}</th>
                <th>{t("query.col.tags")}</th>
              </tr>
            </thead>
            <tbody>
              {out.rows.map((r) => (
                <tr key={r.path}>
                  <td>
                    <NoteLink path={r.path} name={r.name} />
                  </td>
                  <td dir="auto">{r.folder}</td>
                  <td>{r.modified ? new Date(r.modified).toLocaleDateString() : ""}</td>
                  <td dir="auto">{r.tags.map((x) => "#" + x).join(" ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {out?.kind === "dataview" && count > 0 && out.result.type === "list" && (
          <ul className="lumen-query-list">
            {out.result.rows.map((r) => (
              <li key={r.path}>
                <NoteLink path={r.path} name={r.name} />
                {r.cells.length > 0 && r.cells[0] !== null && (
                  <>
                    {": "}
                    <Cell v={r.cells[0]} />
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {out?.kind === "dataview" && count > 0 && out.result.type === "table" && (
          <table className="lumen-query-table">
            <thead>
              <tr>
                {out.result.headers.map((h, i) => (
                  <th key={i} dir="auto">
                    {i === 0 && h === "File" && out.result.headers.length > out.result.rows[0].cells.length ? t("query.col.note") : h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {out.result.rows.map((r) => (
                <tr key={r.path}>
                  {out.result.headers.length > r.cells.length && (
                    <td>
                      <NoteLink path={r.path} name={r.name} />
                    </td>
                  )}
                  {r.cells.map((c, i) => (
                    <td key={i}>
                      <Cell v={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
