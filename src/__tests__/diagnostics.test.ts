/**
 * W3.7 — the diagnostics bundle carries 0 note content and 0 secrets:
 * built from a store full of note text, names, keys and a room, with logs
 * that mention paths, URLs and keys, and scanned for every one of them.
 */
import { describe, expect, it } from "vitest";
import { assertClean, buildDiagnostics, diagnosticsText, settingsOf, vaultShape } from "../feedback/diagnostics";
import { contentFree, log, recentLogs } from "../lib/logger";

const NOTE = "My secret diary: the code to the safe is 4417 and Dana's phone is 054-1234567";
const HEB = "הפגישה עם רופא הלב ביום ראשון — לא לשכוח את התוצאות";
const KEY = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234567890";
const GH = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

const state = {
  mode: "split",
  theme: "dark",
  locale: "he",
  autoSave: true,
  autoSaveInterval: 30,
  vimEnabled: false,
  writingGoalWords: 500,
  aiKey: KEY,
  githubToken: GH,
  collabRoom: "room-of-dana-and-omer",
  doc: { name: "Diary — private.md", content: `${NOTE}\n${HEB}`, workspaceName: "Personal/Diary — private.md", dirty: true },
  openTabs: [{ id: "a", name: "Medical/רופא הלב.md", content: HEB }],
  recents: [{ name: "Taxes 2026.md", path: "Money/Taxes 2026.md" }],
  themeSettings: { preset: "hebrew", fontFamily: "custom", customFont: "Dana Handwriting", fontSize: 16, lineHeight: 1.8, contentWidth: 70 },
  dailyNotes: { folder: "journal/פרטי", pattern: "YYYY-MM-DD", template: `# {{date}}\n${NOTE}` },
  userEmail: "dana@example.com",
};

describe("the diagnostics bundle", () => {
  it("holds settings, the vault's shape, storage and logs", () => {
    const d = buildDiagnostics({
      state,
      env: { shell: "web", platform: "Linux x86_64", language: "he-IL", userAgent: "Mozilla/5.0 test" },
      entries: [{ path: "Personal/Diary — private.md", size: 1200 }, { path: "Medical/רופא הלב.md", size: 800 }, { path: "img/x.png", size: 5000 }],
      storage: { opfs: true, persisted: true, quotaMB: 1000, usageMB: 12 },
      logs: [],
    });
    expect(d.settings).toEqual({ mode: "split", theme: "dark", locale: "he", vimEnabled: false, autoSave: true, autoSaveInterval: 30, writingGoalWords: 500, "themeSettings.preset": "hebrew", "themeSettings.fontFamily": "custom", "themeSettings.fontSize": 16, "themeSettings.lineHeight": 1.8, "themeSettings.contentWidth": 70, "dailyNotes.pattern": "YYYY-MM-DD", openTabs: 1 });
    expect(d.vault).toEqual({ notes: 2, otherFiles: 1, folders: 3, bytes: 7000 });
    expect(d.app.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("scans clean: no note text, names, paths, keys, room or e-mail — even from the logs", () => {
    log.warn("save failed for Personal/Diary — private.md", new Error(`could not write "${NOTE}"`));
    log.error("sync: request https://api.example.com/v1/notes/42?token=abc123 failed", { content: NOTE });
    log.error(`auth with Bearer ${KEY} for dana@example.com rejected`);
    log.warn(`key ${GH} rejected; folder Medical/רופא הלב.md missing`);
    const d = buildDiagnostics({ state, env: { shell: "web", platform: "x", language: "he", userAgent: "UA" }, entries: [{ path: "Personal/Diary — private.md", size: 1 }], storage: { opfs: true, persisted: null, quotaMB: null, usageMB: null } });
    const text = diagnosticsText(d);
    expect(d.logs.length).toBeGreaterThanOrEqual(4);
    for (const needle of [NOTE, HEB, "secret diary", "4417", "054-1234567", KEY, GH, "sk-proj", "ghp_", "room-of-dana", "Diary", "private", "רופא", "Taxes", "dana@example.com", "Dana Handwriting", "journal/פרטי", "token=abc123", "/v1/notes/42"]) {
      expect(text.includes(needle), needle).toBe(false);
    }
    // The logs still say what happened.
    expect(text).toContain("save failed for [path]");
    expect(text).toContain("https://api.example.com/[…]");
  });

  it("refuses to hand out a bundle that leaks", () => {
    const d = buildDiagnostics({ state, env: { shell: "web", platform: "x", language: "he", userAgent: "UA" }, entries: null, storage: { opfs: false, persisted: null, quotaMB: null, usageMB: null }, logs: [] });
    const leaky = { ...d, logs: [{ t: d.generatedAt, level: "error", message: NOTE }] };
    expect(() => assertClean(leaky, state)).toThrow();
  });

  it("keeps log lines content-free", () => {
    expect(contentFree("couldn't open Projects/Plan 2027.md")).toBe("couldn't open [path]");
    expect(contentFree('quoted "private words" here')).toBe('quoted "…" here');
    expect(contentFree("call https://host.example/a/b?c=d")).toBe("call https://host.example/[…]");
    expect(recentLogs().every((r) => !r.message.includes(NOTE))).toBe(true);
  });

  it("counts settings only from the allowlist", () => {
    expect(Object.keys(settingsOf({ aiKey: KEY, mode: "preview" }))).toEqual(["mode"]);
    expect(vaultShape([]).notes).toBe(0);
  });
});
