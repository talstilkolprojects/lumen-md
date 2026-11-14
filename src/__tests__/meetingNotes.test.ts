/**
 * Plan 6.16 — the meeting-writer agent through the runtime, and the note it
 * produces: tasks with owner and due date, relative dates from the meeting's
 * day, a date that isn't one sent back once.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null, locale: "en" }) } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import { registerExecutor, resetExecutors } from "../agents/executors";
import { fakeExecutor, sequence } from "./helpers/fakeExecutor";
import { meetingNotesFrom } from "../meetings/meetingNotes";
import { tasksInNote } from "../tasks/taskParser";

const TRANSCRIPT = "Dana: we ship on Tuesday. Avi, can you send the budget by next Wednesday? Avi: sure. Who pays for the venue — we don't know yet.";

describe("meetingNotesFrom", () => {
  beforeEach(() => {
    localStorage.clear();
    resetExecutors();
  });

  it("decisions, tasks with owner and date, open questions — tasks readable by the task index, an .ics for the dated ones", async () => {
    const ex = fakeExecutor(sequence(JSON.stringify({ decisions: ["Ship on Tuesday"], tasks: [{ text: "Send the budget", owner: "Avi", due: "2026-11-18" }, { text: "Find out who pays for the venue" }], questions: ["Who pays for the venue?"] })));
    registerExecutor(ex);
    const res = await meetingNotesFrom(TRANSCRIPT, { date: "2026-11-09", local: true });
    expect(res.notes.tasks).toEqual([{ text: "Send the budget", owner: "Avi", due: "2026-11-18" }, { text: "Find out who pays for the venue" }]);
    expect(tasksInNote("m.md", res.markdown).map((t) => t.due)).toEqual(["2026-11-18", null]);
    expect(res.markdown).toContain("- Ship on Tuesday");
    expect(res.markdown).toContain("- Who pays for the venue?");
    expect(res.ics).toContain("DUE;VALUE=DATE:20261118");
    // The model was told the meeting's date, for "next Wednesday".
    expect(JSON.stringify(ex.calls[0].messages)).toContain("held on 2026-11-09");
  });

  it("a due date that isn't a YYYY-MM-DD date is sent back once with the reason", async () => {
    const ex = fakeExecutor(
      sequence(
        JSON.stringify({ decisions: [], tasks: [{ text: "Send the budget", due: "next Wednesday" }], questions: [] }),
        JSON.stringify({ decisions: [], tasks: [{ text: "Send the budget", due: "2026-11-18" }], questions: [] }),
      ),
    );
    registerExecutor(ex);
    const res = await meetingNotesFrom(TRANSCRIPT, { date: "2026-11-09" });
    expect(ex.calls).toHaveLength(2);
    expect(JSON.stringify(ex.calls[1].messages)).toContain("not YYYY-MM-DD");
    expect(res.notes.tasks[0].due).toBe("2026-11-18");
  });

  it("no dated task, no calendar file", async () => {
    registerExecutor(fakeExecutor(sequence(JSON.stringify({ decisions: [], tasks: [{ text: "Call Dana" }], questions: [] }))));
    expect((await meetingNotesFrom("Call Dana.", { date: "2026-11-09" })).ics).toBeNull();
  });
});
