/**
 * Task reminders (plan 4.13.4). Opt-in. While Lumen is open, once a minute,
 * tasks due today (or scheduled for today) that were not announced yet get one
 * notification each: the browser's Notification API, or the OS notification
 * in the desktop app (the same API; Tauri's WebView implements it). Nothing
 * leaves the device. Which tasks were announced is kept per day.
 */
import type { Task } from "./taskParser";

const KEY = "lumen.tasks.reminders";
const SEEN = "lumen.tasks.reminded";

export function remindersEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Turn reminders on (asks for notification permission) or off. Returns whether they are on. */
export async function setRemindersEnabled(on: boolean, N: typeof Notification | undefined = globalThis.Notification): Promise<boolean> {
  if (!on) {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* why: storage denied: the in-memory meter is reset by the listeners below */
    }
    return false;
  }
  if (!N) return false;
  const perm = N.permission === "granted" ? "granted" : await N.requestPermission();
  if (perm !== "granted") return false;
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    return false;
  }
  startReminders();
  return true;
}

const key = (t: Task) => `${t.path}\u0000${t.description}`;

/** The tasks to announce now: due/scheduled today, not done, not announced today yet. */
export function dueNow(tasks: Task[], today: string, seen: Set<string>): Task[] {
  return tasks.filter((t) => (t.status === "TODO" || t.status === "IN_PROGRESS") && (t.due === today || t.scheduled === today) && !seen.has(key(t)));
}

function loadSeen(today: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN) ?? "{}") as { day?: string; keys?: string[] };
    return new Set(v.day === today ? v.keys : []);
  } catch {
    return new Set();
  }
}

function saveSeen(today: string, seen: Set<string>): void {
  try {
    localStorage.setItem(SEEN, JSON.stringify({ day: today, keys: [...seen] }));
  } catch {
    /* why: storage full: a reminder may repeat once */
  }
}

/** One check: announce what is due. Exported for tests. */
export async function checkReminders(deps: { tasks: () => Promise<Task[]>; notify: (title: string, body: string) => void; today: string }): Promise<number> {
  const seen = loadSeen(deps.today);
  const due = dueNow(await deps.tasks(), deps.today, seen);
  const { t } = await import("../i18n");
  for (const task of due) {
    deps.notify(t("tasks.reminder.title"), `${task.description} — ${task.path.replace(/\.md$/, "")}`);
    seen.add(key(task));
  }
  if (due.length) saveSeen(deps.today, seen);
  return due.length;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the once-a-minute check if reminders are on (idempotent). */
export function startReminders(): void {
  if (timer || !remindersEnabled() || typeof Notification === "undefined") return;
  const run = async () => {
    if (!remindersEnabled()) {
      if (timer) clearInterval(timer);
      timer = null;
      return;
    }
    const { todayIso } = await import("./toggle");
    const { queryVaultTasks } = await import("../storage/workspaceIndex");
    await checkReminders({
      today: todayIso(),
      tasks: async () => (await queryVaultTasks("not done\n(due today) OR (scheduled today)")).groups.flatMap((g) => g.tasks),
      notify: (title, body) => {
        if (Notification.permission === "granted") new Notification(title, { body, tag: `lumen-task-${body}` });
      },
    }).catch(() => undefined);
  };
  timer = setInterval(() => void run(), 60_000);
  void run();
}
