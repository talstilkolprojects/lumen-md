import { describe, expect, it } from "vitest";
import { eventsOn, fold, parseEvents, parseTodos, startsOn, todoToIcs, unfold, escapeText, unescapeText } from "../calendar/ical";
import { BLOCK_END, BLOCK_START, eventLines, feedEventsOn, withCalendarBlock } from "../calendar/dailyEvents";
import { CALDAV_KEY, CALDAV_PASSWORD, ICS_SUBSCRIPTIONS, httpUrl, readAccount, saveAccount } from "../calendar/config";
import { isSecretName } from "../lib/secretStore";

const cal = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;

describe("iCalendar for tasks and subscriptions (W7.20)", () => {
  it("folds at 75 octets without splitting a Hebrew letter, and unfolds back", () => {
    const line = "SUMMARY:" + "משימה ארוכה ".repeat(12);
    const folded = fold(line);
    for (const l of folded.split("\r\n")) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    expect(unfold(folded)).toEqual([line]);
    expect(unescapeText(escapeText("a, b; c\\d\nשורה"))).toBe("a, b; c\\d\nשורה");
  });

  it("a VTODO goes out and comes back the same, Hebrew and commas included", () => {
    const t = { uid: "u-1@lumen", summary: "לקנות חלב, לחם; ביצים", due: "2026-11-20", start: "2026-11-18", completed: true, completedOn: "2026-11-19" };
    expect(parseTodos(todoToIcs(t, new Date("2026-11-19T08:00:00Z")))).toEqual([t]);
    const open = { ...t, completed: false, completedOn: null };
    expect(parseTodos(todoToIcs(open, new Date()))).toEqual([open]);
  });

  it("reads other clients' VTODOs: DUE with a time in UTC, STATUS without COMPLETED, Apple's folded lines", () => {
    const ics = cal("BEGIN:VTODO\r\nUID:x\r\nSUMMARY:Call\r\n  the bank\r\nDUE:20261120T220000Z\r\nSTATUS:COMPLETED\r\nEND:VTODO");
    const [t] = parseTodos(ics);
    expect(t.summary).toBe("Call the bank");
    expect(t.completed).toBe(true);
    expect(t.due).toMatch(/^2026-11-2[01]$/);
  });

  it("recurring events: weekly with BYDAY and COUNT, daily with INTERVAL and EXDATE, yearly, UNTIL", () => {
    const ics = cal([
      "BEGIN:VEVENT\r\nUID:w\r\nSUMMARY:Seminar\r\nDTSTART:20261102T100000\r\nDTEND:20261102T113000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4\r\nEND:VEVENT",
      "BEGIN:VEVENT\r\nUID:d\r\nSUMMARY:Run\r\nDTSTART;VALUE=DATE:20261101\r\nRRULE:FREQ=DAILY;INTERVAL=2\r\nEXDATE;VALUE=DATE:20261105\r\nEND:VEVENT",
      "BEGIN:VEVENT\r\nUID:y\r\nSUMMARY:Birthday\r\nDTSTART;VALUE=DATE:20001114\r\nRRULE:FREQ=YEARLY\r\nEND:VEVENT",
      "BEGIN:VEVENT\r\nUID:u\r\nSUMMARY:Until\r\nDTSTART;VALUE=DATE:20261101\r\nRRULE:FREQ=DAILY;UNTIL=20261103\r\nEND:VEVENT",
    ].join("\r\n"));
    const ev = parseEvents(ics);
    const w = ev.find((e) => e.uid === "w")!;
    expect(["2026-11-02", "2026-11-04", "2026-11-09", "2026-11-11", "2026-11-16", "2026-11-03"].map((d) => startsOn(w, d))).toEqual([true, true, true, true, false, false]);
    const d = ev.find((e) => e.uid === "d")!;
    expect(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-05", "2026-11-07"].map((x) => startsOn(d, x))).toEqual([true, false, true, false, true]);
    expect(startsOn(ev.find((e) => e.uid === "y")!, "2026-11-14")).toBe(true);
    const u = ev.find((e) => e.uid === "u")!;
    expect([startsOn(u, "2026-11-03"), startsOn(u, "2026-11-04")]).toEqual([true, false]);
    expect(eventsOn(ev, "2026-11-04").map((e) => [e.summary, e.time, e.endTime])).toEqual([["Seminar", "10:00", "11:30"]]);
  });

  it("multi-day events cover each day, and a moved instance shows on its new day only", () => {
    const ics = cal([
      "BEGIN:VEVENT\r\nUID:c\r\nSUMMARY:Conference\r\nDTSTART;VALUE=DATE:20261116\r\nDTEND;VALUE=DATE:20261119\r\nEND:VEVENT",
      "BEGIN:VEVENT\r\nUID:r\r\nSUMMARY:Lecture\r\nDTSTART:20261102T090000\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT",
      "BEGIN:VEVENT\r\nUID:r\r\nSUMMARY:Lecture (moved)\r\nRECURRENCE-ID:20261109T090000\r\nDTSTART:20261110T140000\r\nEND:VEVENT",
    ].join("\r\n"));
    const ev = parseEvents(ics);
    expect(["2026-11-16", "2026-11-18", "2026-11-19"].map((d) => eventsOn(ev, d).some((e) => e.summary === "Conference"))).toEqual([true, true, false]);
    expect(eventsOn(ev, "2026-11-09")).toEqual([]);
    expect(eventsOn(ev, "2026-11-10").map((e) => [e.summary, e.time])).toEqual([["Lecture (moved)", "14:00"]]);
    expect(eventsOn(ev, "2026-11-16").map((e) => e.summary)).toEqual(["Conference", "Lecture"]);
  });

  it("the daily note gets a read-only block that a refresh replaces, after its heading, frontmatter untouched", () => {
    const feeds = feedEventsOn([{ name: "Uni", ics: cal("BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Exam *A*\r\nLOCATION:Hall 3\r\nDTSTART:20261114T090000\r\nDTEND:20261114T120000\r\nEND:VEVENT") }, { name: "Home", ics: cal("BEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Shabbat\r\nDTSTART;VALUE=DATE:20261114\r\nEND:VEVENT") }], "2026-11-14");
    const lines = eventLines(feeds, { allDay: "All day", none: "Nothing today" });
    expect(lines).toEqual(["- All day Shabbat (Home)", "- 09:00–12:00 Exam \\*A\\* · Hall 3 (Uni)"]);
    const note = "---\ntags: [daily]\n---\n# 14.11\n\nMy notes.";
    const once = withCalendarBlock(note, "Calendar", lines);
    expect(once).toBe(`---\ntags: [daily]\n---\n# 14.11\n\n${BLOCK_START}\n## Calendar\n${lines.join("\n")}\n${BLOCK_END}\n\nMy notes.`);
    expect(withCalendarBlock(once, "Calendar", ["- Nothing today"])).toBe(`---\ntags: [daily]\n---\n# 14.11\n\n${BLOCK_START}\n## Calendar\n- Nothing today\n${BLOCK_END}\n\nMy notes.`);
    expect(eventLines([{ name: "x", events: [] }], { allDay: "", none: "Nothing today" })).toEqual(["- Nothing today"]);
  });

  it("no password in settings: the account keeps url, user and inbox; the password and ICS list are secret-store names", async () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    await saveAccount({ url: "https://dav.example/cal/tasks/", user: "dana", inbox: "Tasks/Calendar.md" }, null, store);
    expect(JSON.parse(m.get(CALDAV_KEY)!)).toEqual({ url: "https://dav.example/cal/tasks/", user: "dana", inbox: "Tasks/Calendar.md" });
    expect(readAccount(store)?.user).toBe("dana");
    expect([...m.values()].join()).not.toMatch(/pass/i);
    expect(isSecretName(CALDAV_PASSWORD)).toBe(true);
    expect(isSecretName(ICS_SUBSCRIPTIONS)).toBe(true);
    expect(httpUrl("webcal://calendar.example/feed.ics")).toBe("https://calendar.example/feed.ics");
  });
});
