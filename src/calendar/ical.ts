/**
 * iCalendar (RFC 5545), the part CalDAV task sync and ICS subscriptions need
 * (plan W7.20): unfolding and folding, text escaping, VTODO in and out, VEVENT
 * in, with the recurrence rules calendars actually publish (DAILY, WEEKLY with
 * BYDAY, MONTHLY, YEARLY; INTERVAL, COUNT, UNTIL, EXDATE). Pure: no DOM, no
 * network.
 */

export interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface Component {
  name: string;
  props: Prop[];
  children: Component[];
}

/** Undo line folding: a line that starts with a space or tab continues the one before. */
export function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && out.length) out[out.length - 1] += raw.slice(1);
    else if (raw !== "") out.push(raw);
  }
  return out;
}

/** Fold to 75 octets per line (RFC 5545 3.1), never inside a UTF-8 character. */
export function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = parts.length ? 74 : 75;
    if (bytes + n > limit) {
      parts.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

export const escapeText = (s: string): string => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
export const unescapeText = (s: string): string => s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));

function parseLine(line: string): Prop | null {
  // NAME;PARAM=a;PARAM="b:c":value — the first colon outside quotes ends the parameters.
  let i = 0;
  let quoted = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ":" && !quoted) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const [name, ...ps] = head.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params: Record<string, string> = {};
  for (const p of ps) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value };
}

/** Parse an iCalendar text into its component tree (the VCALENDAR is the root). */
export function parseIcs(text: string): Component[] {
  const roots: Component[] = [];
  const stack: Component[] = [];
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      const c: Component = { name: p.value.toUpperCase(), props: [], children: [] };
      (stack.length ? stack[stack.length - 1].children : roots).push(c);
      stack.push(c);
    } else if (p.name === "END") {
      stack.pop();
    } else if (stack.length) {
      stack[stack.length - 1].props.push(p);
    }
  }
  return roots;
}

export const prop = (c: Component, name: string): Prop | undefined => c.props.find((p) => p.name === name);
export const props = (c: Component, name: string): Prop[] => c.props.filter((p) => p.name === name);

export function components(roots: readonly Component[], name: string): Component[] {
  const out: Component[] = [];
  const walk = (cs: readonly Component[]) => {
    for (const c of cs) {
      if (c.name === name) out.push(c);
      walk(c.children);
    }
  };
  walk(roots);
  return out;
}

// ------------------------------------------------------------ dates

export interface IcalTime {
  /** YYYY-MM-DD in the event's own calendar day (floating or the given zone's wall clock). */
  date: string;
  /** HH:MM, or null for an all-day value. */
  time: string | null;
  /** true when the value was UTC (`Z`): `date`/`time` are then UTC and need converting for display. */
  utc: boolean;
  tzid: string | null;
}

export function parseIcalTime(p: Prop): IcalTime | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(p.value.trim());
  if (!m) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4] ? `${m[4]}:${m[5]}` : null, utc: !!m[7], tzid: p.params.TZID ?? null };
}

/** A UTC time as the wall clock of `timeZone` (Intl; the device's zone by default). */
export function utcToZone(t: IcalTime, timeZone?: string): IcalTime {
  if (!t.utc || !t.time) return t;
  const d = new Date(`${t.date}T${t.time}:00Z`);
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, utc: false, tzid: timeZone ?? null };
}

const compact = (iso: string) => iso.replace(/-/g, "");

// ------------------------------------------------------------ VTODO

export interface Todo {
  uid: string;
  summary: string;
  /** YYYY-MM-DD (date-only, as tasks in notes have no time). */
  due: string | null;
  start: string | null;
  completed: boolean;
  /** YYYY-MM-DD the task was completed. */
  completedOn: string | null;
}

export function todoFromComponent(c: Component): Todo | null {
  const uid = prop(c, "UID")?.value;
  if (!uid) return null;
  const date = (name: string) => {
    const p = prop(c, name);
    const t = p ? parseIcalTime(p) : null;
    return t ? (t.utc ? utcToZone(t).date : t.date) : null;
  };
  const status = prop(c, "STATUS")?.value.toUpperCase();
  const completedOn = date("COMPLETED");
  return {
    uid,
    summary: unescapeText(prop(c, "SUMMARY")?.value ?? ""),
    due: date("DUE"),
    start: date("DTSTART"),
    completed: status === "COMPLETED" || (!!completedOn && status !== "NEEDS-ACTION"),
    completedOn,
  };
}

export function parseTodos(ics: string): Todo[] {
  return components(parseIcs(ics), "VTODO").map(todoFromComponent).filter((t): t is Todo => t !== null);
}

/** One VTODO in its own VCALENDAR, as a CalDAV resource must be. `stamp`: the UTC time of the write. */
export function todoToIcs(t: Todo, stamp: Date): string {
  const z = stamp.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//lumen-md//tasks//EN", "BEGIN:VTODO", `UID:${t.uid}`, `DTSTAMP:${z}`, `LAST-MODIFIED:${z}`, `SUMMARY:${escapeText(t.summary)}`];
  if (t.start) lines.push(`DTSTART;VALUE=DATE:${compact(t.start)}`);
  if (t.due) lines.push(`DUE;VALUE=DATE:${compact(t.due)}`);
  lines.push(`STATUS:${t.completed ? "COMPLETED" : "NEEDS-ACTION"}`);
  if (t.completed) lines.push(`COMPLETED:${t.completedOn ? `${compact(t.completedOn)}T120000Z` : z}`, "PERCENT-COMPLETE:100");
  lines.push("END:VTODO", "END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// ------------------------------------------------------------ VEVENT and recurrence

export interface CalEvent {
  uid: string;
  summary: string;
  location: string;
  start: IcalTime;
  end: IcalTime | null;
  allDay: boolean;
  rrule: Record<string, string> | null;
  exdates: string[];
  /** RECURRENCE-ID of an overridden instance (its date), when this is one. */
  recurrenceId: string | null;
}

export function parseEvents(ics: string, timeZone?: string): CalEvent[] {
  const out: CalEvent[] = [];
  for (const c of components(parseIcs(ics), "VEVENT")) {
    const sp = prop(c, "DTSTART");
    const raw = sp ? parseIcalTime(sp) : null;
    if (!raw) continue;
    const start = utcToZone(raw, timeZone);
    const ep = prop(c, "DTEND");
    const end = ep ? parseIcalTime(ep) : null;
    const rr = prop(c, "RRULE")?.value;
    const rid = prop(c, "RECURRENCE-ID");
    out.push({
      uid: prop(c, "UID")?.value ?? "",
      summary: unescapeText(prop(c, "SUMMARY")?.value ?? ""),
      location: unescapeText(prop(c, "LOCATION")?.value ?? ""),
      start,
      end: end ? utcToZone(end, timeZone) : null,
      allDay: start.time === null,
      rrule: rr ? Object.fromEntries(rr.split(";").map((kv) => kv.split("=") as [string, string]).map(([k, v]) => [k.toUpperCase(), v ?? ""])) : null,
      exdates: props(c, "EXDATE").flatMap((p) => p.value.split(",").map((v) => parseIcalTime({ ...p, value: v })).filter((t): t is IcalTime => !!t).map((t) => utcToZone(t, timeZone).date)),
      recurrenceId: rid ? (parseIcalTime(rid) ? utcToZone(parseIcalTime(rid) as IcalTime, timeZone).date : null) : null,
    });
  }
  return out;
}

const DAY_MS = 86_400_000;
const toUtcDay = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const isoOfUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** Days between the event's first day and its last (a multi-day event covers each). */
function spanDays(e: CalEvent): number {
  if (!e.end) return 0;
  const d = Math.round((toUtcDay(e.end.date) - toUtcDay(e.start.date)) / DAY_MS);
  // An all-day DTEND is exclusive; a timed one ending at midnight is too.
  return Math.max(0, e.allDay || e.end.time === "00:00" ? d - 1 : d);
}

/** Does a recurring (or single) event have an occurrence that starts on `day`? Capped at 5,000 steps. */
export function startsOn(e: CalEvent, day: string): boolean {
  if (!e.rrule) return e.start.date === day;
  if (e.exdates.includes(day)) return false;
  const target = toUtcDay(day);
  const first = toUtcDay(e.start.date);
  if (target < first) return false;
  const r = e.rrule;
  const interval = Math.max(1, Number(r.INTERVAL ?? 1));
  const until = r.UNTIL ? toUtcDay(`${r.UNTIL.slice(0, 4)}-${r.UNTIL.slice(4, 6)}-${r.UNTIL.slice(6, 8)}`) : Infinity;
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  if (target > until) return false;
  const byDay = r.BYDAY ? r.BYDAY.split(",").map((d) => d.slice(-2)) : null;
  let n = 0;
  const s = new Date(first);
  switch (r.FREQ) {
    case "DAILY": {
      const k = Math.round((target - first) / DAY_MS);
      if (k % interval) return false;
      return Math.floor(k / interval) < count;
    }
    case "WEEKLY": {
      const days = byDay ?? [WEEKDAYS[s.getUTCDay()]];
      // Weeks start on Monday (WKST default); count occurrences in order up to the target.
      const weekStart = (ms: number) => ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS;
      for (let w = weekStart(first), steps = 0; w <= target && steps < 5000; w += 7 * interval * DAY_MS, steps++) {
        for (let i = 0; i < 7; i++) {
          const d = w + i * DAY_MS;
          if (d < first || d > until || !days.includes(WEEKDAYS[new Date(d).getUTCDay()])) continue;
          n++;
          if (n > count) return false;
          if (d === target) return true;
        }
      }
      return false;
    }
    case "MONTHLY": {
      const t = new Date(target);
      const months = (t.getUTCFullYear() - s.getUTCFullYear()) * 12 + t.getUTCMonth() - s.getUTCMonth();
      if (months % interval || t.getUTCDate() !== s.getUTCDate()) return false;
      return months / interval < count;
    }
    case "YEARLY": {
      const t = new Date(target);
      const years = t.getUTCFullYear() - s.getUTCFullYear();
      if (years % interval || t.getUTCMonth() !== s.getUTCMonth() || t.getUTCDate() !== s.getUTCDate()) return false;
      return years / interval < count;
    }
    default:
      return false;
  }
}

export interface DayEvent {
  uid: string;
  summary: string;
  location: string;
  /** HH:MM, or null for all day. */
  time: string | null;
  endTime: string | null;
}

/** The events of one day: occurrences that start or continue on it, overrides applied, sorted (all-day first). */
export function eventsOn(events: readonly CalEvent[], day: string): DayEvent[] {
  const overrides = new Map<string, CalEvent>();
  for (const e of events) if (e.recurrenceId) overrides.set(`${e.uid} ${e.recurrenceId}`, e);
  const out: DayEvent[] = [];
  const target = toUtcDay(day);
  for (const e of events) {
    if (e.recurrenceId) continue;
    const span = spanDays(e);
    for (let back = 0; back <= span; back++) {
      const startDay = isoOfUtc(target - back * DAY_MS);
      if (!startsOn(e, startDay)) continue;
      const ov = overrides.get(`${e.uid} ${startDay}`);
      // An instance moved to another day shows there (below), not here.
      if (ov && ov.start.date !== startDay) break;
      const src = ov ?? e;
      out.push({ uid: e.uid, summary: src.summary, location: src.location, time: back === 0 ? src.start.time : null, endTime: back === span ? (src.end?.time ?? null) : null });
      break;
    }
  }
  for (const ov of overrides.values()) if (ov.start.date === day && !out.some((x) => x.uid === ov.uid)) out.push({ uid: ov.uid, summary: ov.summary, location: ov.location, time: ov.start.time, endTime: ov.end?.time ?? null });
  return out.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "") || a.summary.localeCompare(b.summary));
}
