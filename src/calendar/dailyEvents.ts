/**
 * Calendar subscriptions in the daily note (plan W7.20): read-only ICS feeds
 * (any calendar's "secret address", or W7.8's academic calendar) whose events
 * for the note's day are written into a fenced block of the note. The block
 * is replaced on refresh and nothing else in the note is touched; the events
 * are never written back anywhere.
 */
import { eventsOn, parseEvents, type DayEvent } from "./ical";

export const BLOCK_START = "<!-- lumen-calendar:start -->";
export const BLOCK_END = "<!-- lumen-calendar:end -->";

export interface FeedEvents {
  name: string;
  events: DayEvent[];
}

/** Each feed's events on `day` (YYYY-MM-DD), in the device's time zone unless one is given. */
export function feedEventsOn(feeds: ReadonlyArray<{ name: string; ics: string }>, day: string, timeZone?: string): FeedEvents[] {
  return feeds.map((f) => ({ name: f.name, events: eventsOn(parseEvents(f.ics, timeZone), day) }));
}

/** One line per event: `- 09:00–10:30 Title · Place (Feed)`; all-day events first, without a time. */
export function eventLines(feeds: readonly FeedEvents[], labels: { allDay: string; none: string }): string[] {
  const all = feeds.flatMap((f) => f.events.map((e) => ({ ...e, feed: f.name })));
  all.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "") || a.summary.localeCompare(b.summary));
  if (!all.length) return [`- ${labels.none}`];
  const md = (s: string) => s.replace(/([\\`*_[\]<>#|])/g, "\\$1").replace(/\r?\n/g, " ");
  return all.map((e) => {
    const when = e.time ? `${e.time}${e.endTime ? `–${e.endTime}` : ""}` : labels.allDay;
    const where = e.location ? ` · ${md(e.location)}` : "";
    const from = feeds.length > 1 ? ` (${md(e.feed)})` : "";
    return `- ${when} ${md(e.summary)}${where}${from}`;
  });
}

/** The note with its calendar block set to `lines` (added after the first heading, or after the frontmatter, or at the top). */
export function withCalendarBlock(note: string, heading: string, lines: readonly string[]): string {
  const nl = note.includes("\r\n") ? "\r\n" : "\n";
  const block = [BLOCK_START, `## ${heading}`, ...lines, BLOCK_END].join(nl);
  const s = note.indexOf(BLOCK_START);
  const e = note.indexOf(BLOCK_END, s + 1);
  if (s >= 0 && e > s) return note.slice(0, s) + block + note.slice(e + BLOCK_END.length);
  const ls = note.split(/\r?\n/);
  const fm = ls[0] === "---" ? ls.indexOf("---", 1) + 1 : 0;
  const h = ls.findIndex((l, i) => i >= fm && /^#\s/.test(l));
  const at = h >= 0 ? h + 1 : fm;
  return [...ls.slice(0, at), ...(at ? [""] : []), block, ...(ls.length > at ? [""] : []), ...ls.slice(at)].join(nl).replace(new RegExp(`(${nl}){3,}`, "g"), nl + nl);
}
