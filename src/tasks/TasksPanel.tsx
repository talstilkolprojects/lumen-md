/**
 * Today / Upcoming (plan 4.13.3): overdue and today's tasks, then the next
 * 7 days, across the vault. Opens in its own React root on demand, so
 * nothing of it is on the startup path. Reminders (4.13.4) are switched on
 * from here.
 */
import { useCallback, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { t } from "../i18n";
import { TaskList } from "./TaskList";
import type { QueryResult } from "./taskQuery";
import type { Task } from "./taskParser";
import { todayIso, toggleTaskInVault } from "./toggle";
import { remindersEnabled, setRemindersEnabled, startReminders } from "./reminders";

export const TODAY_QUERY = "not done\n(due on or before today) OR (scheduled on or before today)\nsort by due";
export const UPCOMING_QUERY = "not done\n(due after today) OR (scheduled after today)\n(due on or before in 7 days) OR (scheduled on or before in 7 days)\nsort by due";

function Panel({ onClose }: { onClose: () => void }) {
  const [today, setToday] = useState<QueryResult | null>(null);
  const [upcoming, setUpcoming] = useState<QueryResult | null>(null);
  const [tick, setTick] = useState(0);
  const [reminders, setReminders] = useState(remindersEnabled());
  const [changed, setChanged] = useState(false);
  const now = todayIso();

  useEffect(() => {
    let alive = true;
    void import("../storage/workspaceIndex").then(async (m) => {
      const [a, b] = await Promise.all([m.queryVaultTasks(TODAY_QUERY), m.queryVaultTasks(UPCOMING_QUERY)]);
      if (alive) {
        setToday(a);
        setUpcoming(b);
      }
    });
    return () => {
      alive = false;
    };
  }, [tick]);

  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    window.addEventListener("lumen-workspace-changed", again);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("lumen-workspace-changed", again);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const onToggle = useCallback(async (task: Task) => {
    setChanged(!(await toggleTaskInVault(task)));
    setTick((n) => n + 1);
  }, []);

  const toggleReminders = async () => {
    const on = !reminders;
    const ok = await setRemindersEnabled(on);
    setReminders(ok && on);
  };

  return (
    <div role="dialog" aria-label={t("tasks.panel.title")} className="lumen-tasks-panel" style={{ position: "fixed", insetBlockStart: 56, insetInlineEnd: 16, width: "min(420px, calc(100vw - 32px))", maxHeight: "70vh", overflow: "auto", background: "hsl(var(--bg-elevated, var(--bg)))", color: "hsl(var(--fg))", border: "1px solid hsl(var(--border))", borderRadius: 10, boxShadow: "0 12px 32px -8px rgb(0 0 0 / .35)", zIndex: 60, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <strong style={{ flex: 1 }}>{t("tasks.panel.title")}</strong>
        <label style={{ fontSize: 12, display: "inline-flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" checked={reminders} onChange={() => void toggleReminders()} data-testid="tasks-reminders" />
          {t("tasks.reminders")}
        </label>
        <button type="button" onClick={onClose} aria-label={t("tasks.panel.close")} style={{ background: "none", border: 0, cursor: "pointer", color: "inherit" }}>
          ✕
        </button>
      </div>
      {changed ? <p role="status" style={{ color: "hsl(0 70% 55%)", fontSize: 13 }}>{t("tasks.changed")}</p> : null}
      <h4 style={{ margin: "4px 0" }}>{t("tasks.panel.today")}</h4>
      {today ? <TaskList tasks={today.groups[0]?.tasks ?? []} onToggle={onToggle} today={now} /> : <p>{t("tasks.loading")}</p>}
      <h4 style={{ margin: "12px 0 4px" }}>{t("tasks.panel.upcoming")}</h4>
      {upcoming ? <TaskList tasks={upcoming.groups[0]?.tasks ?? []} onToggle={onToggle} today={now} /> : <p>{t("tasks.loading")}</p>}
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

export function openTasksPanel(): void {
  if (!host) {
    host = document.createElement("div");
    host.id = "lumen-tasks-panel-root";
    document.body.appendChild(host);
    root = createRoot(host);
  }
  root!.render(<Panel onClose={closeTasksPanel} />);
  startReminders();
}

export function closeTasksPanel(): void {
  root?.render(<></>);
}
