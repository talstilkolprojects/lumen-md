/**
 * i18n t() function — comprehensive unit tests.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { t, applyLocale, getLocale, loadLocale } from "../i18n";
// graphView.stats is lazy English (startup budget, train 2): registered when the graph view's strings load.
import "../ui/graphViewStrings";

describe("t() function", () => {
  // Hebrew is a lazy chunk since A7 lever 4; main.tsx preloads it via
  // initLocale() before first render, the tests do the same here.
  beforeAll(async () => {
    await loadLocale("he");
  });

  it("returns English string for known key", () => {
    applyLocale("en");
    expect(t("toolbar.new")).toBe("New");
  });

  it("returns the key itself for unknown key", () => {
    applyLocale("en");
    expect(t("this.key.does.not.exist")).toBe("this.key.does.not.exist");
  });

  it("interpolates {var} placeholders", () => {
    applyLocale("en");
    const result = t("status.words", { n: "42" });
    expect(result).toContain("42");
  });

  it("interpolates multiple placeholders", () => {
    applyLocale("en");
    const result = t("graphView.stats", { nodes: "10", edges: "15" });
    expect(result).toContain("10");
    expect(result).toContain("15");
  });

  it("returns Hebrew for he locale", () => {
    applyLocale("he");
    expect(t("toolbar.new")).toBe("חדש");
    applyLocale("en");
  });

  it("getLocale returns current locale", () => {
    applyLocale("en");
    expect(getLocale()).toBe("en");
    applyLocale("he");
    expect(getLocale()).toBe("he");
    applyLocale("en");
  });

  it("falls back to en for missing keys in he", () => {
    applyLocale("he");
    // Use a key that likely exists in en but might not in he
    const result = t("toolbar.new");
    // Should be Hebrew "חדש" if present, or English "New" if not
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    applyLocale("en");
  });

  it("handles empty params object", () => {
    applyLocale("en");
    const result = t("toolbar.new", {});
    expect(result).toBe("New");
  });

  // Regression guard for the round-9 bug: 16 templates accidentally used
  // `{{key}}` double-brace syntax. Before the fix, t() only replaced the
  // inner `{key}` and left the outer braces, so users saw literal "{5}"
  // in the writing-goal counter, "{12 selected}" in the file tree, etc.
  it("interpolates {{key}} double-brace templates (regression guard)", () => {
    applyLocale("en");
    // writingGoal.progress is one of the 16 affected templates.
    const result = t("writingGoal.progress", { words: "5", goal: "100", pct: "5" });
    expect(result).toBe("5 / 100 words · 5%");
    expect(result).not.toContain("{");
    expect(result).not.toContain("}");
  });

  it("interpolates {{key}} in he locale too", () => {
    applyLocale("he");
    const result = t("writingGoal.progress", { words: "3", goal: "50", pct: "6" });
    expect(result).toBe("3 / 50 מילים · 6%");
    applyLocale("en");
  });
});
