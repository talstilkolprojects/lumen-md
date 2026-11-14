/**
 * The beta programme (plan W6.31): joining from inside the app, feedback
 * without a server, and a weekly report the tester chooses to send.
 *
 * Joining is one switch, and it does three local things:
 *   - the desktop app's update channel becomes "beta", so the shell checks
 *     the beta-channel pointer of the release pipeline (#492:
 *     releases/download/beta-channel/latest.json) instead of "latest";
 *   - every feature flag in stage "beta" is turned on in this browser
 *     (the user's own overrides, as in Settings → Feature flags), so a
 *     stable web build shows the beta features too;
 *   - the day of joining is kept, to number the tester's weeks.
 * Leaving undoes all three (flags back to the build's default).
 *
 * The weekly report is a second, separate opt-in. It is the local usage
 * report of W4.26 (`weeklyReport`: counts only, the app's own command ids
 * only) with three fields added: the week of joining, how many weeks in,
 * and the update channel. It leaves the device only when the tester clicks
 * "Open on GitHub" (a prefilled issue they still submit themselves) or
 * "Copy". Feedback works the same way, as a prefilled issue labelled
 * `beta-feedback`. This module makes no request.
 */

import { FLAGS, setFlag, type Channel } from "../flags/flags";
import { feedbackBody, MAX_ISSUE_URL, type FeedbackEnvironment, type FeedbackKind } from "../feedback/feedback";
import { dayKey, shiftDay, weeklyReport, type UsageStore, type WeeklyReport } from "../metrics/usage";
import type { ActivationSummary } from "../metrics/activation";

export const BETA_KEY = "lumen.beta.v1";
/** The repository reports and feedback go to, as issues the tester opens. */
export const BETA_REPO = "talstilkol/lumen-md";
export const BETA_REPORT_LABEL = "beta-report";
export const BETA_FEEDBACK_LABEL = "beta-feedback";

export interface BetaEnrolment {
  v: 1;
  /** The day the tester joined (YYYY-MM-DD, local). */
  joined: string;
  /** "1" once the tester asked for the weekly report; off by default. */
  weeklyReport: boolean;
  /** The day the last weekly report was opened or copied. */
  lastReport: string | null;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The enrolment, or null when this device is not in the beta. */
export function readEnrolment(storage: Pick<Storage, "getItem"> | null = safeStorage()): BetaEnrolment | null {
  try {
    const raw = storage?.getItem(BETA_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<BetaEnrolment>;
    if (v?.v !== 1 || typeof v.joined !== "string" || !DAY.test(v.joined)) return null;
    return { v: 1, joined: v.joined, weeklyReport: v.weeklyReport === true, lastReport: typeof v.lastReport === "string" && DAY.test(v.lastReport) ? v.lastReport : null };
  } catch {
    return null;
  }
}

function write(e: BetaEnrolment | null, storage: Store | null): void {
  try {
    if (e) storage?.setItem(BETA_KEY, JSON.stringify(e));
    else storage?.removeItem(BETA_KEY);
  } catch {
    // why: storage refused — the switch lasts for this session only
  }
}

export interface BetaDeps {
  storage?: Store | null;
  /** The desktop update channel setter (src/desktop/updates.ts); tests pass a spy. */
  setChannel?: (c: Channel) => void;
  /** Turn one flag on, or back to its default (null). */
  setFlag?: (id: string, value: boolean | null) => void;
  /** The flags in stage "beta". */
  betaFlags?: readonly string[];
  today?: string;
}

/** The ids of the flags still in beta. */
export const betaFlagIds = (): string[] => FLAGS.filter((f) => f.stage === "beta").map((f) => f.id);

/** Join the beta on this device: beta update channel, beta flags on, the day kept. Joining again keeps the first day. */
export function joinBeta(deps: BetaDeps = {}): BetaEnrolment {
  const storage = deps.storage === undefined ? safeStorage() : deps.storage;
  const before = readEnrolment(storage);
  const e: BetaEnrolment = before ?? { v: 1, joined: deps.today ?? dayKey(), weeklyReport: false, lastReport: null };
  write(e, storage);
  deps.setChannel?.("beta");
  const flag = deps.setFlag ?? ((id: string, value: boolean | null) => setFlag(id, value, storage));
  for (const id of deps.betaFlags ?? betaFlagIds()) flag(id, true);
  return e;
}

/** Leave the beta: stable update channel, beta flags back to the build's default, the weekly report off. */
export function leaveBeta(deps: BetaDeps = {}): void {
  const storage = deps.storage === undefined ? safeStorage() : deps.storage;
  write(null, storage);
  deps.setChannel?.("stable");
  const flag = deps.setFlag ?? ((id: string, value: boolean | null) => setFlag(id, value, storage));
  for (const id of deps.betaFlags ?? betaFlagIds()) flag(id, null);
}

/** The weekly report on or off (only for a tester who joined). */
export function setBetaWeekly(on: boolean, storage: Store | null = safeStorage()): BetaEnrolment | null {
  const e = readEnrolment(storage);
  if (!e) return null;
  const next = { ...e, weeklyReport: on };
  write(next, storage);
  return next;
}

/** Remember that this week's report left (opened on GitHub or copied). */
export function markBetaReported(today: string, storage: Store | null = safeStorage()): void {
  const e = readEnrolment(storage);
  if (e) write({ ...e, lastReport: today }, storage);
}

/** Is a weekly report due: joined, opted in, and a week since the last one (or none yet)? */
export function betaReportDue(today: string, storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  const e = readEnrolment(storage);
  if (!e?.weeklyReport) return false;
  return !e.lastReport || e.lastReport <= shiftDay(today, -7);
}

export interface BetaReport extends Omit<WeeklyReport, "kind"> {
  kind: "lumen-beta-report";
  /** The Monday of the week the tester joined: their cohort. */
  cohort: string;
  /** Whole weeks since joining (0 in the first week). */
  weeksInBeta: number;
  channel: Channel;
  /**
   * Plan W11.P4: activation and TTFV as computed on the device — yes/no
   * facts and averages only (the mean TTFV-1 rounded to 100 ms, TTFV-2 to
   * the second), never the samples or a time of day. Null when none was given.
   */
  activation: ActivationSummary | null;
}

const monday = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return shiftDay(day, -((new Date(y, m - 1, d).getDay() + 6) % 7));
};
const daysBetween = (a: string, b: string) => {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((new Date(y2, m2 - 1, d2).getTime() - new Date(y1, m1 - 1, d1).getTime()) / 86_400_000);
};

/**
 * The beta report: W4.26's weekly report (counts, the app's command ids
 * only) plus the cohort, weeks in the beta, the channel and the activation
 * summary (W11.P4). Nothing else.
 */
export function betaReport(store: UsageStore, enrolment: BetaEnrolment, today: string, allIds: readonly string[], channel: Channel, app?: string, activation: ActivationSummary | null = null): BetaReport {
  const base = weeklyReport(store, today, allIds, app);
  const { kind: _kind, ...rest } = base;
  void _kind;
  return { kind: "lumen-beta-report", ...rest, cohort: monday(enrolment.joined), weeksInBeta: Math.max(0, Math.floor(daysBetween(enrolment.joined, today) / 7)), channel, activation: activation && pickActivation(activation) };
}

/** Only the summary's own fields, so nothing else rides along. */
const pickActivation = (a: ActivationSummary): ActivationSummary => ({
  activated: a.activated,
  ownNote: a.ownNote,
  imported: a.imported,
  returnedDay2: a.returnedDay2,
  ttfv1MeanMs: a.ttfv1MeanMs,
  ttfv1Launches: a.ttfv1Launches,
  ttfv2Ms: a.ttfv2Ms,
});

/** github.com's new-issue form with the beta report as its body, labelled `beta-report`. */
export function betaReportUrl(report: BetaReport, repo = BETA_REPO): string {
  const p = new URLSearchParams({
    title: `Beta report: week of ${report.week} (cohort ${report.cohort}, Lumen ${report.app})`,
    labels: BETA_REPORT_LABEL,
    body: "```json\n" + JSON.stringify(report, null, 2) + "\n```\n",
  });
  return `https://github.com/${repo}/issues/new?${p.toString()}`;
}

/** The parts of the app a tester can name in feedback (a fixed list: nothing free-form goes into labels). */
export const BETA_AREAS = ["editor", "hebrew", "search", "files", "ai", "sync", "mobile", "other"] as const;
export type BetaArea = (typeof BETA_AREAS)[number];

export interface BetaFeedback {
  kind: FeedbackKind;
  area: BetaArea;
  title: string;
  description: string;
  /** Week of the beta the tester is in, when they joined. */
  weeksInBeta?: number | null;
  environment?: FeedbackEnvironment | null;
}

const KIND_PREFIX: Record<FeedbackKind, string> = { bug: "Bug", idea: "Idea", question: "Question" };

/** The beta feedback issue: title, body (the feedback dialog's own format) and the `beta-feedback` label. */
export function betaFeedbackLink(input: BetaFeedback, repo = BETA_REPO): { url: string; withBody: boolean; title: string; body: string } {
  const title = `[beta] ${KIND_PREFIX[input.kind]} (${input.area}): ${input.title.replace(/\s+/g, " ").trim() || "(no title)"}`;
  let body = feedbackBody({ kind: input.kind, title: input.title, description: input.description, environment: input.environment ?? null });
  if (typeof input.weeksInBeta === "number") body += `\n## Beta\n\n- Week in the beta: ${input.weeksInBeta + 1}\n`;
  const q = (withBody: boolean) => {
    const p = new URLSearchParams({ title, labels: `${BETA_FEEDBACK_LABEL},${input.kind === "bug" ? "bug" : input.kind === "idea" ? "enhancement" : "question"}` });
    if (withBody) p.set("body", body);
    return `https://github.com/${repo}/issues/new?${p.toString()}`;
  };
  const full = q(true);
  if (full.length <= MAX_ISSUE_URL) return { url: full, withBody: true, title, body };
  return { url: q(false), withBody: false, title, body };
}
