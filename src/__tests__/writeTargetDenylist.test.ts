/**
 * The agents' write deny-list (reviews 21 D3, 24, 30): review 30's attack
 * table (rr30/t/denylist30.ts) as a test. "MUST": refused; "OK": an
 * ordinary or distinct name, allowed; "INFO": reported by the review, and
 * the ones it lists as stream forms of control files (CLAUDE.md:stream,
 * AGENTS.md:x, CLAUDE.MD:x) are refused since RR30-1. Also: stageChange
 * itself refuses (RR30-2), so the organizer and the MCP inbox are covered.
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { safeWriteTarget } from "../agents/tools/define";
import { writeTargetProblem } from "../agents/writeTarget";
import { clearStagedChanges, listStagedChanges, stageChange } from "../agents/staging";

const cases: Array<[string, "MUST" | "OK" | "INFO", string]> = [
  ["CLAUDE.md:stream", "INFO", "NTFS: a stream of CLAUDE.md (creates it if absent); the Windows native vault refuses ':'"],
  ["CLAUDE.md:stream:$DATA", "MUST", "NTFS stream, full form"],
  ["CLAUDE.md::$DATA", "MUST", "NTFS default stream = CLAUDE.md itself"],
  ["CLAUDE.md:$DATA", "MUST", "malformed stream form"],
  ["CLAUDE.md:", "MUST", "trailing colon"],
  ["CLAUDE.md. :x", "INFO", "trailing dot+space then a stream"],
  ["CLAUDE.md .::$DATA", "MUST", "trailing space+dot then the default stream"],
  ["CLAUDE.md.::$DATA", "MUST", "trailing dot then the default stream"],
  ["AGENTS.md:x", "INFO", "stream of another control file"],
  ["CLAUDE.md：：$DATA", "OK", "fullwidth colons: a distinct name on every file system"],
  ["CLAUDE.md﹕﹕$DATA", "OK", "small colons"],
  ["CLAUDE.md∶∶$DATA", "OK", "ratio signs"],
  ["CLAUDE.md꞉x", "OK", "modifier colon"],
  ["C：/x.md", "OK", "fullwidth drive letter"],
  ["notes\\..\\.lumen\\x.md", "MUST", "backslash .. into .lumen"],
  ["notes\\.lumen/skills/x/SKILL.md", "MUST", "mixed separators into .lumen"],
  [".\\.lumen\\mcp.json", "MUST", "./ in backslashes"],
  ["notes/.lumen\\x", "MUST", "mixed"],
  ["\\.lumen\\x.md", "MUST", "leading backslash"],
  ["notes//.lumen//x.md", "MUST", "doubled slashes"],
  [".lumen./x.md", "MUST", "trailing dot on the folder"],
  [".lumen /x.md", "MUST", "trailing space on the folder"],
  ["LUMEN~1/x.md", "MUST", "8.3 short name of .lumen"],
  ["CLAUDE~1.MD", "MUST", "8.3 short name of CLAUDE.md"],
  ["notes/CLAUDE.md. . .", "MUST", "trailing dots and spaces"],
  ["CLAUDE.MD:x", "INFO", "case + stream"],
  ["Meeting: plan.md", "OK", "ordinary note name"],
  ["~draft.md", "OK", "ordinary note name"],
  ["notes/a~b.md", "OK", "ordinary note name"],
  ["A: plan.md", "INFO", "a one-letter name then ':' reads as a drive prefix"],
  ["notes/CON.md", "INFO", "Windows device name"],
];

const refused = (p: string) => {
  try {
    safeWriteTarget(p);
    return false;
  } catch {
    return true;
  }
};

describe("the write deny-list (review 30)", () => {
  it("refuses every MUST path and allows every OK one", () => {
    for (const [p, kind, why] of cases) {
      if (kind === "MUST") expect(refused(p), `${p}: ${why}`).toBe(true);
      if (kind === "OK") expect(refused(p), `${p}: ${why}`).toBe(false);
    }
  });

  it("RR30-1: a stream of a control file is that file", () => {
    for (const p of ["CLAUDE.md:stream", "AGENTS.md:x", "CLAUDE.MD:x", "notes/GEMINI.md:zone", ".lumen:x/y.md"]) expect(refused(p), p).toBe(true);
    for (const p of ["Meeting: plan.md", "notes/Plan: CLAUDE notes.md", "~draft.md"]) expect(refused(p), p).toBe(false);
  });

  it("RR30-2: stageChange refuses it for every proposer (organizer, MCP inbox)", () => {
    clearStagedChanges();
    for (const path of [".lumen/skills/x/SKILL.md", "CLAUDE.md", "notes/AGENTS.md:x"]) {
      expect(() => stageChange({ kind: "file", path, before: null, after: "x", summary: "s" }, { tool: "organize_tags", agentId: "organizer" }), path).toThrow("Not staged");
    }
    expect(stageChange({ kind: "file", path: "notes/Meeting: plan.md", before: null, after: "x", summary: "s" }, { tool: "t", agentId: "mcp:x" }).status).toBe("pending");
    expect(stageChange({ kind: "range", path: null, from: 0, to: 0, before: "", after: "x", summary: "s" }, { tool: "t" }).status).toBe("pending");
    expect(listStagedChanges()).toHaveLength(2);
    expect(writeTargetProblem("notes/ok.md")).toBeNull();
  });
});
