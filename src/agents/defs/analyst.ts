/**
 * analyst — `ai.analyse` (plan 6.15). A question about a table → a short
 * Python 3 program (standard library only) that answers it. The program is
 * run in the run_python sandbox by ../analyst.ts, twice; this agent only
 * writes it. Not in ./index.ts: it is registered when the command loads it.
 */

import type { AgentDefinition, AgentInput } from "../types";
import { registerAgent } from "../registry";
import { clip, fail, ok, stripFences } from "./shared";

export interface AnalystInput extends AgentInput {
  text: string;
  extra: { question: string };
}

/** How the program reads the table, and what it must print. */
export const ANALYST_CONTRACT =
  'The table is the string inputs["csv"] (CSV with a header row). Use only the standard library (csv, io, statistics, math, datetime, json). ' +
  'Print exactly one line at the end: json.dumps({"answer": <number or string>}) — optionally with "chart": {"labels": [...], "values": [...], "title": "..."} ' +
  "when a chart helps. Round only when the question says so. No randomness, no clock, no network, no files.";

const BANNED_MODULES = new Set(["os", "sys", "subprocess", "socket", "urllib", "http", "requests", "random", "time", "secrets", "shutil", "pathlib", "ctypes", "js", "pyodide", "micropip"]);
const BANNED_CALLS = /\b(?:open|eval|exec|compile|__import__)\s*\(/;

/** The modules a program imports: `import a, b as c` and `from a.b import x`, top-level names. */
export function importedModules(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/^\s*import\s+([^\n#]+)/gm)) for (const part of m[1].split(",")) out.push(part.trim().split(/\s+/)[0].split(".")[0]);
  for (const m of code.matchAll(/^\s*from\s+([\w.]+)\s+import\b/gm)) out.push(m[1].split(".")[0]);
  return out.filter(Boolean);
}

const usesBanned = (code: string) => importedModules(code).some((m) => BANNED_MODULES.has(m)) || BANNED_CALLS.test(code);

export const analystAgent: AgentDefinition<AnalystInput, string> = registerAgent<AnalystInput, string>({
  id: "analyst",
  language: "any",
  commandId: "ai.analyse",
  description: "Answer a question about a table with a short Python program",
  system:
    "You are a data analyst. Write a short Python 3 program that answers the user's question about the table exactly. " +
    ANALYST_CONTRACT +
    " Output ONLY the program, no explanation, no Markdown fences.",
  user: (input) => `Question: ${input.extra.question}\n\nThe first lines of inputs["csv"]:\n${clip(input.text.split("\n").slice(0, 12).join("\n"), 3000)}`,
  parse: (text) => stripFences(text).trim(),
  validators: [
    {
      name: "analyst-program",
      check: (code) => {
        if (!/inputs\s*\[\s*["']csv["']\s*\]/.test(code)) return fail("the program does not read inputs[\"csv\"]", 'Read the table from inputs["csv"].');
        if (!/json\.dumps\s*\(/.test(code) || !/["']answer["']/.test(code)) return fail("the program does not print the answer as JSON", 'End with print(json.dumps({"answer": ...})).');
        if (usesBanned(code)) return fail("the program uses a forbidden module or call", "Standard library only: csv, io, statistics, math, datetime, json.");
        return ok;
      },
    },
  ],
  tier: "small",
  temperature: 0,
  maxTokens: 1200,
  cache: true,
});
