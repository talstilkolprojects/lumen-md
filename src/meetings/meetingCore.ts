/**
 * Plan 6.16 — meeting notes on this device: the pure parts (no imports).
 *
 *   transcript → { decisions, tasks (owner, due date), open questions }
 *   tasks      → `- [ ]` lines in the obsidian-tasks format (📅 due), so
 *                the vault's task index and panel (4.13) pick them up
 *   due dates  → an .ics calendar file (one VTODO per dated task)
 */

export interface MeetingTask {
  text: string;
  owner?: string;
  /** YYYY-MM-DD */
  due?: string;
}

export interface MeetingNotes {
  decisions: string[];
  tasks: MeetingTask[];
  questions: string[];
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** The symbols the task format reads as fields (due date, priority…): never part of a task's text. */
const FIELD_EMOJI = /[📅⏳🛫➕✅❌🔁🏁⛔🆔🔺⏫🔼🔽⏬]\uFE0F?/gu;

/** A real calendar date (2026-02-30 is not). */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Clean what the model returned: trimmed, de-duplicated, no empty items, owners without "@", only real dates. */
export function normalizeNotes(raw: { decisions?: unknown; tasks?: unknown; questions?: unknown }): MeetingNotes {
  const strings = (v: unknown) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const x of Array.isArray(v) ? v : []) {
      const s = typeof x === "string" ? x.replace(/\s+/g, " ").trim() : "";
      if (s && !seen.has(s.toLowerCase())) {
        seen.add(s.toLowerCase());
        out.push(s);
      }
    }
    return out;
  };
  const tasks: MeetingTask[] = [];
  const seen = new Set<string>();
  for (const x of Array.isArray(raw.tasks) ? raw.tasks : []) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.replace(FIELD_EMOJI, "").replace(/\s+/g, " ").replace(/^[-*]\s*(\[.\]\s*)?/, "").trim() : "";
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    const owner = typeof o.owner === "string" ? o.owner.replace(/^@+/, "").trim() : "";
    tasks.push({ text, ...(owner ? { owner } : {}), ...(isIsoDate(o.due) ? { due: o.due } : {}) });
  }
  return { decisions: strings(raw.decisions), tasks, questions: strings(raw.questions) };
}

/** One task line in the obsidian-tasks format: `- [ ] text (@owner) 📅 YYYY-MM-DD`. */
export function taskLine(task: MeetingTask): string {
  // Characters the task format reads as fields stay in the text only as text.
  const text = task.text.replace(FIELD_EMOJI, "").trim();
  return `- [ ] ${text}${task.owner ? ` (@${task.owner.replace(/\s+/g, "_")})` : ""}${task.due ? ` 📅 ${task.due}` : ""}`;
}

export interface MeetingLabels {
  title: string;
  decisions: string;
  tasks: string;
  questions: string;
  none: string;
  transcript: string;
}

/** The meeting note's Markdown. */
export function formatMeetingNote(notes: MeetingNotes, opts: { date: string; transcript: string; labels: MeetingLabels; local: boolean }): string {
  const L = opts.labels;
  const list = (items: string[]) => (items.length ? items.map((s) => `- ${s}`).join("\n") : `_${L.none}_`);
  return [
    `## ${L.title} · ${opts.date}${opts.local ? " · 🛡 local" : ""}`,
    "",
    `### ${L.decisions}`,
    "",
    list(notes.decisions),
    "",
    `### ${L.tasks}`,
    "",
    notes.tasks.length ? notes.tasks.map(taskLine).join("\n") : `_${L.none}_`,
    "",
    `### ${L.questions}`,
    "",
    list(notes.questions),
    "",
    `<details><summary>${L.transcript}</summary>`,
    "",
    opts.transcript.trim(),
    "",
    "</details>",
    "",
  ].join("\n");
}

/* ─── ICS ─────────────────────────────────────────────────────────────── */

const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Fold a content line at 75 octets (RFC 5545 §3.1), never inside a UTF-8 sequence. */
function fold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = ch;
    } else cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/**
 * A calendar of the dated tasks: one VTODO each, due on its date. Null when
 * no task has a date. `stamp` is the creation time (UTC, for DTSTAMP).
 */
export function tasksToIcs(tasks: readonly MeetingTask[], opts: { title: string; stamp: Date; uidSeed: string }): string | null {
  const dated = tasks.filter((t) => t.due && isIsoDate(t.due));
  if (!dated.length) return null;
  const dtstamp = opts.stamp.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Lumen//Meeting notes//EN", "CALSCALE:GREGORIAN"];
  dated.forEach((t, i) => {
    lines.push(
      "BEGIN:VTODO",
      `UID:${opts.uidSeed}-${i + 1}@lumen-md.vercel.app`,
      `DTSTAMP:${dtstamp}`,
      `DUE;VALUE=DATE:${t.due!.replace(/-/g, "")}`,
      `SUMMARY:${icsText(t.text)}`,
      `DESCRIPTION:${icsText(`${opts.title}${t.owner ? ` — ${t.owner}` : ""}`)}`,
      "STATUS:NEEDS-ACTION",
      "END:VTODO",
    );
  });
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/* ─── measuring: tasks found ─────────────────────────────────────────── */

const STOP = new Set("the a an to of for and or on in at by with is are be will should we i you he she they it this that".split(" ").concat("את של על עם זה זו הוא היא הם אני אנחנו".split(" ")));

function words(s: string): Set<string> {
  return new Set(
    s
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\u0591-\u05C7]/g, "")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1 && !STOP.has(w))
      // A light stem: "sends" ~ "send", "rooms" ~ "room".
      .map((w) => (w.length > 3 && /[a-z]s$/.test(w) && !w.endsWith("ss") ? w.slice(0, -1) : w))
      // Hebrew one-letter prefixes (ו ה ב ל מ ש כ): "לדנה" ~ "דנה", "התקציב" ~ "תקציב".
      .map((w) => w.replace(/^[\u05D5\u05D4\u05D1\u05DC\u05DE\u05E9\u05DB](?=[\u05D0-\u05EA]{3,})/, "")),
  );
}

/** Do two task texts name the same task? (≥ half of the shorter one's words shared.) */
export function sameTask(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return false;
  let n = 0;
  for (const w of wa) if (wb.has(w)) n++;
  return n / Math.min(wa.size, wb.size) >= 0.5;
}

/** Share of the reference tasks found among the predicted ones (each prediction matches at most one). */
export function taskRecall(predicted: readonly string[], reference: readonly string[]): number {
  if (!reference.length) return 1;
  const used = new Set<number>();
  let hit = 0;
  for (const r of reference) {
    const i = predicted.findIndex((p, k) => !used.has(k) && sameTask(p, r));
    if (i >= 0) {
      used.add(i);
      hit++;
    }
  }
  return hit / reference.length;
}
