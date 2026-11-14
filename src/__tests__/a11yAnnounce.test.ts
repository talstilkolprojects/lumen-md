/** Screen-reader announcements (plan W1.23): what is said, and when. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { aiBusyAnnouncer, announce, describeLine, headingAbove, nextVerbosity, recentAnnouncements, setVerbosity, verbosity } from "../a11y/announce";

describe("describeLine", () => {
  it("structure mode speaks headings, tasks, fences and quotes only", () => {
    expect(describeLine("## Next steps", 5, "structure")).toEqual({ key: "sr.heading", vars: { level: 2, line: 5, text: "Next steps" } });
    expect(describeLine("###### deep", 1, "structure")?.vars.level).toBe(6);
    expect(describeLine("- [ ] buy milk", 2, "structure")?.key).toBe("sr.task.open");
    expect(describeLine("* [x] done", 2, "structure")?.key).toBe("sr.task.done");
    expect(describeLine("```ts", 3, "structure")?.key).toBe("sr.codeFence");
    expect(describeLine("> quoted", 4, "structure")?.key).toBe("sr.quote");
    expect(describeLine("plain text", 6, "structure")).toBeNull();
    expect(describeLine("#hashtag is not a heading", 6, "structure")).toBeNull();
  });

  it("all mode adds the line number; off says nothing", () => {
    expect(describeLine("plain", 9, "all")).toEqual({ key: "sr.line", vars: { line: 9 } });
    expect(describeLine("# Title", 1, "off")).toBeNull();
  });

  it("Hebrew headings keep their text", () => {
    expect(describeLine("# תוכנית העבודה", 1, "structure")?.vars.text).toBe("תוכנית העבודה");
  });
});

describe("headingAbove", () => {
  const lines = ["# Plan", "text", "```", "# not a heading in code", "```", "## Steps", "more"];
  it("finds the nearest heading above, ignoring code blocks", () => {
    expect(headingAbove(lines, 2)).toBe("Plan");
    expect(headingAbove(lines, 5)).toBe("Plan");
    expect(headingAbove(lines, 7)).toBe("Steps");
    expect(headingAbove(["no heading"], 1)).toBeNull();
  });
});

describe("verbosity", () => {
  beforeEach(() => localStorage.clear());
  it("defaults to structure and cycles structure → all → off", () => {
    expect(nextVerbosity("structure")).toBe("all");
    expect(nextVerbosity("all")).toBe("off");
    expect(nextVerbosity("off")).toBe("structure");
    setVerbosity("all");
    expect(verbosity()).toBe("all");
    setVerbosity("structure");
  });
});

describe("announce", () => {
  it("records what was said (empty text is skipped)", () => {
    announce("Heading 1: Plan");
    announce("   ");
    expect(recentAnnouncements()[recentAnnouncements().length - 1]).toBe("Heading 1: Plan");
  });
});

describe("aiBusyAnnouncer", () => {
  it("stays quiet for short work and speaks start and end of long work", () => {
    vi.useFakeTimers();
    const said: boolean[] = [];
    const on = aiBusyAnnouncer((b) => said.push(b), 1500);
    on(true);
    vi.advanceTimersByTime(200);
    on(false);
    expect(said).toEqual([]);
    on(true);
    vi.advanceTimersByTime(1600);
    on(false);
    expect(said).toEqual([true, false]);
    vi.useRealTimers();
  });
});
