/**
 * The usability-session recorder (plan W1.29): what a participant did, per
 * task, for the moderator's analysis. Built so it can't carry what people
 * wrote:
 *
 *  - **Consent first.** `start()` refuses without the participant's
 *    consent, and nothing is recorded before it.
 *  - **Local only.** Events live in this browser's storage (so a reload
 *    mid-session loses nothing) and leave only as a file the moderator saves.
 *    The recorder makes no request.
 *  - **No content.** Clicks are recorded by the control's role and its
 *    label *only when the label is one of the app's own UI strings*; any
 *    other label (a note's name on a tab, a heading in the outline) becomes
 *    "[label]". Keys are counted, and only shortcuts with a modifier are
 *    named; typed characters never are. Commands are recorded by id, except
 *    ids that carry a name (recent files, templates, plugins).
 *  - **Deleted after analysis.** "Delete session data" removes it, and a
 *    session older than 30 days is removed on the next load.
 */

import { COMMAND_RAN } from "./commandEvents";

export const STORE_KEY = "lumen-usability-session";
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const SCHEMA = "lumen-usability/1";

export type Outcome = "success" | "partial" | "fail" | "gave-up";

export type RecorderEvent =
  | { t: number; type: "task-start"; task: number }
  | {
      t: number;
      type: "task-end";
      task: number;
      outcome: Outcome;
      assisted: boolean;
      /** Self-guided sessions (W4.25): did the notes show the result? null: nothing to check. Only this boolean is kept, never the text. */
      verified?: boolean | null;
    }
  | { t: number; type: "click"; role: string; label: string; testid?: string }
  | { t: number; type: "command"; id: string }
  | { t: number; type: "shortcut"; combo: string }
  | { t: number; type: "keys"; count: number }
  | { t: number; type: "error" }
  | { t: number; type: "note"; code: string };

export type SessionMode = "moderated" | "unmoderated";

export interface Session {
  schema: typeof SCHEMA;
  /** P1…P20 (moderated) or U-XXXX (self-guided, random): a code, never a name. */
  participant: string;
  /** Absent in moderated sessions recorded before plan W4.25. */
  mode?: SessionMode;
  /** 1 or 2 (the re-test after fixes). */
  round: number;
  consentAt: string;
  startedAt: number;
  endedAt?: number;
  app: { version: string; locale: string; dir: string; viewport: string; touch: boolean };
  events: RecorderEvent[];
  /** Single Ease Question per task, 1 (very hard) … 7 (very easy). */
  seq: Record<number, number>;
  /** SUS answers, 10 items, 1 (strongly disagree) … 5 (strongly agree). */
  sus: number[];
}

/** Moderator observation codes (findings template, protocol §5). Short codes only, never free text. */
export const NOTE_CODES = ["hesitated", "wrong-path", "asked-help", "said-confused", "said-liked", "rtl-issue", "bug"] as const;

const PARTICIPANT = /^P([1-9]|1[0-9]|20)$/;
const SELF_PARTICIPANT = /^U-[A-HJ-NP-Z2-9]{4}$/;

/** A moderated code (P1…P20), or with `mode` "unmoderated" a self-guided one (U-XXXX). */
export function validParticipant(code: string, mode: SessionMode = "moderated"): boolean {
  return (mode === "unmoderated" ? SELF_PARTICIPANT : PARTICIPANT).test(code.trim().toUpperCase());
}

/** A command id worth recording: a fixed id from the code, or its family for ids that carry a name. */
export function safeCommandId(id: string): string {
  if (/^(recent|template|plugin|tpl|file\.open\.|workspace\.open)\b/.test(id)) return `${id.split(".")[0]}.*`;
  return /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+){0,4}$/.test(id) && id.length <= 64 ? id : "[command]";
}

/** A control's label, kept only when it is one of the app's UI strings. */
export function safeLabel(label: string | null | undefined, uiStrings: ReadonlySet<string>): string {
  const l = (label ?? "").trim();
  if (!l) return "";
  return uiStrings.has(l) ? l : "[label]";
}

/** A data-testid is code, but some embed names: keep only plain ids. */
export function safeTestId(id: string | null | undefined): string | undefined {
  return id && /^[a-z][a-z0-9-]{0,40}$/.test(id) ? id : undefined;
}

/** A shortcut, named only when a modifier is held (Mod+K), never a typed character. */
export function shortcutOf(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string | null {
  if (!(e.ctrlKey || e.metaKey || e.altKey)) {
    return ["Escape", "F1", "Tab", "Enter"].includes(e.key) ? e.key : null;
  }
  const key = e.key.length === 1 ? (/^[a-z0-9]$/i.test(e.key) ? e.key.toUpperCase() : "[key]") : e.key;
  if (["Control", "Meta", "Alt", "Shift"].includes(key)) return null;
  return [e.ctrlKey || e.metaKey ? "Mod" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : "", key].filter(Boolean).join("+");
}

/** The role a click target plays, from the element or its nearest control. */
export function roleOf(el: { tagName: string; getAttribute(n: string): string | null }): string {
  const role = el.getAttribute("role");
  if (role) return role;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "input") return `input:${el.getAttribute("type") ?? "text"}`;
  return tag;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function safeStorage(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadSession(storage: Store | null = safeStorage(), now = Date.now()): Session | null {
  try {
    const raw = storage?.getItem(STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (s?.schema !== SCHEMA) return null;
    if (now - s.startedAt > MAX_AGE_MS) {
      storage?.removeItem(STORE_KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

function save(s: Session, storage: Store | null): void {
  try {
    storage?.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* storage full or blocked: the session continues in memory */
  }
}

export function deleteSession(storage: Store | null = safeStorage()): void {
  try {
    storage?.removeItem(STORE_KEY);
  } catch {
    /* nothing stored */
  }
}

export interface StartOptions {
  participant: string;
  round: number;
  consent: boolean;
  app: Session["app"];
  /** Default "moderated". */
  mode?: SessionMode;
  now?: number;
  storage?: Store | null;
}

/** A new session. Throws without consent or with a code that isn't P1…P20 (U-XXXX when self-guided). */
export function startSession(o: StartOptions): Session {
  const mode = o.mode ?? "moderated";
  if (o.consent !== true) throw new Error("consent required");
  if (!validParticipant(o.participant, mode)) throw new Error(mode === "unmoderated" ? "participant code must be U-XXXX" : "participant code must be P1…P20");
  if (o.round !== 1 && o.round !== 2) throw new Error("round must be 1 or 2");
  const now = o.now ?? Date.now();
  const s: Session = { schema: SCHEMA, participant: o.participant.trim().toUpperCase(), ...(mode === "unmoderated" ? { mode } : {}), round: o.round, consentAt: new Date(now).toISOString(), startedAt: now, app: o.app, events: [], seq: {}, sus: [] };
  save(s, o.storage === undefined ? safeStorage() : o.storage);
  return s;
}

/** Append an event (keystroke counts are merged into the previous "keys" event to keep files small). */
export function record(s: Session, e: RecorderEvent, storage: Store | null = safeStorage()): void {
  if (s.endedAt) return;
  const last = s.events[s.events.length - 1];
  if (e.type === "keys" && last?.type === "keys" && e.t - last.t < 5000) last.count += e.count;
  else s.events.push(e);
  save(s, storage);
}

export function setSeq(s: Session, task: number, value: number, storage: Store | null = safeStorage()): void {
  if (!Number.isInteger(value) || value < 1 || value > 7) throw new Error("SEQ is 1…7");
  s.seq[task] = value;
  save(s, storage);
}

export function setSus(s: Session, answers: number[], storage: Store | null = safeStorage()): void {
  if (answers.length !== 10 || answers.some((a) => !Number.isInteger(a) || a < 1 || a > 5)) throw new Error("SUS is 10 answers, 1…5");
  s.sus = [...answers];
  save(s, storage);
}

export function endSession(s: Session, now = Date.now(), storage: Store | null = safeStorage()): void {
  s.endedAt ??= now;
  save(s, storage);
}

/** The export file: the session as JSON, and a name with the code, round and date (no names). */
export function exportFile(s: Session): { name: string; text: string } {
  const day = new Date(s.startedAt).toISOString().slice(0, 10);
  return { name: `usability-${s.participant}-r${s.round}-${day}.json`, text: JSON.stringify(s, null, 2) + "\n" };
}

/**
 * Live listeners for a running session: clicks, commands, keys, errors.
 * Returns the function that stops them.
 */
export function listen(s: Session, uiStrings: ReadonlySet<string>, storage: Store | null = safeStorage()): () => void {
  const now = () => Date.now();
  const onClick = (ev: MouseEvent) => {
    const target = ev.target as Element | null;
    // The recorder's own panel is not part of the study.
    if (!target || target.closest?.("[data-usability-panel]")) return;
    const control = target.closest?.("button, a, [role], input, select, summary, label") ?? target;
    record(
      s,
      {
        t: now(),
        type: "click",
        role: roleOf(control),
        label: safeLabel(control.getAttribute("aria-label") ?? control.getAttribute("title") ?? (control.tagName === "BUTTON" ? control.textContent : null), uiStrings),
        testid: safeTestId(control.getAttribute("data-testid")),
      },
      storage,
    );
  };
  const onKey = (ev: KeyboardEvent) => {
    if ((ev.target as Element | null)?.closest?.("[data-usability-panel]")) return;
    const combo = shortcutOf(ev);
    if (combo) record(s, { t: now(), type: "shortcut", combo }, storage);
    else record(s, { t: now(), type: "keys", count: 1 }, storage);
  };
  const onCommand = (ev: Event) => {
    const id = (ev as CustomEvent<{ id?: string }>).detail?.id;
    if (typeof id === "string") record(s, { t: now(), type: "command", id: safeCommandId(id) }, storage);
  };
  const onError = () => record(s, { t: now(), type: "error" }, storage);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener(COMMAND_RAN, onCommand);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onError);
  return () => {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener(COMMAND_RAN, onCommand);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onError);
  };
}
