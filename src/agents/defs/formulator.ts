/**
 * formulator (plan 4.11). Writes a database formula from a
 * description in plain words ("days left until the due date"), for the
 * database view's formula box. Runs on the local executors like every
 * agent; the answer is checked by the formula parser itself — a formula
 * that does not parse, calls an unknown function or names a property the
 * database does not have goes back to the model with the parser's message.
 */

import type { AgentDefinition, AgentInput } from "../types";
import { registerAgent } from "../registry";
import { clip, fail, ok, stripFences } from "./shared";
import { BUILTIN_FUNCTIONS, parseFormula, type FormulaNode } from "../../views/formula";

export interface FormulatorInput extends AgentInput {
  /** What the formula should compute, in the user's words. */
  text: string;
  extra: {
    /** The database's properties, each with an example value when there is one. */
    fields: Array<{ name: string; example?: string }>;
  };
}

const FILE_MEMBERS = new Set(["name", "path", "folder"]);

/** The properties a formula reads (top-level names; the supported `file.*` members excluded). */
export function formulaFields(tree: FormulaNode): string[] {
  const out = new Set<string>();
  const walk = (n: FormulaNode) => {
    if (n.kind === "field") {
      // `file.name` / `file.path` / `file.folder` are the note's own; any other `file.x` is a property path (and must exist).
      if (!(n.path[0] === "file" && n.path.length === 2 && FILE_MEMBERS.has(n.path[1]))) out.add(n.path[0]);
    } else if (n.kind === "binary") {
      walk(n.left);
      walk(n.right);
    } else if (n.kind === "unary") walk(n.arg);
    else if (n.kind === "call") n.args.forEach(walk);
    else if (n.kind === "list") n.items.forEach(walk);
  };
  walk(tree);
  return [...out];
}

/** The model's answer → one formula line: fences, a `formula:` / `=` prefix and quotes around it removed. */
export function cleanFormula(text: string): string {
  const line =
    stripFences(text)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return line
    .replace(/^(?:formula|נוסחה)\s*:\s*/i, "")
    .replace(/^=\s*/, "")
    .replace(/^`(.*)`$/, "$1")
    .trim();
}

const SYNTAX =
  "Syntax: numbers, \"text\", true, false, null, [lists]; property names as bare words (any language), " +
  'or prop("name with spaces"); file.name, file.folder; operators + - * / % ^, & (join text), ' +
  "= != < <= > >=, and, or, not, parentheses. Dates: today(), date(\"YYYY-MM-DD\"), dateadd(d, n, \"days\"), " +
  'datediff(later, earlier, "days"), year/month/day(d); date - date gives days. Functions: ';

export const formulatorAgent: AgentDefinition<FormulatorInput, string> = registerAgent<FormulatorInput, string>({
  id: "formulator",
  // The answer is code: property names stay as they are, whatever the language.
  language: "any",
  description: "Write a database formula from a plain-language description",
  system:
    "You write ONE formula for a Lumen database column. Output ONLY the formula on a single line — no code " +
    "fences, no explanation, no leading =. Use only the listed properties and functions. " +
    SYNTAX +
    Object.keys(BUILTIN_FUNCTIONS).join(", ") +
    ".",
  user: (input) => {
    const fields = input.extra.fields
      .slice(0, 60)
      .map((f) => (f.example ? `- ${f.name} (e.g. ${clip(f.example, 40)})` : `- ${f.name}`))
      .join("\n");
    return `Properties:\n${fields || "(none)"}\n\nThe column should compute:\n${clip(input.text, 1000)}`;
  },
  parse: (text) => cleanFormula(text),
  validators: [
    {
      name: "formula",
      check: (formula, input) => {
        const p = parseFormula(formula);
        if (!p.ok) return fail(`the formula does not parse: ${p.error.message} (character ${p.error.at + 1})`, "Fix the formula so it parses; use only the listed functions.");
        const known = new Set((input as FormulatorInput).extra.fields.map((f) => f.name));
        const unknown = formulaFields(p.tree).filter((f) => !known.has(f));
        if (unknown.length) return fail(`unknown properties: ${unknown.join(", ")}`, `Use only these properties: ${[...known].join(", ")}.`);
        return ok;
      },
    },
  ],
  tier: "small",
  temperature: 0.1,
  maxTokens: 200,
  cache: true,
});
