/** A list of tasks with their note, dates and a checkbox (plan 4.13), shared by the block and the panel. */
import { t } from "../i18n";
import type { Task } from "./taskParser";

const PRIORITY_MARK: Record<string, string> = { highest: "🔺", high: "⏫", medium: "🔼", low: "🔽", lowest: "⏬", none: "" };

export interface TaskListProps {
  tasks: Task[];
  hide?: Set<string>;
  onToggle: (task: Task) => void;
  today: string;
}

const open = (task: Task) => window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path: task.path, heading: task.heading ?? undefined } }));

export function TaskList({ tasks, hide = new Set(), onToggle, today }: TaskListProps) {
  if (!tasks.length) return <p className="lumen-tasks-empty">{t("tasks.none")}</p>;
  return (
    <ul className="lumen-tasks" style={{ listStyle: "none", paddingInlineStart: 0, margin: 0 }}>
      {tasks.map((task) => {
        const done = task.status === "DONE" || task.status === "CANCELLED";
        const overdue = !done && !!task.due && task.due < today;
        return (
          <li key={`${task.path}:${task.line}`} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "2px 0" }} data-testid="task-row">
            <input type="checkbox" checked={done} onChange={() => onToggle(task)} aria-label={t("tasks.toggle", { task: task.description })} />
            <span dir="auto" style={{ textDecoration: done ? "line-through" : undefined, opacity: done ? 0.6 : 1, flex: 1 }}>
              {task.description}
              {!hide.has("priority") && PRIORITY_MARK[task.priority] ? <span style={{ marginInlineStart: 6 }}>{PRIORITY_MARK[task.priority]}</span> : null}
              {!hide.has("due date") && task.due ? (
                <span style={{ marginInlineStart: 6, color: overdue ? "hsl(0 70% 55%)" : "hsl(var(--fg-muted))", fontSize: "0.9em" }}>
                  📅 <bdi>{task.due}</bdi>
                </span>
              ) : null}
              {!hide.has("scheduled date") && task.scheduled ? <span style={{ marginInlineStart: 6, color: "hsl(var(--fg-muted))", fontSize: "0.9em" }}>⏳ <bdi>{task.scheduled}</bdi></span> : null}
              {!hide.has("recurrence rule") && task.recurrence ? <span style={{ marginInlineStart: 6, color: "hsl(var(--fg-muted))", fontSize: "0.9em" }}>🔁 {task.recurrence}</span> : null}
            </span>
            {!hide.has("backlink") ? (
              <button type="button" className="lumen-task-link" onClick={() => open(task)} style={{ background: "none", border: 0, color: "hsl(var(--accent))", cursor: "pointer", fontSize: "0.85em" }}>
                <bdi>{task.path.replace(/\.md$/, "")}</bdi>
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
