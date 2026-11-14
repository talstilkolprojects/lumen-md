/**
 * Data analyst (plan 6.15): a question about a table → Python → the sandbox
 * → the answer, a chart and a live block for the note.
 *
 *   6.15.1  The analyst agent writes a short Python program over the table
 *           (the CSV text arrives as `inputs["csv"]`); it runs in the
 *           run_python sandbox (6.14: Pyodide on this device, no network,
 *           no workspace). The program prints one JSON object
 *           {"answer": …, "chart": {labels, values}?}.
 *   6.15.2  The verifier runs the same program a second time in a fresh
 *           sandbox and compares: a different answer, an error or a time-out
 *           in either run → the answer is not given. (A program that reads a
 *           clock or randomness is caught here.)
 *   6.15.3  The result goes into the note as a ```live-python block that
 *           holds the table and the code, so the number can be re-run and
 *           checked, plus a ```chart block when the program made one.
 *
 * The agent itself is in ./defs/analyst.ts; this module is the pipeline
 * around it and is loaded only from the palette command.
 */

import "./analystStrings";
import type { PythonRunResult } from "./python/runner";

export interface AnalystAnswer {
  answer: number | string;
  chart?: { labels: Array<string | number>; values: number[]; title?: string };
}

export interface AnalystResult {
  question: string;
  /** The table the program ran on (CSV text). */
  csv: string;
  code: string;
  answer: AnalystAnswer;
  /** Both runs agreed (6.15.2). */
  verified: true;
  ms: number;
}

export class AnalystError extends Error {
  constructor(
    readonly reason: "noTable" | "run" | "parse" | "mismatch",
    message: string,
  ) {
    super(message);
    this.name = "AnalystError";
  }
}

/** The first CSV-like table in a note: a fenced ```csv block, a Markdown table, or plain comma-separated lines. */
export function extractTable(markdown: string): string | null {
  const fence = /^```(?:csv|tsv)?\s*\n([\s\S]*?)\n```/m.exec(markdown);
  if (fence && /,|\t/.test(fence[1].split("\n")[0] ?? "")) return fence[1].trim();
  const lines = markdown.split("\n");
  // Markdown table → CSV.
  for (let i = 0; i + 1 < lines.length; i++) {
    if (/^\s*\|.*\|\s*$/.test(lines[i]) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const rows: string[] = [];
      for (let j = i; j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]); j++) {
        if (j === i + 1) continue;
        const cells = lines[j].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        rows.push(cells.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","));
      }
      if (rows.length >= 2) return rows.join("\n");
    }
  }
  // Two or more consecutive lines with the same number (≥ 2) of commas.
  for (let i = 0; i + 1 < lines.length; i++) {
    const n = (lines[i].match(/,/g) ?? []).length;
    if (n < 1) continue;
    let j = i;
    while (j < lines.length && (lines[j].match(/,/g) ?? []).length === n) j++;
    if (j - i >= 2) return lines.slice(i, j).join("\n").trim();
  }
  return null;
}

/** The program's answer: the last line of stdout that is a JSON object with "answer". */
export function parseAnswer(run: PythonRunResult): AnalystAnswer {
  if (!run.ok) throw new AnalystError("run", run.timedOut ? "the program timed out" : (run.error ?? "the program failed"));
  const lines = run.stdout.trim().split("\n").reverse();
  for (const l of lines) {
    const s = l.trim();
    if (!s.startsWith("{")) continue;
    try {
      const v = JSON.parse(s) as Partial<AnalystAnswer>;
      if (v && (typeof v.answer === "number" || typeof v.answer === "string")) {
        const out: AnalystAnswer = { answer: v.answer };
        const c = v.chart;
        if (c && Array.isArray(c.labels) && Array.isArray(c.values) && c.labels.length === c.values.length && c.values.every((x) => typeof x === "number" && Number.isFinite(x))) {
          out.chart = { labels: c.labels, values: c.values, ...(typeof c.title === "string" ? { title: c.title } : {}) };
        }
        return out;
      }
    } catch {
      /* why: not this line */
    }
  }
  throw new AnalystError("parse", 'the program printed no {"answer": …} line');
}

/** Two answers are the same: equal strings, or numbers within a relative 1e-9. */
export function sameAnswer(a: AnalystAnswer, b: AnalystAnswer): boolean {
  if (typeof a.answer === "number" && typeof b.answer === "number") {
    return Math.abs(a.answer - b.answer) <= 1e-9 * Math.max(1, Math.abs(a.answer), Math.abs(b.answer));
  }
  return String(a.answer) === String(b.answer);
}

export interface AnalystDeps {
  /** The agent: question + table → Python code. */
  writeCode: (question: string, csv: string, signal?: AbortSignal) => Promise<string>;
  /** The run_python sandbox (a fresh one per call). */
  run: (code: string, inputs: Record<string, unknown>, signal?: AbortSignal) => Promise<PythonRunResult>;
  signal?: AbortSignal;
}

/** 6.15.1 + 6.15.2: write, run, run again, compare. */
export async function analyse(question: string, csv: string, deps: AnalystDeps): Promise<AnalystResult> {
  const t0 = Date.now();
  const code = await deps.writeCode(question, csv, deps.signal);
  const inputs = { csv };
  const first = parseAnswer(await deps.run(code, inputs, deps.signal));
  const second = parseAnswer(await deps.run(code, inputs, deps.signal));
  if (!sameAnswer(first, second)) throw new AnalystError("mismatch", `the two runs disagree (${String(first.answer)} vs ${String(second.answer)})`);
  return { question, csv, code, answer: first, verified: true, ms: Date.now() - t0 };
}

/** Python string literal for any text (triple quotes are not safe for arbitrary CSV). */
const pyString = (s: string) => JSON.stringify(s);

/**
 * 6.15.3: the note blocks. The live-python block defines `inputs` with the
 * table, so it re-runs exactly what the analyst ran; the chart block is an
 * ECharts bar chart of the program's chart data.
 */
export function toNoteBlocks(r: AnalystResult): string {
  const live = ["```live-python", `# ${r.question.replace(/\n/g, " ")}`, `inputs = {"csv": ${pyString(r.csv)}}`, r.code.trim(), "```"].join("\n");
  const parts = [`> **${r.question.trim()}** → **${String(r.answer.answer)}** (verified by two runs)`, "", live];
  if (r.answer.chart) {
    const c = r.answer.chart;
    const option = { title: { text: c.title ?? r.question.slice(0, 60) }, xAxis: { type: "category", data: c.labels }, yAxis: { type: "value" }, series: [{ type: "bar", data: c.values }] };
    parts.push("", "```chart", JSON.stringify(option, null, 2), "```");
  }
  return parts.join("\n");
}

/** Numeric / exact scoring against a golden answer (the data-analysis set's rule). */
export function matchesGolden(got: number | string, want: number | string, tolerance?: number): boolean {
  if (typeof want === "number") {
    const n = typeof got === "number" ? got : Number(String(got).replace(/[,%\s]/g, ""));
    if (!Number.isFinite(n)) return false;
    return tolerance !== undefined ? Math.abs(n - want) <= tolerance + 1e-9 : n === want;
  }
  return String(got).trim() === want;
}

/** The palette command's pipeline: the note's first table, the agent, two sandbox runs, the blocks. */
export async function analyseNote(markdown: string, question: string, signal?: AbortSignal): Promise<{ result: AnalystResult; blocks: string }> {
  const csv = extractTable(markdown);
  if (!csv) throw new AnalystError("noTable", "no table in this note (a ```csv block, a Markdown table or comma-separated lines)");
  const [{ runAgentOrThrow }, { analystAgent }, { runPython }, { DEFAULT_PYTHON_TIMEOUT_MS }] = await Promise.all([
    import("./runtime"),
    import("./defs/analyst"),
    import("./python/runner"),
    import("./python/limits"),
  ]);
  const result = await analyse(question, csv, {
    writeCode: (q, table, s) => runAgentOrThrow(analystAgent, { text: table, extra: { question: q } }, { document: markdown, signal: s }),
    run: (code, inputs, s) => runPython({ code, inputsJson: JSON.stringify(inputs), timeoutMs: DEFAULT_PYTHON_TIMEOUT_MS, signal: s }),
    signal,
  });
  return { result, blocks: toNoteBlocks(result) };
}
