/**
 * "Your morning" in today's daily note (plan W5.19): the app side. It reads
 * the vault index (in memory), the review file (.lumen/review.json) and the
 * Hebrew calendar — nothing leaves the device — and writes the block into
 * the note, replacing the previous one. Off by default (settings: daily
 * notes → "Your morning").
 */
import "./morningStrings";
import { t } from "../i18n";
import { dailyPath, hebrewDate, isIsrael, isoOf, type Day } from "./dailyNote";
import type { DailySettings } from "./defaults";
import { holidaysOn, weeklyReading } from "./hebrewCalendar";
import { holidayLabel, nameLang, readingName } from "./hebrewCalendarNames";
import { END, morningData, renderMorning, START, upsertMorning, type MorningData, type MorningWords } from "./morningCore";

export const LAST_MORNING_KEY = "lumen.morning.last";
const DAY_MS = 86_400_000;

function words(): MorningWords {
  return {
    title: t("morning.title"),
    changed: t("morning.changed"),
    noChanges: t("morning.noChanges"),
    tasks: t("morning.tasks"),
    noTasks: t("morning.noTasks"),
    overdue: (due) => t("morning.overdue", { date: due }),
    review: (n) => t("morning.review", { n }),
    noReview: t("morning.noReview"),
    openReview: t("morning.openReview"),
    more: (n) => t("morning.more", { n }),
    holidays: t("morning.holidays"),
  };
}

function lastMorning(now: number): number {
  try {
    const v = Number(localStorage.getItem(LAST_MORNING_KEY));
    return Number.isFinite(v) && v > 0 && v < now ? v : now - DAY_MS;
  } catch {
    return now - DAY_MS;
  }
}

/** The day's data, from the vault index and the review file. */
export async function collectMorning(day: Day, settings: DailySettings, locale: string, now = new Date()): Promise<MorningData> {
  const [{ ensureIndex, indexedNotes }, ws, { dailyQueue, parseReviewFile, REVIEW_PATH }] = await Promise.all([import("../storage/workspaceIndex"), import("../storage/workspace"), import("../srs/cards")]);
  await ensureIndex();
  const israel = isIsrael(settings, locale);
  const lang = nameLang(locale);
  const review = parseReviewFile(await ws.readWorkspaceFile(REVIEW_PATH).catch(() => null));
  const due = review ? dailyQueue(review, now, { max: 1000 }) : [];
  const folder = settings.folder.replace(/^\/+|\/+$/g, "");
  return morningData({
    date: isoOf(day),
    hebrewDate: hebrewDate(day),
    parasha: readingName(weeklyReading(day, { israel }), lang),
    holidays: holidaysOn(day, { israel }).map((h) => holidayLabel(h, lang)),
    // W2.22: the text comes from the index for this one pass.
    notes: await indexedNotes(),
    since: lastMorning(now.getTime()),
    skip: (p) => p.startsWith(".lumen/") || (folder ? p.startsWith(`${folder}/`) : p === dailyPath(day, settings)),
    cardsDue: due.length,
    cards: due.map((e) => ({ front: e.front, link: e.link })),
  });
}

/** The block's Markdown for `day`. */
export async function morningBlock(day: Day, settings: DailySettings, locale: string, now = new Date()): Promise<string> {
  return renderMorning(await collectMorning(day, settings, locale, now), words());
}

/**
 * Write the block into the day's note file (only when the note is not open
 * with edits in a tab: then `applyToText` is used on the editor's text).
 * Remembers this morning, so the next one lists what changed after it.
 */
export async function refreshMorningFile(day: Day, settings: DailySettings, locale: string, now = new Date()): Promise<string> {
  const ws = await import("../storage/workspace");
  const path = dailyPath(day, settings);
  const text = await ws.readWorkspaceFile(path);
  const next = upsertMorning(text, await morningBlock(day, settings, locale, now));
  if (next !== text) {
    await ws.writeWorkspaceFile(path, next);
    const { notifyWorkspaceChanged } = await import("../storage/workspaceEvents");
    notifyWorkspaceChanged({ kind: "content", paths: [path] });
  }
  rememberMorning(now);
  return next;
}

export async function applyToText(text: string, day: Day, settings: DailySettings, locale: string, now = new Date()): Promise<string> {
  const next = upsertMorning(text, await morningBlock(day, settings, locale, now));
  rememberMorning(now);
  return next;
}

function rememberMorning(now: Date): void {
  try {
    localStorage.setItem(LAST_MORNING_KEY, String(now.getTime()));
  } catch {
    // why: storage is blocked or full (private mode, quota): the setting holds for this session only
    /* storage denied: the next morning lists the last 24 hours */
  }
}

export { START, END };
