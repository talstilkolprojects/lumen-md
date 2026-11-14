/**
 * Plan 6.16 — meeting notes: cleaning the model's answer, task lines the
 * vault's task index (4.13) reads, the .ics calendar, and the task-recall
 * measure the golden meetings (7.10, owner 15.11) are scored with.
 */
import { describe, it, expect } from "vitest";
import { formatMeetingNote, isIsoDate, normalizeNotes, taskLine, taskRecall, tasksToIcs } from "../meetings/meetingCore";
import { tasksInNote } from "../tasks/taskParser";

const labels = { title: "Meeting", decisions: "Decisions", tasks: "Tasks", questions: "Open questions", none: "none", transcript: "Transcript" };

describe("meeting notes", () => {
  it("cleans the answer: duplicates, empty items, @owners, task symbols, impossible dates", () => {
    const n = normalizeNotes({
      decisions: ["Ship on Tuesday", " ship on tuesday ", ""],
      tasks: [{ text: "- [ ] Send the budget 📅", owner: "@Dana", due: "2026-11-12" }, { text: "Book the room", due: "2026-02-30" }, { text: "" }, "nope"],
      questions: ["Who pays?"],
    });
    expect(n).toEqual({ decisions: ["Ship on Tuesday"], tasks: [{ text: "Send the budget", owner: "Dana", due: "2026-11-12" }, { text: "Book the room" }], questions: ["Who pays?"] });
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
  });

  it("tasks become checkbox lines the vault's task index reads, with owner and due date", () => {
    const n = normalizeNotes({ decisions: [], tasks: [{ text: "Send the budget", owner: "Dana Cohen", due: "2026-11-12" }, { text: "להזמין חדר ישיבות" }], questions: [] });
    expect(taskLine(n.tasks[0])).toBe("- [ ] Send the budget (@Dana_Cohen) 📅 2026-11-12");
    const md = formatMeetingNote(n, { date: "2026-11-09", transcript: "…", labels, local: true });
    const tasks = tasksInNote("meetings/weekly.md", md);
    expect(tasks.map((t) => [t.description, t.due, t.status])).toEqual([
      ["Send the budget (@Dana_Cohen)", "2026-11-12", "TODO"],
      ["להזמין חדר ישיבות", null, "TODO"],
    ]);
    expect(md).toContain("### Decisions\n\n_none_");
    expect(md).toContain("<details><summary>Transcript</summary>");
  });

  it("dated tasks go to an .ics calendar, one VTODO each; no dates, no file", () => {
    const ics = tasksToIcs([{ text: "Send the budget, today; really", owner: "Dana", due: "2026-11-12" }, { text: "No date" }], { title: "Meeting 2026-11-09", stamp: new Date("2026-11-09T10:00:00Z"), uidSeed: "m1" })!;
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.match(/BEGIN:VTODO/g)).toHaveLength(1);
    expect(ics).toContain("DUE;VALUE=DATE:20261112\r\n");
    expect(ics).toContain("SUMMARY:Send the budget\\, today\\; really\r\n");
    expect(ics).toContain("DTSTAMP:20261109T100000Z\r\n");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    // Lines fold at 75 octets.
    const long = tasksToIcs([{ text: "ש".repeat(80), due: "2026-11-12" }], { title: "t", stamp: new Date(0), uidSeed: "x" })!;
    expect(long.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(tasksToIcs([{ text: "No date" }], { title: "t", stamp: new Date(0), uidSeed: "x" })).toBeNull();
  });

  it("task recall matches tasks by their words, in English and Hebrew", () => {
    expect(taskRecall(["Dana sends the budget", "book a room"], ["Send budget to finance", "Book the meeting room", "Call Avi"])).toBe(2 / 3);
    expect(taskRecall(["לשלוח את התקציב לדנה"], ["דנה תשלח את התקציב"])).toBe(1);
    expect(taskRecall([], [])).toBe(1);
    expect(taskRecall(["the same task"], ["Ship it", "Ship it again"])).toBe(0);
  });
});
