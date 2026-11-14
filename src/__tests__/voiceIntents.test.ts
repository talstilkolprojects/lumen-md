/**
 * Plan W5.20 — local voice commands: the intent grammar on the 200 spoken
 * commands (a development set: the grammar was written against it; the
 * held-out score is the owner's recordings, `npm run eval:voice-commands`),
 * no command from ordinary dictated sentences, the dispatch rules, and no
 * network on the way.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { INTENTS, normalizeCommand, parseIntent, type Intent } from "../ai/voice/intents";
import { NOT_COMMANDS, SPOKEN_COMMANDS } from "../ai/voice/commandCorpus";
import { runIntent, type IntentDeps } from "../ai/voice/dispatch";

describe("the intent grammar", () => {
  it("has 20 intents, each on a palette command, and 200 spoken commands, 10 per intent", () => {
    expect(INTENTS).toHaveLength(20);
    expect(new Set(INTENTS.map((i) => i.id)).size).toBe(20);
    expect(SPOKEN_COMMANDS).toHaveLength(200);
    for (const i of INTENTS) expect(SPOKEN_COMMANDS.filter((c) => c.intent === i.id), i.id).toHaveLength(10);
  });

  it("recognises ≥ 90 % of the 200 commands, with their slots, in Hebrew and English", () => {
    const right = SPOKEN_COMMANDS.filter((c) => parseIntent(c.text)?.id === c.intent);
    expect(right.length / SPOKEN_COMMANDS.length).toBeGreaterThanOrEqual(0.9);
    for (const lang of [/[א-ת]/, /^[^א-ת]*$/]) {
      const set = SPOKEN_COMMANDS.filter((c) => lang.test(c.text));
      expect(set.filter((c) => parseIntent(c.text)?.id === c.intent).length / set.length).toBeGreaterThanOrEqual(0.9);
    }
    for (const c of SPOKEN_COMMANDS.filter((x) => x.slot)) expect(parseIntent(c.text)?.slot, c.text).toBe(c.slot);
  });

  it("runs nothing on ordinary dictated sentences", () => {
    for (const s of NOT_COMMANDS) expect(parseIntent(s), s).toBeNull();
    expect(parseIntent("")).toBeNull();
    expect(parseIntent("אממ בבקשה")).toBeNull();
  });

  it("prefers the longest trigger and reads the ASR's text as it comes (niqqud, punctuation, a glued ו)", () => {
    expect(parseIntent("הפסק להקריא")?.id).toBe("stop-reading");
    expect(parseIntent("צוֹר פֶּתֶק חָדָשׁ, בְּשֵׁם: קניות!")).toMatchObject({ id: "new-note", slot: "קניות" });
    expect(parseIntent("ותחפש בפתקים על תקציב")).toMatchObject({ id: "search", slot: "תקציב" });
    expect(normalizeCommand("Read-Aloud!")).toBe("read aloud");
    expect(parseIntent("מחק את הפתק")).toMatchObject({ id: "delete-note", command: "file.trash", confirm: true });
  });
});

describe("dispatch", () => {
  const deps = (confirm = true) => {
    const calls: string[] = [];
    const d: IntentDeps = {
      runCommand: (id) => void calls.push(`run ${id}`),
      confirm: async () => (calls.push("confirm"), confirm),
      capture: async (text) => void calls.push(`capture ${text}`),
      insert: (text) => void calls.push(`insert ${text}`),
      searchFor: (q) => void calls.push(`search ${q}`),
    };
    return { d, calls };
  };
  const intent = (text: string): Intent => parseIntent(text)!;
  afterEach(() => vi.unstubAllGlobals());

  it("asks before a destructive command, and does nothing on no", async () => {
    const no = deps(false);
    expect(await runIntent(intent("מחק את הפתק"), no.d)).toBe("cancelled");
    expect(no.calls).toEqual(["confirm"]);
    const yes = deps(true);
    expect(await runIntent(intent("delete this note"), yes.d)).toBe("ran");
    expect(yes.calls).toEqual(["confirm", "run file.trash"]);
  });

  it("puts a task in the inbox, a title in the new note, a query in the search box", async () => {
    const { d, calls } = deps();
    await runIntent(intent("הוסף משימה להתקשר לרופא"), d);
    await runIntent(intent("add a task"), d);
    await runIntent(intent("צור פתק חדש בשם קניות"), d);
    await runIntent(intent("חפש מתכון לשקשוקה"), d);
    await runIntent(intent("פתח את הפתק היומי"), d);
    expect(calls).toEqual(["capture - [ ] להתקשר לרופא", "run tasks.open", "run file.new", "insert # קניות\n\n", "run view.search", "search מתכון לשקשוקה", "run note.today"]);
  });

  it("makes no network request on the way", async () => {
    const fetch = vi.fn(() => Promise.reject(new Error("network")));
    vi.stubGlobal("fetch", fetch);
    const { d } = deps();
    for (const c of SPOKEN_COMMANDS) {
      const i = parseIntent(c.text);
      if (i) await runIntent(i, d);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
