/**
 * Screen-reader announcements (plan W1.23): one polite and one assertive
 * live region, shared by the whole app, so NVDA, VoiceOver and TalkBack
 * read what changes in the editor without moving focus — the heading the
 * cursor entered, a suggestion that appeared, AI work that finished.
 *
 * Kept small and dependency-free: it is loaded with the editor.
 */

export type Verbosity = "off" | "structure" | "all";

const KEY = "lumen-sr-verbosity";
const MODES: readonly Verbosity[] = ["structure", "all", "off"];

export function getVerbosity(): Verbosity {
  try {
    const v = localStorage.getItem(KEY);
    return v === "off" || v === "all" || v === "structure" ? v : "structure";
  } catch {
    return "structure";
  }
}

export function setVerbosity(v: Verbosity): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // Private mode: the choice lasts for this session only.
  }
  memory = v;
}

let memory: Verbosity | null = null;
/** The current mode (the stored one, or what was set this session when storage is blocked). */
export function verbosity(): Verbosity {
  return memory ?? getVerbosity();
}

/** structure → all → off → structure. */
export function nextVerbosity(v: Verbosity): Verbosity {
  return MODES[(MODES.indexOf(v) + 1) % MODES.length];
}

const recent: string[] = [];
/** The last announcements, newest last (for tests and the "repeat" command). */
export function recentAnnouncements(): readonly string[] {
  return recent;
}

const regions: Partial<Record<"polite" | "assertive", HTMLElement>> = {};

function region(kind: "polite" | "assertive"): HTMLElement | null {
  if (typeof document === "undefined" || !document.body || typeof document.createElement !== "function") return null;
  const have = regions[kind];
  if (have && have.isConnected) return have;
  // The app shell's polite region (App.tsx) is reused, so there is one place that speaks.
  const shell = kind === "polite" ? document.getElementById("lumen-sr-announcer") : null;
  if (shell) {
    shell.dataset.testid = "sr-announcer-polite";
    regions[kind] = shell;
    return shell;
  }
  const el = document.createElement("div");
  el.className = "sr-only";
  el.setAttribute("aria-live", kind);
  el.setAttribute("aria-atomic", "true");
  el.setAttribute("role", kind === "assertive" ? "alert" : "status");
  el.dataset.testid = `sr-announcer-${kind}`;
  document.body.appendChild(el);
  regions[kind] = el;
  return el;
}

const timers: Partial<Record<"polite" | "assertive", ReturnType<typeof setTimeout>>> = {};

/**
 * Say `message` once. The region is emptied first and filled a moment later,
 * so the same text twice in a row is read twice (screen readers skip an
 * unchanged live region).
 */
export function announce(message: string, kind: "polite" | "assertive" = "polite"): void {
  const text = message.trim();
  if (!text) return;
  recent.push(text);
  if (recent.length > 20) recent.shift();
  const el = region(kind);
  if (!el) return;
  el.textContent = "";
  const pending = timers[kind];
  if (pending) clearTimeout(pending);
  timers[kind] = setTimeout(() => {
    el.textContent = text;
    delete timers[kind];
  }, 60);
}

export interface LineInfo {
  /** i18n key and its values. */
  key: "sr.heading" | "sr.line" | "sr.task.open" | "sr.task.done" | "sr.codeFence" | "sr.quote";
  vars: Record<string, string | number>;
}

/**
 * What to say when the cursor lands on a line, by mode: `structure` speaks
 * only structural lines (headings, tasks, code fences, quotes) — the screen
 * reader already reads the text; `all` adds the line number on every line.
 */
export function describeLine(text: string, line: number, mode: Verbosity): LineInfo | null {
  if (mode === "off") return null;
  const h = /^(#{1,6})\s+(.*)$/.exec(text);
  if (h) return { key: "sr.heading", vars: { level: h[1].length, line, text: h[2].trim() } };
  const task = /^\s*[-*+]\s+\[([ xX])\]\s/.exec(text);
  if (task) return { key: task[1] === " " ? "sr.task.open" : "sr.task.done", vars: { line } };
  if (/^\s*(```|~~~)/.test(text)) return { key: "sr.codeFence", vars: { line } };
  if (/^\s*>/.test(text)) return { key: "sr.quote", vars: { line } };
  return mode === "all" ? { key: "sr.line", vars: { line } } : null;
}

/** The nearest heading at or above `line` (1-based), for "where am I". */
export function headingAbove(lines: readonly string[], line: number): string | null {
  let inFence = false;
  let found: string | null = null;
  for (let i = 0; i < Math.min(line, lines.length); i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    else if (!inFence) {
      const h = /^#{1,6}\s+(.*)$/.exec(l);
      if (h) found = h[1].trim();
    }
  }
  return found;
}

/**
 * Speak long AI work: "working" when it has run for `afterMs`, "finished"
 * when work that long ends. Short work (ghost-text completions) stays quiet.
 */
export function aiBusyAnnouncer(say: (busy: boolean) => void, afterMs = 1500): (busy: boolean) => void {
  let started = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let spoke = false;
  return (busy) => {
    if (busy) {
      if (started) return;
      started = Date.now();
      spoke = false;
      pending = setTimeout(() => {
        spoke = true;
        say(true);
      }, afterMs);
      return;
    }
    if (pending) clearTimeout(pending);
    pending = null;
    if (started && (spoke || Date.now() - started >= afterMs)) say(false);
    started = 0;
  };
}
