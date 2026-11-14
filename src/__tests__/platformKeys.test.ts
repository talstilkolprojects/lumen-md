import { describe, it, expect } from "vitest";
import { platformKeys } from "../lib/platformKeys";

describe("platformKeys", () => {
  it("is a no-op on a Mac", () => {
    expect(platformKeys("Press ⌘K", true)).toBe("Press ⌘K");
  });
  it("rewrites Mac glyphs for Windows / Linux", () => {
    expect(platformKeys("Press `⌘K` or ⇧⌘F, ⌥⌘I and ⌘1-4", false)).toBe("Press `Ctrl+K` or Ctrl+Shift+F, Ctrl+Alt+I and Ctrl+1-4");
    expect(platformKeys("(⌘K → AI Settings)", false)).toBe("(Ctrl+K → AI Settings)");
    expect(platformKeys("⌘Enter runs", false)).toBe("Ctrl+Enter runs");
    expect(platformKeys("⌘/ toggles", false)).toBe("Ctrl+/ toggles");
  });
  it("leaves text without shortcuts alone", () => {
    expect(platformKeys("שלום ⇧ עולם", false)).toBe("שלום ⇧ עולם");
  });
});
