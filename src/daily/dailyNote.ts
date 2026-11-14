/**
 * Daily notes (plan 4.12): `journal/YYYY-MM-DD.md` for a day, created from a
 * template on first open and opened (never duplicated) after that.
 *
 * Loaded on demand (the command, the shortcut and the calendar import it),
 * so none of this is in the startup bundle.
 *
 * Hebrew dates come from the browser's own ICU Hebrew calendar
 * (`Intl.DateTimeFormat("he-u-ca-hebrew")`) — no calendar library. Holidays
 * and Torah portions are out of scope.
 */

import { t } from "../i18n";
import { useAppStore } from "../store/useStore";

import { DEFAULT_DAILY, isValidDailyPattern, type DailySettings } from "./defaults";

export { DEFAULT_DAILY, isValidDailyPattern, type DailySettings };

const pad2 = (n: number) => String(n).padStart(2, "0");

/** A calendar day, independent of time zones. */
export interface Day {
  y: number;
  m: number; // 1–12
  d: number;
}

export const dayOf = (date: Date): Day => ({ y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() });
export const isoOf = (day: Day) => `${day.y}-${pad2(day.m)}-${pad2(day.d)}`;
export function parseIso(s: string): Day | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}
/** Noon UTC of the day: formatting it in UTC can never slip to a neighbouring day. */
const noonUtc = (day: Day) => new Date(Date.UTC(day.y, day.m - 1, day.d, 12));

/** Folder: no leading / trailing slashes, no "." or ".." segments. */
export function cleanFolder(folder: string): string {
  return folder
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
}

/** The file name a pattern gives a day (`YYYY-MM-DD` → `2026-10-18.md`). */
export function fileNameFor(day: Day, pattern: string): string {
  const base = (isValidDailyPattern(pattern) ? pattern.trim() : DEFAULT_DAILY.pattern).replace(/YYYY/g, String(day.y)).replace(/MM/g, pad2(day.m)).replace(/DD/g, pad2(day.d)).replace(/[\\/:*?"<>|]/g, "-");
  return /\.(md|markdown)$/i.test(base) ? base : `${base}.md`;
}

export function dailyPath(day: Day, s: Pick<DailySettings, "folder" | "pattern">): string {
  const folder = cleanFolder(s.folder);
  const name = fileNameFor(day, s.pattern);
  return folder ? `${folder}/${name}` : name;
}

/**
 * The day a vault path is the daily note of, under these settings, or null.
 * The pattern is matched as written, its tokens as digits.
 */
export function dayOfPath(path: string, s: Pick<DailySettings, "folder" | "pattern">): Day | null {
  const folder = cleanFolder(s.folder);
  const prefix = folder ? `${folder}/` : "";
  if (!path.startsWith(prefix)) return null;
  const name = path.slice(prefix.length);
  if (name.includes("/")) return null;
  // Rebuild a regex from the pattern: tokens → digit groups, the rest literal.
  const tokens: Array<"y" | "m" | "d"> = [];
  const source = (isValidDailyPattern(s.pattern) ? s.pattern.trim() : DEFAULT_DAILY.pattern).replace(/[\\/:*?"<>|]/g, "-");
  let re = "^";
  for (let i = 0; i < source.length; ) {
    const rest = source.slice(i);
    if (rest.startsWith("YYYY")) {
      re += "(\\d{4})";
      tokens.push("y");
      i += 4;
    } else if (rest.startsWith("MM")) {
      re += "(\\d{2})";
      tokens.push("m");
      i += 2;
    } else if (rest.startsWith("DD")) {
      re += "(\\d{2})";
      tokens.push("d");
      i += 2;
    } else {
      re += source[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  // fileNameFor adds ".md" when the pattern has no extension.
  re += /\.(md|markdown)$/i.test(source) ? "$" : "\\.md$";
  const m = new RegExp(re, "i").exec(name);
  if (!m) return null;
  const v: Record<string, number> = {};
  tokens.forEach((k, i) => (v[k] = Number(m[i + 1])));
  if (!v.y || !v.m || !v.d) return null;
  const day = { y: v.y, m: v.m, d: v.d };
  // Reject impossible dates (2026-02-30).
  const check = noonUtc(day);
  return check.getUTCFullYear() === day.y && check.getUTCMonth() + 1 === day.m && check.getUTCDate() === day.d ? day : null;
}

// ── Hebrew date (Intl only) ─────────────────────────────────────────────

const HE_PARTS = new Intl.DateTimeFormat("he-u-ca-hebrew", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** The Hebrew calendar date of a day: { day, month (Hebrew name), year }. */
export function hebrewParts(day: Day): { day: number; month: string; year: number } {
  const p = Object.fromEntries(HE_PARTS.formatToParts(noonUtc(day)).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  return { day: Number(p.day), month: p.month, year: Number(p.year) };
}

const LETTERS: Array<[number, string]> = [
  [400, "ת"], [300, "ש"], [200, "ר"], [100, "ק"], [90, "צ"], [80, "פ"], [70, "ע"], [60, "ס"], [50, "נ"],
  [40, "מ"], [30, "ל"], [20, "כ"], [10, "י"], [9, "ט"], [8, "ח"], [7, "ז"], [6, "ו"], [5, "ה"], [4, "ד"], [3, "ג"], [2, "ב"], [1, "א"],
];

/**
 * A number in Hebrew numerals (1–999): 7 → ז׳, 16 → ט״ז, 787 → תשפ״ז. Only
 * the digits are ours; the calendar itself is Intl's.
 */
export function gematria(n: number): string {
  let s = "";
  let rest = n;
  while (rest > 0) {
    if (rest === 15 || rest === 16) {
      s += rest === 15 ? "טו" : "טז"; // never יה / יו
      break;
    }
    const [v, l] = LETTERS.find(([v]) => v <= rest)!;
    s += l;
    rest -= v;
  }
  return s.length === 1 ? `${s}׳` : `${s.slice(0, -1)}״${s.slice(-1)}`;
}

/** The Hebrew date as it is written in Hebrew: `ז׳ בחשוון תשפ״ז` (year without the thousands). */
export function hebrewDate(day: Day): string {
  const p = hebrewParts(day);
  return `${gematria(p.day)} ב${p.month} ${gematria(p.year % 1000)}`;
}

/**
 * The Hebrew date wrapped in a right-to-left isolate (U+2067 … U+2069), for
 * text that may sit in a left-to-right line ("Sunday · ז׳ בחשוון תשפ״ז"):
 * without it the bidi algorithm pulls the year next to the month and the
 * Hebrew date can be reordered against the Latin text around it.
 */
export const isolatedHebrewDate = (day: Day) => `\u2067${hebrewDate(day)}\u2069`;

// ── Template ────────────────────────────────────────────────────────────

/** Fill a daily-note template. `locale` names the weekday and the title's date. */
export function renderTemplate(template: string, day: Day, locale: string): string {
  const date = noonUtc(day);
  const vars: Record<string, string> = {
    date: isoOf(day),
    hebrewDate: isolatedHebrewDate(day),
    weekday: new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(date),
    title: new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" }).format(date),
  };
  return template.replace(/\{\{\s*(date|hebrewDate|weekday|title)\s*\}\}/g, (_, k: string) => vars[k]);
}

// ── Open or create ──────────────────────────────────────────────────────

const inflight = new Map<string, Promise<string>>();

/**
 * Make sure the day's note exists (created from the template the first
 * time; an existing note is never overwritten) and return its path. Two
 * calls for the same day at once share one creation.
 */
export function ensureDailyNote(day: Day, settings: DailySettings, locale: string): Promise<string> {
  const path = dailyPath(day, settings);
  const running = inflight.get(path);
  if (running) return running;
  const job = (async () => {
    const ws = await import("../storage/workspace");
    if (!(await ws.workspaceHasEntry(path))) {
      await ws.writeWorkspaceFile(path, renderTemplate(settings.template, day, locale));
      const { notifyWorkspaceChanged } = await import("../storage/workspaceEvents");
      notifyWorkspaceChanged({ kind: "structure", paths: [path] });
    }
    return path;
  })().finally(() => inflight.delete(path));
  inflight.set(path, job);
  return job;
}

/**
 * Open the day's note, creating it if needed. A tab that already shows it is
 * focused with its unsaved edits (never reloaded from disk), so opening the
 * same day twice gives one tab and one file.
 */
export async function openDailyNote(day: Day, settings: DailySettings, locale: string): Promise<string | null> {
  const ws = await import("../storage/workspace");
  if (!ws.isOPFSAvailable()) {
    const { toast } = await import("../store/useToastStore");
    toast.error(t("daily.noWorkspace"));
    return null;
  }
  const path = await ensureDailyNote(day, settings, locale);
  const store = useAppStore.getState();
  if (store.doc.workspaceName === path) return path;
  const tab = store.openTabs.find((x) => x.workspaceName === path);
  const content = tab ? tab.content : await ws.readWorkspaceFile(path);
  store.openTab({ name: path.split("/").pop() ?? path, content, workspaceName: path });
  return path;
}
