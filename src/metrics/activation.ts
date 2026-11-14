/**
 * Activation and time to first value (plan W11.P4, research R6 §1.2),
 * counted on this device only, next to the W4.26 counters.
 *
 * Five local events:
 *   - `firstRun.start`: the first-run setup opened on a device that had never
 *     finished it;
 *   - `editor.ready`: the editor is up with an editable cursor. TTFV-1 is the
 *     time from the page's start (performance.now()) to this moment, kept for
 *     the last 20 launches;
 *   - `note.firstOwnSave`: the first note the user wrote was saved (an
 *     autosave of their own edit, not the sample or the template). TTFV-2 is
 *     the time from `firstRun.start` to it, when both happened in the same
 *     session (only a duration is kept; across sessions it stays unknown);
 *   - `import.complete`: an import finished with at least one note;
 *   - `day2.return`: the app opened on a later day than the first run.
 *
 * Activation (R6 §1.2): a note of the user's own or a completed import,
 * plus a return on a second day within 7 days of the first run.
 *
 * What is kept, in localStorage (`lumen.activation.v1`): days (YYYY-MM-DD),
 * yes/no facts and durations in milliseconds. No time of day, no note name,
 * no content, no id. Turning counting off (W4.26) clears it too. This module
 * makes no request; only the averages below go into the weekly beta report
 * (W6.31), which leaves only when the tester sends it.
 */

import { ACTIVATION_KEY, COUNTING_KEY, dayKey, shiftDay } from "./usage";

export { ACTIVATION_KEY };
export const TTFV1_KEEP = 20;
/** The days after the first run in which a return makes the user activated. */
export const ACTIVATION_WINDOW_DAYS = 7;

export type ActivationEvent = "firstRun.start" | "editor.ready" | "note.firstOwnSave" | "import.complete" | "day2.return";
export const ACTIVATION_EVENTS: readonly ActivationEvent[] = ["firstRun.start", "editor.ready", "note.firstOwnSave", "import.complete", "day2.return"];

export interface ActivationStore {
  v: 1;
  /** The day the first-run setup first opened. */
  firstRunDay: string | null;
  /** The day the first note of the user's own was saved. */
  firstOwnSaveDay: string | null;
  /** The first day an import completed, and how many have. */
  firstImportDay: string | null;
  imports: number;
  /** The first later day the app opened on. */
  day2ReturnDay: string | null;
  /** TTFV-1 of the last launches, ms, newest last. */
  ttfv1Ms: number[];
  /** TTFV-2, ms, when the first own save came in the first-run session. */
  ttfv2Ms: number | null;
  /** The first own save came in a later session than the first run: TTFV-2 unknown. */
  ttfv2AcrossSessions: boolean;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const empty = (): ActivationStore => ({ v: 1, firstRunDay: null, firstOwnSaveDay: null, firstImportDay: null, imports: 0, day2ReturnDay: null, ttfv1Ms: [], ttfv2Ms: null, ttfv2AcrossSessions: false });
const day = (v: unknown) => (typeof v === "string" && DAY.test(v) ? v : null);
const ms = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 86_400_000 ? Math.round(v) : null);

/** Read the store; anything missing or foreign is an empty store. */
export function loadActivation(storage: Pick<Storage, "getItem"> | null = safeStorage()): ActivationStore {
  try {
    const raw = storage?.getItem(ACTIVATION_KEY);
    if (!raw) return empty();
    const v = JSON.parse(raw) as Partial<ActivationStore>;
    if (v?.v !== 1) return empty();
    return {
      v: 1,
      firstRunDay: day(v.firstRunDay),
      firstOwnSaveDay: day(v.firstOwnSaveDay),
      firstImportDay: day(v.firstImportDay),
      imports: typeof v.imports === "number" && Number.isFinite(v.imports) && v.imports > 0 ? Math.floor(v.imports) : 0,
      day2ReturnDay: day(v.day2ReturnDay),
      ttfv1Ms: (Array.isArray(v.ttfv1Ms) ? v.ttfv1Ms : []).map(ms).filter((x): x is number => x !== null).slice(-TTFV1_KEEP),
      ttfv2Ms: ms(v.ttfv2Ms),
      ttfv2AcrossSessions: v.ttfv2AcrossSessions === true,
    };
  } catch {
    return empty();
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** What this session knows that the store does not: when (performance.now()) the first run started here. */
export interface Session {
  firstRunAt: number | null;
  editorReady: boolean;
}
export const newSession = (): Session => ({ firstRunAt: null, editorReady: false });

/**
 * The store after `event` on `today`, at `now` (performance.now() of this
 * session). Pure: the same inputs give the same store; `session` is updated.
 */
export function record(store: ActivationStore, event: ActivationEvent, today: string, now: number, session: Session, opts: { notes?: number } = {}): ActivationStore {
  const s: ActivationStore = { ...store, ttfv1Ms: [...store.ttfv1Ms] };
  switch (event) {
    case "firstRun.start":
      if (!s.firstRunDay) {
        s.firstRunDay = today;
        session.firstRunAt = now;
      }
      break;
    case "editor.ready":
      if (!session.editorReady) {
        session.editorReady = true;
        const v = ms(now);
        if (v !== null) s.ttfv1Ms = [...s.ttfv1Ms, v].slice(-TTFV1_KEEP);
      }
      break;
    case "note.firstOwnSave":
      if (!s.firstOwnSaveDay) {
        s.firstOwnSaveDay = today;
        if (session.firstRunAt !== null) s.ttfv2Ms = ms(now - session.firstRunAt);
        else s.ttfv2AcrossSessions = s.firstRunDay !== null;
      }
      break;
    case "import.complete":
      if ((opts.notes ?? 0) < 1) break;
      s.imports++;
      s.firstImportDay ??= today;
      break;
    case "day2.return":
      if (!s.day2ReturnDay && s.firstRunDay && today > s.firstRunDay) s.day2ReturnDay = today;
      break;
  }
  return s;
}

export interface ActivationSummary {
  /** Activated: own note or import, and a return on a second day within 7 days. Null while the 7 days are still running and it has not happened yet; null too without a first run. */
  activated: boolean | null;
  ownNote: boolean;
  imported: boolean;
  returnedDay2: boolean;
  /** The mean TTFV-1 of the kept launches, rounded to 100 ms. */
  ttfv1MeanMs: number | null;
  ttfv1Launches: number;
  /** TTFV-2 rounded to the second, or null when unknown. */
  ttfv2Ms: number | null;
}

const round = (v: number, to: number) => Math.round(v / to) * to;

/** The on-device figures, and the only ones the beta report carries. */
export function summarizeActivation(s: ActivationStore, today: string): ActivationSummary {
  const ownNote = s.firstOwnSaveDay !== null;
  const imported = s.firstImportDay !== null;
  let activated: boolean | null = null;
  if (s.firstRunDay) {
    const end = shiftDay(s.firstRunDay, ACTIVATION_WINDOW_DAYS);
    const valueBy = [s.firstOwnSaveDay, s.firstImportDay].filter((d): d is string => d !== null && d <= end).sort()[0] ?? null;
    const returned = s.day2ReturnDay !== null && s.day2ReturnDay <= end;
    if (valueBy && returned) activated = true;
    else if (today > end) activated = false;
  }
  const n = s.ttfv1Ms.length;
  return {
    activated,
    ownNote,
    imported,
    returnedDay2: s.day2ReturnDay !== null,
    ttfv1MeanMs: n ? round(s.ttfv1Ms.reduce((a, b) => a + b, 0) / n, 100) : null,
    ttfv1Launches: n,
    ttfv2Ms: s.ttfv2Ms === null ? null : round(s.ttfv2Ms, 1000),
  };
}

let session = newSession();
/** Tests: forget this session's marks. */
export const __resetSession = () => {
  session = newSession();
};

/** Record one event in localStorage; nothing when counting is off (W4.26). */
export function markActivation(event: ActivationEvent, opts: { notes?: number; storage?: Storage | null; at?: Date; now?: number } = {}): void {
  const storage = opts.storage === undefined ? safeStorage() : opts.storage;
  if (!storage) return;
  try {
    if (storage.getItem(COUNTING_KEY) === "0") return;
    const now = opts.now ?? (typeof performance !== "undefined" ? performance.now() : 0);
    const next = record(loadActivation(storage), event, dayKey(opts.at ?? new Date()), now, session, opts);
    storage.setItem(ACTIVATION_KEY, JSON.stringify(next));
  } catch {
    // why: storage full or refused — a lost mark is not worth an error
  }
}
