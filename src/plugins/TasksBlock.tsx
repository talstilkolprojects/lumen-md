/**
 * ```tasks``` block (plan 4.13.2): an obsidian-tasks query over every note in
 * the vault, run in the index worker. Re-runs when the vault changes.
 */
import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n";
import { TaskList } from "../tasks/TaskList";
import { parseQuery, type QueryResult } from "../tasks/taskQuery";
import { todayIso, toggleTaskInVault } from "../tasks/toggle";
import type { Task } from "../tasks/taskParser";

export default function TasksBlock({ source }: { source: string }) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const today = todayIso();
  const hide = parseQuery(source).hide;

  useEffect(() => {
    let alive = true;
    void import("../storage/workspaceIndex")
      .then((m) => m.queryVaultTasks(source))
      .then((r) => alive && (setResult(r), setError(null)))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [source, tick]);

  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    window.addEventListener("lumen-workspace-changed", again);
    return () => window.removeEventListener("lumen-workspace-changed", again);
  }, []);

  const onToggle = useCallback(async (task: Task) => {
    if (!(await toggleTaskInVault(task))) setError(t("tasks.changed"));
    setTick((n) => n + 1);
  }, []);

  return (
    <div className="chart-block lumen-tasks-block" data-testid="tasks-block">
      <div className="chart-block-header">
        <span>{result ? t("tasks.count", { n: result.total }) : t("tasks.loading")}</span>
      </div>
      <div style={{ padding: "0.5rem 0.75rem" }}>
        {error ? <p style={{ color: "hsl(0 70% 55%)", fontSize: 13 }}>{error}</p> : null}
        {result?.errors.map((e) => (
          <p key={`${e.code}:${e.text}`} style={{ color: "hsl(0 70% 55%)", fontSize: 13 }} dir="auto">
            ⚠︎ {t(`tasks.error.${e.code}`, { text: e.text })}
          </p>
        ))}
        {result?.groups.map((g, i) => (
          <section key={`${i}:${g.label ?? ""}:${g.name}`}>
            {g.label || g.name ? (
              <h4 style={{ margin: "0.5rem 0 0.25rem" }} dir="auto">
                {g.label ? t(`tasks.group.${g.label}`) : g.name}
              </h4>
            ) : null}
            <TaskList tasks={g.tasks} hide={hide} onToggle={onToggle} today={today} />
          </section>
        ))}
      </div>
    </div>
  );
}
