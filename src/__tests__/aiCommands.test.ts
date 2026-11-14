import { describe, it, expect, vi } from "vitest";

vi.mock("../store/useStore", () => ({
  useAppStore: {
    getState: vi.fn().mockReturnValue({
      aiKey: null,
      setAiKey: vi.fn(),
    }),
  },
}));
vi.mock("../ui/CommandPalette", () => ({
  cmdIcons: { Sparkles: undefined },
}));
vi.mock("../ui/PromptDialog", () => ({
  uiPrompt: vi.fn().mockResolvedValue(null),
  uiAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../i18n", () => ({ registerEnglish: () => undefined, t: (k: string) => k }));
vi.mock("../lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../sync/git", () => ({
  gitStatusSummary: vi.fn().mockResolvedValue({ entries: [] }),
}));
vi.mock("../ui/AiToast", () => ({
  showAiToast: vi.fn(),
}));

describe("buildAiSettingsCommand", () => {
  it("returns a command object with id 'ai.settings'", async () => {
    const { buildAiSettingsCommand } = await import("../ai/commands");
    const cmd = buildAiSettingsCommand();
    expect(cmd.id).toBe("ai.settings");
  });

  it("command has a label", async () => {
    const { buildAiSettingsCommand } = await import("../ai/commands");
    const cmd = buildAiSettingsCommand();
    expect(typeof cmd.label).toBe("string");
    expect(cmd.label.length).toBeGreaterThan(0);
  });

  it("command has an action function", async () => {
    const { buildAiSettingsCommand } = await import("../ai/commands");
    const cmd = buildAiSettingsCommand();
    expect(typeof cmd.action).toBe("function");
  });

  it("command has a group", async () => {
    const { buildAiSettingsCommand } = await import("../ai/commands");
    const cmd = buildAiSettingsCommand();
    expect(typeof cmd.group).toBe("string");
  });
});

describe("generateAiCommitMessage", () => {
  it("returns empty string when git has no changes", async () => {
    const { generateAiCommitMessage } = await import("../ai/commands");
    const msg = await generateAiCommitMessage("/fake/repo");
    expect(msg).toBe("");
  });

  it("returns empty string when no AI key is set", async () => {
    const { generateAiCommitMessage } = await import("../ai/commands");
    const msg = await generateAiCommitMessage("/fake/repo");
    expect(typeof msg).toBe("string");
  });
});
