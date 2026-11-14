import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script without types
import { commandLabelKeys, commandMentions, englishStrings, norm, npmRuns, staleCounts } from "../../scripts/docs-sync.mjs";

describe("docs-sync (plan 0.18)", () => {
  it("finds the command a doc line names, in each style the docs use", () => {
    expect(commandMentions("`⌘K → Encrypt document` for at-rest encryption.")).toEqual(["Encrypt document"]);
    expect(commandMentions('**AI policy** (`⌘K → "AI: Local or Cloud Policy"`):')).toEqual(["AI: Local or Cloud Policy"]);
    expect(commandMentions("Then `⌘K → Research: Settings → SearXNG on this machine` and enter")).toEqual(["Research: Settings"]);
    expect(commandMentions("Command: `AI: Usage & Cost This Month` (`⌘K`).")).toEqual(["AI: Usage & Cost This Month"]);
    expect(commandMentions("Command: `AI: Batch over a Folder (half price)…`, then `AI: Check Batch Jobs`.")).toEqual(["AI: Batch over a Folder (half price)…", "AI: Check Batch Jobs"]);
    expect(commandMentions("Command palette → **Trusted plugin signing keys…**")).toEqual(["Trusted plugin signing keys…"]);
    expect(commandMentions("Run **Enable TypeScript checks in code blocks** from the command palette.")).toEqual(["Enable TypeScript checks in code blocks"]);
    expect(commandMentions('Turn it on from the command palette ("Turn on suggesting mode") or with')).toEqual(["Turn on suggesting mode"]);
    expect(commandMentions("| `⌘K` | Command palette (everything is here) |")).toEqual([]);
    // review #227: a label with parentheses inside the code span is still checked
    expect(commandMentions("hybrid retrieval (`⌘K → Smart search (semantic + keyword)`)")).toEqual(["Smart search (semantic + keyword)"]);
    expect(commandMentions('⌘K → "Switch to local AI (WebGPU)"')).toEqual(["Switch to local AI (WebGPU)"]);
  });

  it("matches labels ignoring case, emoji and the trailing ellipsis, and fills placeholders", () => {
    const en = englishStrings(`
  "cmd.security.encrypt": "🔒 Encrypt Document",
  "cmd.view.language": "Language: {label}",
  "cmd.ai.settings": "AI Settings…",
`);
    expect(en.has(norm("Encrypt document"))).toBe(true);
    expect(en.has(norm("Language: …"))).toBe(true);
    expect(en.has(norm("Language: עברית"))).toBe(true);
    expect(en.has(norm("AI Settings"))).toBe(true);
    expect(en.has(norm("Lock vault"))).toBe(false);
  });

  it("only command labels count, not every UI string (review #227)", () => {
    const keys = commandLabelKeys([`{ id: "x", label: useLocalAi ? t("ai.local.off") : t("ai.local.on"), run }`, `<button>{t("ai.doctor.copy")}</button>`]);
    const en = englishStrings(`
  "ai.local.on": "Switch to local AI",
  "ai.doctor.copy": "Copy command",
  "cmd.x": "Open thing",
`, keys);
    expect(en.has(norm("Switch to local AI"))).toBe(true);
    expect(en.has(norm("Open thing"))).toBe(true);
    expect(en.has(norm("Copy command"))).toBe(false);
  });

  it("finds npm scripts and hand-typed counts", () => {
    expect(npmRuns("npm run -s docs:sync && npm run test:e2e")).toEqual(["docs:sync", "test:e2e"]);
    expect(staleCounts("npm test              # vitest (992 unit tests across 123 files)")).toEqual(["992 unit tests"]);
    expect(staleCounts("[![Tests](https://img.shields.io/badge/tests-2196%20passing-brightgreen)]")).toEqual(["tests-2196"]);
    expect(staleCounts("| `⌘K` | Command palette (100+ commands) |")).toEqual(["100+ commands"]);
    expect(staleCounts("8 languages with 638-key full coverage")).toEqual(["638-key"]);
    expect(staleCounts("**Coverage**: lines 97.24 % · branches 69.56 %")).toEqual(["97.24 %", "69.56 %"]);
    expect(staleCounts("Safari and iOS 16.4+, Chrome / Edge 111+")).toEqual([]);
  });
});
