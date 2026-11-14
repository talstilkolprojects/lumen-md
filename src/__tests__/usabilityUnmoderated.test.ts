/**
 * The self-guided usability round (plan W4.25): sessions get a random code
 * and their mode; the practice notes are written once and the draft waits
 * in the trash; each verifiable task is judged from the notes (yes / no
 * only); outcomes follow the protocol's table; a reload resumes where the
 * session was; the scripts on screen are the ones in tasks-self.he.md; the
 * .zip the participant sends is read by the analysis, which checks the
 * plan's acceptance (≥ 12 participants: 5 moderated + 7 self-guided, SUS ≥ 75,
 * every severe finding → a plan task).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { newSelfCode, outcomeOf, SCRIPTS, SEED_FOLDER, SENTENCE_6, seedPracticeNotes, stepOf, TODO_LINES, verifyTask, type VaultAccess } from "../research/usability/unmoderated";
import { endSession, exportFile, record, setSeq, startSession, validParticipant, type Session } from "../research/usability/sessionRecorder";
import { TASKS } from "../research/usability/study";
import { zip } from "../storage/zip";
import { acceptanceMixed, analyze, parseFindings, parseSession, report, zipJsonEntries } from "../../scripts/lib/usability.mjs";

const root = resolve(__dirname, "../..");
const kit = (f: string) => readFileSync(join(root, "research/usability", f), "utf8");
const app = { version: "0.1.0", locale: "he", dir: "rtl", viewport: "1280x800", touch: false };
const vault = (files: Record<string, string>): VaultAccess => ({ list: async () => Object.keys(files), read: async (p) => files[p] });

describe("self-guided sessions", () => {
  it("get a random U-code, never a name, and record their mode; moderated sessions are unchanged", () => {
    let i = 0;
    const seq = [0.01, 0.5, 0.99, 0.3];
    const code = newSelfCode(() => seq[i++]);
    expect(code).toMatch(/^U-[A-HJ-NP-Z2-9]{4}$/);
    expect(validParticipant(code, "unmoderated")).toBe(true);
    expect(validParticipant(code)).toBe(false);
    expect(validParticipant("P3", "unmoderated")).toBe(false);
    expect(validParticipant("Dana", "unmoderated")).toBe(false);
    const s = startSession({ participant: code, round: 1, consent: true, app, mode: "unmoderated", storage: null, now: 1 });
    expect(s.mode).toBe("unmoderated");
    expect(() => startSession({ participant: code, round: 1, consent: false, app, mode: "unmoderated", storage: null })).toThrow(/consent/);
    const m = startSession({ participant: "P2", round: 1, consent: true, app, storage: null, now: 1 });
    expect("mode" in m).toBe(false);
  });

  it("writes the practice notes into their own folder once, and puts the draft in the trash", async () => {
    const seed = Object.fromEntries(readdirSync(join(root, "research/usability/seed-vault")).map((f) => [f, readFileSync(join(root, "research/usability/seed-vault", f), "utf8")]));
    const files = new Map<string, string>();
    const trashed: string[] = [];
    const fs = { exists: async (p: string) => files.has(p) || trashed.includes(p), write: async (p: string, t: string) => void files.set(p, t), trash: async (p: string) => void (files.delete(p), trashed.push(p)) };
    const first = await seedPracticeNotes(fs, seed);
    expect(first.written.length).toBe(Object.keys(seed).length + 1);
    expect([...files.keys()].every((p) => p.startsWith(`${SEED_FOLDER}/`))).toBe(true);
    expect(trashed).toEqual([`${SEED_FOLDER}/טיוטה ישנה.md`]);
    expect(files.get(`${SEED_FOLDER}/משימות.md`)).toBe(`# משימות\n\n${TODO_LINES.join("\n")}\n`);
    // A second run (a reload) writes nothing and trashes nothing.
    const again = await seedPracticeNotes(fs, seed);
    expect(again.written).toEqual([]);
    expect(trashed).toHaveLength(1);
  });

  it("judges each task from the notes, yes or no; search and export are not checked", async () => {
    const good = vault({
      "רשימת קריאה.md": "---\ntags: [ספרים]\n---\n# ספרים לסמסטר\n\nמבוא לאלגוריתמים\nמבני נתונים\n\nראו [[סמינר מחקר]] #קורס\n\n| ספר | מחבר/ת |\n|---|---|\n| א | ב |\n| ג | ד |\n",
      [`${SEED_FOLDER}/משימות.md`]: `# משימות\n\n- [x] ${TODO_LINES[0]}\n- [ ] ${TODO_LINES[1]}\n- [ ] ${TODO_LINES[2]}\n`,
      "אחר.md": `${SENTENCE_6}\n`,
      [`${SEED_FOLDER}/טיוטה ישנה.md`]: "# טיוטה ישנה",
      "Daily/2026-11-12.md": "- לקרוא פרק 3\n",
    });
    const bad = vault({
      "רשימת קריאה.md": "# ספרים לסמסטר\nרק שורה אחת\n[סמינר](https://example.com) #קורסים\n| ספר |\n|---|\n| א |\n",
      [`${SEED_FOLDER}/משימות.md`]: `- [ ] ${TODO_LINES[0]}\n- [ ] ${TODO_LINES[1]}\n- [ ] ${TODO_LINES[2]}\n`,
      "אחר.md": "בשנת 2026 אלמד ML",
      "Daily/2026-11-11.md": "- לקרוא פרק 3\n",
    });
    const today = "2026-11-12";
    for (const id of [1, 2, 3, 5, 6, 7, 9, 10]) {
      expect(await verifyTask(id, good, today), `task ${id}`).toBe(true);
      expect(await verifyTask(id, id === 1 ? vault({ "רשימת קריאה.md": "# ספרים לסמסטר\nרק שורה אחת\n" }) : bad, today), `task ${id}`).toBe(false);
    }
    expect(await verifyTask(4, good, today)).toBeNull();
    expect(await verifyTask(8, good, today)).toBeNull();
    // A Markdown link to the note counts for task 3; a front-matter tag for task 5.
    expect(await verifyTask(3, vault({ "רשימת קריאה.md": "[ס](<סמינר מחקר.md>)" }), today)).toBe(true);
    expect(await verifyTask(5, vault({ "רשימת קריאה.md": "---\ntags:\n  - קורס\n---\nx" }), today)).toBe(true);
  });

  it("outcomes: verified within the limit = success, past it = partial, refuted = fail, gave up = gave-up", () => {
    const limit = TASKS[0].limitMin * 60;
    expect(outcomeOf("done", true, limit - 1, 1)).toBe("success");
    expect(outcomeOf("done", true, limit + 1, 1)).toBe("partial");
    expect(outcomeOf("done", null, limit - 1, 4)).toBe("success");
    expect(outcomeOf("done", false, 10, 1)).toBe("fail");
    expect(outcomeOf("gave-up", null, 10, 1)).toBe("gave-up");
  });

  it("a reload resumes where the session was: task → running → ease question → next task … → SUS → done", () => {
    const s = startSession({ participant: "U-ABCD", round: 1, consent: true, app, mode: "unmoderated", storage: null, now: 0 });
    expect(stepOf(null)).toEqual({ kind: "intro" });
    expect(stepOf(s)).toEqual({ kind: "task", task: 1 });
    record(s, { t: 5, type: "task-start", task: 1 }, null);
    expect(stepOf(s)).toEqual({ kind: "running", task: 1, since: 5 });
    record(s, { t: 9, type: "task-end", task: 1, outcome: "success", assisted: false, verified: true }, null);
    expect(stepOf(s)).toEqual({ kind: "seq", task: 1 });
    setSeq(s, 1, 6, null);
    expect(stepOf(s)).toEqual({ kind: "task", task: 2 });
    for (let k = 2; k <= 10; k++) {
      record(s, { t: 10 * k, type: "task-start", task: k }, null);
      record(s, { t: 10 * k + 5, type: "task-end", task: k, outcome: "gave-up", assisted: false, verified: null }, null);
      setSeq(s, k, 3, null);
    }
    expect(stepOf(s)).toEqual({ kind: "sus" });
    endSession(s, 999, null);
    expect(stepOf(s)).toEqual({ kind: "done" });
  });

  it("the scripts on screen are the ones in tasks-self.he.md, one per task", () => {
    const md = kit("tasks-self.he.md");
    expect(Object.keys(SCRIPTS).map(Number)).toEqual(TASKS.map((x) => x.id));
    for (const x of TASKS) {
      expect(md).toContain(`## ${x.id}. ${x.he}`);
      expect(md).toContain(SCRIPTS[x.id].he);
      expect(md).toContain(`**מגבלת זמן:** ${x.limitMin} דקות`);
    }
  });
});

function session(code: string, mode: "moderated" | "unmoderated", sus: number[]): Session {
  const s = startSession({ participant: code, round: 1, consent: true, app, mode, storage: null, now: 1_000 });
  TASKS.forEach((x, i) => {
    record(s, { t: 2_000 + i * 100_000, type: "task-start", task: x.id }, null);
    record(s, { t: 2_000 + i * 100_000 + 60_000, type: "task-end", task: x.id, outcome: "success", assisted: false, ...(mode === "unmoderated" ? { verified: x.id === 4 || x.id === 8 ? null : i % 3 !== 0 } : {}) }, null);
    setSeq(s, x.id, 6, null);
  });
  s.sus = sus;
  endSession(s, 9_999_999, null);
  return s;
}

describe("analysis of a mixed round (W4.25)", () => {
  const good = [5, 1, 5, 1, 5, 1, 5, 1, 4, 2]; // SUS 95
  const meh = [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]; // SUS 50

  it("reads the participant's .zip (session + README) and the moderator's .json alike", async () => {
    const s = session("U-7K3F", "unmoderated", good);
    const f = exportFile(s);
    for (const store of [true, false]) {
      const bytes = await zip([
        { name: f.name, data: f.text, store },
        { name: "README.txt", data: "no text, no names", store },
      ]);
      const entries = zipJsonEntries(bytes, inflateRawSync);
      expect(entries.map(([n]) => n)).toEqual([f.name]);
      expect(parseSession(entries[0][1]).participant).toBe("U-7K3F");
    }
    expect(f.name).toMatch(/^usability-U-7K3F-r1-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it("acceptance: 12 = 5 moderated + 7 self-guided, SUS ≥ 75, every severe finding has a plan task", () => {
    const mod = ["P1", "P2", "P3", "P4", "P5"].map((c) => parseSession(JSON.stringify(session(c, "moderated", good))));
    const self = ["U-AAAA", "U-BBBB", "U-CCCC", "U-DDDD", "U-EEEE", "U-FFFF", "U-GGGG"].map((c) => parseSession(JSON.stringify(session(c, "unmoderated", c === "U-AAAA" ? meh : good))));
    const r = analyze([...mod, ...self]);
    expect(r.modes).toEqual({ moderated: 5, unmoderated: 7 });
    expect(r.verified!.checked).toBe(7 * 8);
    const header = "| מזהה | משימה בבדיקה | חומרה | שכיחות | תיאור | ראיות | המלצה | משימה בתוכנית | סטטוס |\n|---|---|---|---|---|---|---|---|---|\n";
    const withTasks = parseFindings(header + "| U1 | 3 | 4 | 5/12 | x | U-AAAA | y | W6.1 | פתוח |\n| U2 | 6 | 2 | 2/12 | x | P1 | y | | פתוח |\n");
    expect(acceptanceMixed(r, withTasks).map((a: { ok: boolean }) => a.ok)).toEqual([true, true, true]);
    const missing = parseFindings(header + "| U1 | 3 | 3 | 5/12 | x | P2 | y | | פתוח |\n");
    expect(acceptanceMixed(r, missing).map((a: { ok: boolean }) => a.ok)).toEqual([true, true, false]);
    // Six self-guided sessions are not enough.
    expect(acceptanceMixed(analyze([...mod, ...self.slice(1)]), withTasks)[0].ok).toBe(false);
    const text = report(r, { round: 1, taskNames: TASKS.map((x) => x.he), findings: withTasks });
    expect(text).toContain("מונחים: 5 · עצמאיים: 7");
    expect(text).toContain("קריטריוני קבלה (W4.25");
    expect(text).toMatch(/אושרו בפתקים/);
  });
});
