/**
 * Plan 6.15 — the data analyst: table extraction, the two-run verifier
 * (6.15.2), the answer contract, the note blocks (6.15.3) and the golden
 * scoring rule. The model and the sandbox are stand-ins here; the real
 * Pyodide run is scripts/golden/evals/data-analysis.mjs.
 */
import { describe, it, expect, vi } from "vitest";
import { AnalystError, analyse, extractTable, matchesGolden, parseAnswer, sameAnswer, toNoteBlocks } from "../agents/analyst";
import { analystAgent } from "../agents/defs/analyst";
import type { PythonRunResult } from "../agents/python/runner";

const run = (stdout: string, over: Partial<PythonRunResult> = {}): PythonRunResult => ({ ok: true, stdout, stderr: "", result: null, error: null, timedOut: false, truncated: false, blocked: [], ms: 1, ...over });

describe("extractTable", () => {
  it("takes a ```csv block, a Markdown table, or comma-separated lines", () => {
    expect(extractTable("text\n\n```csv\na,b\n1,2\n```\n")).toBe("a,b\n1,2");
    expect(extractTable("| name | n |\n|---|---:|\n| x | 1 |\n| y, z | 2 |\n")).toBe('name,n\nx,1\n"y, z",2');
    expect(extractTable("intro\nmonth,sales\njan,3\nfeb,4\n\nend")).toBe("month,sales\njan,3\nfeb,4");
    expect(extractTable("no table here, really.")).toBeNull();
  });
});

describe("parseAnswer", () => {
  it("reads the last {\"answer\"} line, with an optional chart", () => {
    expect(parseAnswer(run('debug\n{"answer": 1141}\n'))).toEqual({ answer: 1141 });
    expect(parseAnswer(run('{"answer": "1855-01", "chart": {"labels": ["a", "b"], "values": [1, 2]}}'))).toEqual({ answer: "1855-01", chart: { labels: ["a", "b"], values: [1, 2] } });
    // A malformed chart is dropped, the answer kept.
    expect(parseAnswer(run('{"answer": 3, "chart": {"labels": ["a"], "values": [1, 2]}}'))).toEqual({ answer: 3 });
  });

  it("refuses a failed, timed-out or answer-less run", () => {
    expect(() => parseAnswer(run("", { ok: false, error: "ZeroDivisionError" }))).toThrow(/ZeroDivisionError/);
    expect(() => parseAnswer(run("", { ok: false, timedOut: true }))).toThrow(/timed out/);
    expect(() => parseAnswer(run("42\n"))).toThrow(AnalystError);
  });
});

describe("analyse: write, run twice, compare (6.15.1, 6.15.2)", () => {
  it("returns the answer when both runs agree", async () => {
    const r = await analyse("total?", "a\n1\n2", { writeCode: async () => "code", run: vi.fn(async () => run('{"answer": 3}')) });
    expect(r).toMatchObject({ answer: { answer: 3 }, verified: true, csv: "a\n1\n2", code: "code" });
  });

  it("runs the program twice, each time with the table as inputs.csv", async () => {
    const sandbox = vi.fn(async () => run('{"answer": 3}'));
    await analyse("q", "a\n1", { writeCode: async () => "code", run: sandbox });
    expect(sandbox).toHaveBeenCalledTimes(2);
    expect(sandbox.mock.calls.map((c) => (c as unknown[])[1])).toEqual([{ csv: "a\n1" }, { csv: "a\n1" }]);
  });

  it("gives no answer when the runs disagree (a clock or randomness)", async () => {
    let n = 0;
    await expect(analyse("q", "a\n1", { writeCode: async () => "code", run: async () => run(`{"answer": ${++n}}`) })).rejects.toMatchObject({ reason: "mismatch" });
  });

  it("compares numbers with a tiny relative tolerance and strings exactly", () => {
    expect(sameAnswer({ answer: 0.1 + 0.2 }, { answer: 0.3 })).toBe(true);
    expect(sameAnswer({ answer: 1 }, { answer: 1.001 })).toBe(false);
    expect(sameAnswer({ answer: "1855-01" }, { answer: "1855-01" })).toBe(true);
  });
});

describe("the note blocks (6.15.3)", () => {
  it("is a live-python block that re-runs the same program on the same table, and a chart", () => {
    const blocks = toNoteBlocks({ question: "max?", csv: 'a,b\n1,"x ""y"""', code: 'import json\nprint(json.dumps({"answer": 1}))', answer: { answer: 1, chart: { labels: ["a"], values: [1] } }, verified: true, ms: 1 });
    expect(blocks).toContain("**max?** → **1**");
    expect(blocks).toMatch(/```live-python\n# max\?\ninputs = \{"csv": "a,b\\n1,\\"x \\"\\"y\\"\\"\\""\}\nimport json/);
    const chart = /```chart\n([\s\S]*?)\n```/.exec(blocks)?.[1];
    expect(JSON.parse(chart!)).toMatchObject({ xAxis: { data: ["a"] }, series: [{ type: "bar", data: [1] }] });
  });
});

describe("the analyst agent's program validator", () => {
  const check = (code: string) => analystAgent.validators![0].check(code, { text: "" });
  it("requires inputs[\"csv\"] and a JSON answer, and refuses forbidden modules", async () => {
    expect(await check('import csv, io, json\nr = list(csv.DictReader(io.StringIO(inputs["csv"])))\nprint(json.dumps({"answer": len(r)}))')).toMatchObject({ ok: true });
    expect(await check('print(json.dumps({"answer": 1}))')).toMatchObject({ ok: false });
    expect(await check('x = inputs["csv"]\nprint(1)')).toMatchObject({ ok: false });
    expect(await check('import random\nx = inputs["csv"]\nprint(json.dumps({"answer": random.random()}))')).toMatchObject({ ok: false });
    expect(await check('import os\nx = inputs["csv"]\nprint(json.dumps({"answer": 1}))')).toMatchObject({ ok: false });
    expect(await check('import csv, json, random\nx = inputs["csv"]\nprint(json.dumps({"answer": 1}))')).toMatchObject({ ok: false });
    expect(await check('from os.path import join\nimport json\nx = inputs["csv"]\nprint(json.dumps({"answer": 1}))')).toMatchObject({ ok: false });
    expect(await check('import json\nx = inputs["csv"]\nprint(json.dumps({"answer": len(open("f").read())}))')).toMatchObject({ ok: false });
    // "time" inside a word or a datetime import is fine.
    expect(await check('import csv, io, json\nfrom datetime import datetime\nruntime = 1\nx = inputs["csv"]\nprint(json.dumps({"answer": runtime}))')).toMatchObject({ ok: true });
  });
});

describe("golden scoring (the data-analysis set's rule)", () => {
  it("exact for integers and YYYY-MM, |error| ≤ tolerance for decimals", () => {
    expect(matchesGolden(1141, 1141)).toBe(true);
    expect(matchesGolden("1,141", 1141)).toBe(true);
    expect(matchesGolden(1140, 1141)).toBe(false);
    expect(matchesGolden(25.32, 25.3, 0.05)).toBe(true);
    expect(matchesGolden(25.4, 25.3, 0.05)).toBe(false);
    expect(matchesGolden("1855-01", "1855-01")).toBe(true);
    expect(matchesGolden("1855-1", "1855-01")).toBe(false);
  });
});
