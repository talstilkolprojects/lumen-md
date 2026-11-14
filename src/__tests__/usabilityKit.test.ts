/**
 * W1.29 — the usability-test kit: the recorder starts only with consent and
 * keeps no content, the study's tasks and questionnaires match the Hebrew
 * protocol word for word, and the analysis computes SUS, success and the
 * plan's acceptance correctly. The sessions themselves need people: Tal
 * runs them (5–8 per round).
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deleteSession, endSession, exportFile, loadSession, MAX_AGE_MS, record, safeCommandId, safeLabel, safeTestId, setSeq, setSus, shortcutOf, startSession, STORE_KEY, validParticipant, type Session } from "../research/usability/sessionRecorder";
import { SEQ_QUESTION, SUS_ITEMS, susScore, TASKS } from "../research/usability/study";
// @ts-expect-error — plain .mjs helpers without types
import { acceptance, analyze, attempts, meanCI, parseFindings, parseSession, report, susScore as susScoreMjs, t95 } from "../../scripts/lib/usability.mjs";

const root = process.cwd();
const kit = (f: string) => readFileSync(join(root, "research/usability", f), "utf8");

function mem(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}
const APP = { version: "0.1.0", locale: "he", dir: "rtl", viewport: "1280x800", touch: false };

describe("the recorder: consent first, local, no content", () => {
  it("refuses to start without consent, a valid code, or a round of 1 or 2", () => {
    const s = mem();
    expect(() => startSession({ participant: "P1", round: 1, consent: false, app: APP, storage: s })).toThrow(/consent/);
    expect(() => startSession({ participant: "Dana", round: 1, consent: true, app: APP, storage: s })).toThrow(/P1/);
    expect(() => startSession({ participant: "P1", round: 3, consent: true, app: APP, storage: s })).toThrow(/round/);
    expect(s.getItem(STORE_KEY)).toBe(null);
    expect(validParticipant("p7")).toBe(true);
    expect(validParticipant("P0")).toBe(false);
    expect(validParticipant("P21")).toBe(false);
  });

  it("survives a reload, and a session older than 30 days is deleted", () => {
    const s = mem();
    const now = Date.parse("2026-11-10T10:00:00Z");
    const ses = startSession({ participant: "p3", round: 1, consent: true, app: APP, storage: s, now });
    expect(ses.participant).toBe("P3");
    record(ses, { t: now + 1, type: "task-start", task: 1 }, s);
    expect(loadSession(s, now + 1000)?.events.length).toBe(1);
    expect(loadSession(s, now + MAX_AGE_MS + 1)).toBe(null);
    expect(s.getItem(STORE_KEY)).toBe(null);
  });

  it("labels: only the app's own UI strings are kept", () => {
    const ui = new Set(["סגירה", "Close", "פתק חדש"]);
    expect(safeLabel("סגירה", ui)).toBe("סגירה");
    expect(safeLabel("רשימת קריאה", ui)).toBe("[label]"); // a note's name on a tab
    expect(safeLabel("Close רשימת קריאה", ui)).toBe("[label]");
    expect(safeLabel("", ui)).toBe("");
    expect(safeTestId("outline-sheet")).toBe("outline-sheet");
    expect(safeTestId("tab-רשימה")).toBe(undefined);
  });

  it("keys: counted, never named, except modifier shortcuts", () => {
    const k = (key: string, mods: Partial<KeyboardEvent> = {}) => shortcutOf({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods } as KeyboardEvent);
    expect(k("ש")).toBe(null);
    expect(k("a")).toBe(null);
    expect(k("k", { metaKey: true })).toBe("Mod+K");
    expect(k("ש", { ctrlKey: true })).toBe("Mod+[key]");
    expect(k("Escape")).toBe("Escape");
    expect(k("Control", { ctrlKey: true })).toBe(null);
  });

  it("commands: by id, but never an id that carries a name", () => {
    expect(safeCommandId("view.preview")).toBe("view.preview");
    expect(safeCommandId("recent.רשימה.md")).toBe("recent.*");
    expect(safeCommandId("template.weekly")).toBe("template.*");
    expect(safeCommandId("plugin.demo.run")).toBe("plugin.*");
    expect(safeCommandId("weird id with spaces")).toBe("[command]");
  });

  it("an exported session holds none of what the participant typed", () => {
    const s = mem();
    const ses = startSession({ participant: "P2", round: 1, consent: true, app: APP, storage: s, now: 1000 });
    const ui = new Set(["פתק חדש"]);
    const secret = "סודי ביותר: הרשימה של דנה";
    record(ses, { t: 1100, type: "task-start", task: 1 }, s);
    record(ses, { t: 1200, type: "click", role: "button", label: safeLabel("פתק חדש", ui) }, s);
    record(ses, { t: 1300, type: "click", role: "tab", label: safeLabel(secret, ui) }, s);
    for (const ch of secret) record(ses, { t: 1400, type: shortcutOf({ key: ch, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }) ? "shortcut" : "keys", count: 1 } as never, s);
    record(ses, { t: 1500, type: "command", id: safeCommandId("recent.הרשימה של דנה") }, s);
    record(ses, { t: 2000, type: "task-end", task: 1, outcome: "success", assisted: false }, s);
    setSeq(ses, 1, 6, s);
    setSus(ses, [5, 1, 5, 1, 5, 1, 5, 1, 5, 1], s);
    endSession(ses, 3000, s);
    const f = exportFile(ses);
    expect(f.name).toBe("usability-P2-r1-1970-01-01.json");
    for (const needle of ["סודי", "דנה", "הרשימה"]) expect(f.text).not.toContain(needle);
    const back = JSON.parse(f.text) as Session;
    expect(back.events.filter((e) => e.type === "keys").reduce((n, e) => n + (e as { count: number }).count, 0)).toBe(secret.length);
    // Ended: nothing more is recorded.
    record(ses, { t: 4000, type: "error" }, s);
    expect(ses.events.at(-1)?.type).toBe("task-end");
    deleteSession(s);
    expect(loadSession(s)).toBe(null);
  });

  it("makes no request: the recorder module has no fetch, XHR, beacon or socket", () => {
    const src = readFileSync(join(root, "src/research/usability/sessionRecorder.ts"), "utf8") + readFileSync(join(root, "src/ui/UsabilitySessionPanel.tsx"), "utf8");
    expect(src).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
  });

  it("answers are checked: SEQ 1–7, SUS ten answers 1–5", () => {
    const ses = startSession({ participant: "P1", round: 2, consent: true, app: APP, storage: mem() });
    expect(() => setSeq(ses, 1, 8, null)).toThrow();
    expect(() => setSus(ses, [1, 2, 3], null)).toThrow();
    expect(() => setSus(ses, [0, 1, 1, 1, 1, 1, 1, 1, 1, 1], null)).toThrow();
  });
});

describe("the study matches the Hebrew protocol", () => {
  const protocol = kit("protocol.he.md");

  it("ten tasks, each a section with a scenario, success criteria and its time limit", () => {
    expect(TASKS.map((x) => x.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const task of TASKS) {
      const head = `### משימה ${task.id} — ${task.he}`;
      expect(protocol, head).toContain(head);
      const section = protocol.slice(protocol.indexOf(head), protocol.indexOf("###", protocol.indexOf(head) + head.length));
      expect(section, head).toContain("**תרחיש:**");
      expect(section, head).toContain("**הצלחה:**");
      expect(section, head).toContain(`**מגבלת זמן:** ${task.limitMin} דקות`);
    }
  });

  it("SUS: the ten statements word for word, in order, and SEQ", () => {
    let at = protocol.indexOf("## 7. שאלון SUS");
    expect(at).toBeGreaterThan(0);
    SUS_ITEMS.forEach((item, i) => {
      const line = `${i + 1}. ${item.he}`;
      const pos = protocol.indexOf(line, at);
      expect(pos, line).toBeGreaterThan(at);
      at = pos;
    });
    expect(protocol).toContain(SEQ_QUESTION.he);
  });

  it("the findings template lists the same ten tasks", () => {
    const f = kit("findings-template.he.md");
    for (const task of TASKS) expect(f).toContain(`| ${task.id} | ${task.he} |`);
  });

  it("the seed vault has what the tasks need", () => {
    const dir = join(root, "research/usability/seed-vault");
    const notes = readdirSync(dir);
    expect(notes).toContain("סמינר מחקר.md"); // task 3
    expect(notes).toContain("טיוטה ישנה.md"); // task 9
    const all = notes.map((n) => readFileSync(join(dir, n), "utf8"));
    expect(all.filter((t) => /ראיון/.test(t)).length).toBe(2); // task 4
    expect(all.some((t) => /#קורס/.test(t))).toBe(true); // task 5
  });

  it("consent: recording only with consent, what isn't recorded, deletion after analysis, withdrawal", () => {
    const c = kit("consent.he.md");
    expect(c).toMatch(/מרצון/);
    expect(c).toMatch(/לא נרשם/);
    expect(c).toMatch(/נמחקים אחרי שניתוח הסבב נכתב/);
    expect(c).toMatch(/אוטומטית אחרי 30 יום/);
    expect(c).toMatch(/להפסיק בכל רגע/);
    expect(c).toMatch(/☐ אני מסכים\/ה שיוקלטו המסך/);
  });

  it("the kit says the sessions are Tal's to run", () => {
    expect(kit("README.md")).toMatch(/Tal runs round 1\s+>?\s*\(5–8 participants\)/);
    expect(protocol).toMatch(/להריץ 5–8 מפגשים/);
  });
});

describe("the analysis", () => {
  it("SUS: the standard rule, the same in the app and the script", () => {
    expect(susScore([5, 1, 5, 1, 5, 1, 5, 1, 5, 1])).toBe(100);
    expect(susScore([1, 5, 1, 5, 1, 5, 1, 5, 1, 5])).toBe(0);
    expect(susScore([3, 3, 3, 3, 3, 3, 3, 3, 3, 3])).toBe(50);
    expect(susScore([4, 2, 4, 2, 4, 2, 4, 2, 4, 2])).toBe(75);
    for (const a of [[5, 1, 5, 1, 5, 1, 5, 1, 5, 1], [4, 2, 5, 1, 3, 2, 4, 2, 4, 1]]) expect(susScoreMjs(a)).toBe(susScore(a));
    expect(susScoreMjs([1, 2])).toBe(null);
  });

  it("confidence intervals use the t distribution for small samples", () => {
    expect(t95(1)).toBeCloseTo(12.706, 3);
    expect(t95(7)).toBeCloseTo(2.365, 3);
    expect(t95(100)).toBe(1.96);
    const ci = meanCI([70, 80, 90]);
    expect(ci.mean).toBe(80);
    expect(ci.low).toBeCloseTo(80 - (4.303 * 10) / Math.sqrt(3), 6);
    expect(meanCI([80]).low).toBe(null);
  });

  function session(p: string, round: number, outcomes: Array<[string, boolean]>, sus: number[]): string {
    let t = 0;
    const events: unknown[] = [];
    outcomes.forEach(([outcome, assisted], i) => {
      events.push({ t: (t += 1000), type: "task-start", task: i + 1 });
      if (i === 2) events.push({ t: (t += 10), type: "error" }, { t: (t += 10), type: "command", id: "help.open" });
      events.push({ t: (t += 30_000), type: "task-end", task: i + 1, outcome, assisted });
    });
    return JSON.stringify({ schema: "lumen-usability/1", participant: p, round, consentAt: "", startedAt: 0, app: APP, events, seq: { 1: 6, 2: 5 }, sus });
  }

  it("per task: success, unaided, partials, median time, errors, help; an unfinished task counts as gave-up", () => {
    const ok = Array.from({ length: 10 }, () => ["success", false] as [string, boolean]);
    const a = parseSession(session("P1", 2, ok, [5, 1, 5, 1, 5, 1, 5, 1, 5, 1]));
    const mixed = ok.map((x, i) => (i === 0 ? (["success", true] as [string, boolean]) : i === 1 ? (["partial", false] as [string, boolean]) : x));
    const b = parseSession(session("P2", 2, mixed, [4, 2, 4, 2, 4, 2, 4, 2, 4, 2]));
    const r = analyze([a, b]);
    expect(r.tasks[0]).toMatchObject({ n: 2, success: 1, unaidedSuccess: 0.5 });
    expect(r.tasks[1]).toMatchObject({ success: 0.5, lenient: 0.75 });
    expect(r.tasks[2]).toMatchObject({ errors: 2, help: 2, medianSeconds: 30.02 });
    expect(r.tasks[0].seq).toBe(6);
    expect(r.susCI.mean).toBe(87.5);
    expect(r.unaidedSuccess).toBe(18 / 20);
    const unfinished = attempts({ participant: "P3", events: [{ t: 0, type: "task-start", task: 4 }] });
    expect(unfinished[0]).toMatchObject({ task: 4, outcome: "gave-up", unfinished: true });
  });

  it("acceptance (round 2): SUS ≥ 80, ≥ 90% unaided, 10/10 severe issues closed from the findings table", () => {
    const ok = Array.from({ length: 10 }, () => ["success", false] as [string, boolean]);
    const r = analyze([parseSession(session("P1", 2, ok, [5, 1, 5, 1, 5, 1, 5, 1, 5, 1]))]);
    const rows = Array.from({ length: 10 }, (_, i) => `| U${i + 1} | ${i + 1} | ${i < 9 ? 3 : 4} | 3/8 | x | P1 | y | W9.${i} | ${i === 9 ? "פתוח" : "סגור"} |`).join("\n");
    const md = `| מזהה | משימה בבדיקה | חומרה | שכיחות | תיאור | ראיות | המלצה | משימה בתוכנית | סטטוס |\n|---|---|---|---|---|---|---|---|---|\n${rows}\n`;
    const findings = parseFindings(md);
    expect(findings.length).toBe(10);
    let a = acceptance(r, findings);
    expect(a.map((x: { ok: boolean }) => x.ok)).toEqual([true, true, false]);
    a = acceptance(r, parseFindings(md.replace("פתוח", "סגור")));
    expect(a.every((x: { ok: boolean }) => x.ok)).toBe(true);
    // The empty template parses to rows with no severity: no severe issues yet.
    expect(parseFindings(kit("findings-template.he.md")).filter((f: { severity: number }) => f.severity >= 3)).toEqual([]);
    const text = report(r, { round: 2, taskNames: TASKS.map((x) => x.he), findings });
    expect(text).toContain("| 1 | פתק חדש |");
    expect(text).toContain("קריטריוני קבלה");
  });

  it("refuses files that aren't sessions", () => {
    expect(() => parseSession("{}", "x.json")).toThrow(/not a Lumen usability session/);
    expect(() => parseSession("nope", "x.json")).toThrow(/not JSON/);
    expect(() => parseSession(JSON.stringify({ schema: "lumen-usability/1", participant: "Dana", events: [] }))).toThrow(/code/);
  });
});

describe("docs", () => {
  it("the study page exists in English and Hebrew, with a sidebar entry", () => {
    expect(readFileSync(join(root, "docs/astro.config.mjs"), "utf8")).toContain('slug: "project/usability"');
    const en = readFileSync(join(root, "docs/src/content/docs/project/usability.md"), "utf8");
    const he = readFileSync(join(root, "docs/src/content/docs/he/project/usability.md"), "utf8");
    expect(en).toContain("Usability study (moderator)…");
    expect(he).toContain("בדיקת שימושיות (למנחה)…");
  });
});
