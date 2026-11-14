/**
 * Product metrics without tracking (plan W4.26): counters that stay on this
 * device, and a weekly report the user sends by hand.
 *
 * What is counted, per day, in localStorage (`lumen.usage.v1`):
 *   - opens: how many times the app started;
 *   - features: how many times each command ran, by its command id (a fixed
 *     identifier from the app's code, such as "file.exportHtml"); an id that
 *     does not look like one (free text, a path, anything with spaces) is
 *     refused, so nothing a user typed can be counted under its own name;
 *   - errors: how many uncaught errors happened, as one number (no message,
 *     no stack, no file name).
 * There is no user id, no device id, no note content and no time of day.
 * The last 60 days are kept. Counting can be turned off, which also clears
 * the counts.
 *
 * This module never makes a request. The report (`weeklyReport`) is plain
 * JSON the dialog shows in full; it leaves only when the user clicks "Open
 * on GitHub" (a new github.com tab with an issue form filled in, recorded in
 * the privacy ledger) or "Copy". The weekly reminder is off until the user
 * turns it on.
 */

import { version as appVersion } from "../../package.json";

export const USAGE_KEY = "lumen.usage.v1";
/** "0" when the user turned counting off (counting is on by default; it never leaves the device). */
export const COUNTING_KEY = "lumen.usage.counting";
/** "1" when the user asked for the weekly report reminder (off by default). */
export const WEEKLY_KEY = "lumen.usage.weekly";
/** The day the user last sent or dismissed a weekly report (YYYY-MM-DD). */
export const LAST_REPORT_KEY = "lumen.usage.lastReport";
export const KEEP_DAYS = 60;
/**
 * A command id: dotted lower-camel segments ("file.exportHtml",
 * "ai.prompt.en.code_review"). No spaces, slashes or other punctuation, and
 * no run of 3 digits or 3 capitals, which every id in the app avoids and
 * keys, PINs and phone numbers do not.
 */
export const FEATURE_ID = /^(?!.*(?:\d{3}|[A-Z]{3}))[a-z][a-zA-Z0-9_]{0,39}(?:[.:-][a-zA-Z0-9_]{1,40}){0,5}$/;

/**
 * Command ids made from something in the vault (review 12.11): an installed
 * template's file name, a recent file's name hash, a plugin's own command.
 * Each family is counted under one fixed id, so no name is ever kept, and
 * the report can't carry one.
 */
const FAMILIES: readonly (readonly [RegExp, string])[] = [
  [/^template\.installed\./, "template.apply"],
  [/^recent\.remove\./, "recent.remove"],
  [/^recent\./, "recent.open"],
  [/^plugin:/, "plugin.command"],
];

/** The id a command is counted under: its family's fixed id, or itself. */
export function featureId(id: string): string {
  for (const [re, fixed] of FAMILIES) if (re.test(id)) return fixed;
  return id;
}

export interface UsageDay {
  opens: number;
  errors: number;
  features: Record<string, number>;
}
export interface UsageStore {
  v: 1;
  /** The first day anything was counted: activation. */
  firstDay: string | null;
  days: Record<string, UsageDay>;
}

/** YYYY-MM-DD in local time: a day as the user lives it. */
export function dayKey(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

const emptyStore = (): UsageStore => ({ v: 1, firstDay: null, days: {} });

/** Read the counts; a missing, unreadable or foreign value is an empty store. */
export function loadUsage(storage: Pick<Storage, "getItem"> | null = safeStorage()): UsageStore {
  try {
    const raw = storage?.getItem(USAGE_KEY);
    if (!raw) return emptyStore();
    const v = JSON.parse(raw) as Partial<UsageStore>;
    if (v?.v !== 1 || typeof v.days !== "object" || v.days === null) return emptyStore();
    const days: Record<string, UsageDay> = {};
    for (const [d, x] of Object.entries(v.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !x || typeof x !== "object") continue;
      const features: Record<string, number> = {};
      for (const [id, n] of Object.entries(x.features ?? {})) if (FEATURE_ID.test(id) && Number.isFinite(n) && n > 0) features[id] = Math.floor(n);
      days[d] = { opens: count(x.opens), errors: count(x.errors), features };
    }
    return { v: 1, firstDay: typeof v.firstDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.firstDay) ? v.firstDay : null, days };
  } catch {
    return emptyStore();
  }
}
const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Is counting on? On unless the user turned it off. */
export function countingEnabled(storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  try {
    return storage?.getItem(COUNTING_KEY) !== "0";
  } catch {
    return false;
  }
}

/** Turn counting on or off; off also clears every count. */
export function setCounting(on: boolean, storage: Storage | null = safeStorage()): void {
  try {
    if (on) storage?.removeItem(COUNTING_KEY);
    else {
      storage?.setItem(COUNTING_KEY, "0");
      storage?.removeItem(USAGE_KEY);
    }
  } catch {
    // why: storage refused — nothing is counted without it anyway
  }
}

/** Drop days older than KEEP_DAYS before `today`. */
export function prune(store: UsageStore, today: string): UsageStore {
  const cutoff = shiftDay(today, -(KEEP_DAYS - 1));
  const days = Object.fromEntries(Object.entries(store.days).filter(([d]) => d >= cutoff));
  return { ...store, days };
}

/** `day` moved by `n` days. */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + n));
}

type Bump = { kind: "open" } | { kind: "error" } | { kind: "feature"; id: string };

/** The store after one event on `today`; unchanged for a feature id that is not a command id. */
export function bump(store: UsageStore, event: Bump, today: string): UsageStore {
  if (event.kind === "feature") event = { kind: "feature", id: featureId(event.id) };
  if (event.kind === "feature" && !FEATURE_ID.test(event.id)) return store;
  const next = prune({ ...store, firstDay: store.firstDay ?? today, days: { ...store.days } }, today);
  const day = { ...(next.days[today] ?? { opens: 0, errors: 0, features: {} }) };
  day.features = { ...day.features };
  if (event.kind === "open") day.opens++;
  else if (event.kind === "error") day.errors++;
  else day.features[event.id] = (day.features[event.id] ?? 0) + 1;
  next.days[today] = day;
  return next;
}

function apply(event: Bump, storage: Storage | null = safeStorage(), at: Date = new Date()): void {
  if (!storage || !countingEnabled(storage)) return;
  if (event.kind === "feature" && !FEATURE_ID.test(featureId(event.id))) return;
  try {
    storage.setItem(USAGE_KEY, JSON.stringify(bump(loadUsage(storage), event, dayKey(at))));
  } catch {
    // why: storage full or refused — a lost count is not worth an error
  }
}

/** The app started. */
export const countOpen = (storage?: Storage | null, at?: Date) => apply({ kind: "open" }, storage, at);
/** A command ran (its command id; anything else is ignored). */
export const countFeature = (id: string, storage?: Storage | null, at?: Date) => apply({ kind: "feature", id }, storage, at);
/** An uncaught error happened (counted only, nothing about it is kept). */
export const countError = (storage?: Storage | null, at?: Date) => apply({ kind: "error" }, storage, at);

let listening = false;
/** Count uncaught errors and rejections from now on (once). */
export function listenForErrors(target: Pick<Window, "addEventListener"> = window): void {
  if (listening) return;
  listening = true;
  target.addEventListener("error", () => countError());
  target.addEventListener("unhandledrejection", () => countError());
}

export interface UsageSummary {
  /** The first day counted, or null. */
  activatedOn: string | null;
  daysActive7: number;
  daysActive30: number;
  /** Was the app used in the 7 days before the last 7 (retention: did they come back)? */
  retained7: boolean | null;
  retained30: boolean | null;
  opens7: number;
  errors7: number;
  /** Command id → runs in the last 30 days, most used first. */
  features30: Array<[string, number]>;
}

const activeIn = (store: UsageStore, from: string, to: string) => Object.keys(store.days).filter((d) => d >= from && d <= to && (store.days[d].opens > 0 || Object.keys(store.days[d].features).length > 0));

/**
 * The internal dashboard: activation, days active, 7- and 30-day retention
 * (used in the window before and again in the latest one), top features.
 * Retention is null while the counts are younger than the window.
 */
export function summarize(store: UsageStore, today: string): UsageSummary {
  const s7 = shiftDay(today, -6);
  const s30 = shiftDay(today, -29);
  const retained = (n: number): boolean | null => {
    if (!store.firstDay || store.firstDay > shiftDay(today, -n)) return null;
    const before = activeIn(store, shiftDay(today, -(2 * n - 1)), shiftDay(today, -n)).length > 0;
    return before && activeIn(store, shiftDay(today, -(n - 1)), today).length > 0;
  };
  const features = new Map<string, number>();
  let opens7 = 0;
  let errors7 = 0;
  for (const [d, x] of Object.entries(store.days)) {
    if (d >= s30 && d <= today) for (const [id, n] of Object.entries(x.features)) features.set(id, (features.get(id) ?? 0) + n);
    if (d >= s7 && d <= today) {
      opens7 += x.opens;
      errors7 += x.errors;
    }
  }
  return {
    activatedOn: store.firstDay,
    daysActive7: activeIn(store, s7, today).length,
    daysActive30: activeIn(store, s30, today).length,
    retained7: retained(7),
    retained30: retained(30),
    opens7,
    errors7,
    features30: [...features.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
}

/** Command ids that ran in none of the last 30 days: the dead features, given the full list. */
export function unusedFeatures(summary: UsageSummary, allIds: readonly string[]): string[] {
  const used = new Set(summary.features30.map(([id]) => id));
  return [...new Set(allIds.map(featureId))].filter((id) => FEATURE_ID.test(id) && !used.has(id)).sort();
}

export interface WeeklyReport {
  kind: "lumen-usage-report";
  v: 1;
  app: string;
  /** The Monday (local) that starts the week the report covers. */
  week: string;
  activatedWeeksAgo: number | null;
  daysActive7: number;
  daysActive30: number;
  retained7: boolean | null;
  retained30: boolean | null;
  opens7: number;
  errors7: number;
  /** The 20 most used commands of the last 30 days, with their counts. */
  topFeatures: Record<string, number>;
  /** How many of the app's commands ran in none of the last 30 days. */
  unusedFeatures: number;
}

/**
 * The report the dialog shows and the user may send: counts only, nothing
 * else. Only the app's command ids are reported (an allowlist: with none
 * given, no command is), each family under its fixed id (featureId), so a
 * counter name that slipped past FEATURE_ID, or one made from a file name,
 * stays on the device.
 */
export function weeklyReport(store: UsageStore, today: string, allIds: readonly string[] = [], app = appVersion): WeeklyReport {
  const known = new Set(allIds.map(featureId));
  const all = summarize(store, today);
  const s = { ...all, features30: all.features30.filter(([id]) => known.has(id) && featureId(id) === id) };
  const [y, m, d] = today.split("-").map(Number);
  const weekday = (new Date(y, m - 1, d).getDay() + 6) % 7;
  const week = shiftDay(today, -weekday);
  const weeksAgo = s.activatedOn ? Math.floor((new Date(y, m - 1, d).getTime() - new Date(`${s.activatedOn}T00:00:00`).getTime()) / (7 * 86_400_000)) : null;
  return {
    kind: "lumen-usage-report",
    v: 1,
    app,
    week,
    activatedWeeksAgo: weeksAgo,
    daysActive7: s.daysActive7,
    daysActive30: s.daysActive30,
    retained7: s.retained7,
    retained30: s.retained30,
    opens7: s.opens7,
    errors7: s.errors7,
    topFeatures: Object.fromEntries(s.features30.slice(0, 20)),
    unusedFeatures: unusedFeatures(s, allIds).length,
  };
}

/** Is the weekly reminder on, and has a week passed since the last report? */
export function weeklyDue(today: string, storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  try {
    if (storage?.getItem(WEEKLY_KEY) !== "1") return false;
    const last = storage.getItem(LAST_REPORT_KEY);
    return !last || last <= shiftDay(today, -7);
  } catch {
    return false;
  }
}

/** The weekly reminder on or off. */
export function setWeekly(on: boolean, storage: Storage | null = safeStorage()): void {
  try {
    if (on) storage?.setItem(WEEKLY_KEY, "1");
    else storage?.removeItem(WEEKLY_KEY);
  } catch {
    // why: storage refused — the reminder stays off
  }
}

/** Remember that this week's report was sent or dismissed. */
export function markReported(today: string, storage: Storage | null = safeStorage()): void {
  try {
    storage?.setItem(LAST_REPORT_KEY, today);
  } catch {
    // why: storage refused — the reminder may come back next start
  }
}

/** The repository the report goes to, as a GitHub issue the user opens. */
export const USAGE_REPO = "talstilkol/lumen-md";

/** github.com's new-issue form with the report as its body. */
export function reportIssueUrl(report: WeeklyReport, repo = USAGE_REPO): string {
  const p = new URLSearchParams({
    title: `Usage report: week of ${report.week} (Lumen ${report.app})`,
    labels: "usage-report",
    body: "```json\n" + JSON.stringify(report, null, 2) + "\n```\n",
  });
  return `https://github.com/${repo}/issues/new?${p.toString()}`;
}
