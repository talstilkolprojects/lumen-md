/**
 * Plan W10.B20 (audit 1.7): the model credits and licences dialog was only
 * reachable through a command built in the *voice* section. It now sits
 * with the other help commands (help.open, help.diagnostics), and the
 * palette finds it by "קרדיטים" in Hebrew and "credits" in English.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildAiControlCommands } from "../commands/domains/ai";
import { buildVoiceCommands } from "../commands/domains/voice";
import type { CommandContext } from "../commands/domains/context";

const he = JSON.parse(readFileSync("src/i18n/locales/he/cmd.json", "utf8")) as Record<string, string>;
const en = JSON.parse(readFileSync("src/i18n/locales/en/cmd.json", "utf8")) as Record<string, string>;

describe("credits command (W10.B20)", () => {
  const help = buildAiControlCommands({ getEditorView: () => null } as unknown as CommandContext);
  const ids = help.map((c) => c.id);

  it("is built with the help commands, right after help.diagnostics", () => {
    expect(ids).toContain("help.open");
    expect(ids.indexOf("help.credits")).toBe(ids.indexOf("help.diagnostics") + 1);
  });

  it("is no longer part of the voice section", () => {
    expect(buildVoiceCommands().map((c) => c.id)).not.toContain("help.credits");
  });

  it("its label is found by 'קרדיטים' (Hebrew) and 'credits' (English)", () => {
    expect(he["cmd.help.credits"]).toContain("קרדיטים");
    expect(en["cmd.help.credits"].toLowerCase()).toContain("credits");
  });

  it("opens the real credits dialog module", () => {
    const src = readFileSync("src/commands/domains/ai.ts", "utf8");
    const block = src.slice(src.indexOf('id: "help.credits"'), src.indexOf('id: "help.credits"') + 400);
    expect(block).toMatch(/import\("\.\.\/\.\.\/ui\/CreditsDialog"\)/);
  });
});
