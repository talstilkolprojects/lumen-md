/**
 * Skipped tests must say why, for which task, and until when (plan W4.12).
 *
 * A skipped test is coverage that looks present but checks nothing. Every
 * call that skips or defers a test in src/ (vitest) or e2e/ (Playwright) —
 * `test.skip`, `it.skip`, `describe.skip`, `*.skipIf`, `*.runIf`, `*.fixme`,
 * `*.todo`, also through `test.describe.*` — needs a structured comment on
 * its line or in the comment lines directly above it:
 *
 *   // skip-reason: <why it cannot run> | task: <plan id or #PR> | until: YYYY-MM-DD
 *
 * The date is when the skip is looked at again: a skip past it fails, and
 * so does a date more than MAX_HORIZON_DAYS ahead (no skip is forever).
 * e2e/ may hold at most MAX_E2E_SKIPS such calls: an engine gap shared by
 * many specs goes through one helper (e2e/_opfs.ts `vaultOrSkip`), not a
 * copy in every test.
 *
 * The check walks the TypeScript AST, so the words in strings and comments
 * do not count. Used by scripts/check-code-hygiene.mjs and
 * scripts/skip-report.mjs.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

export const MAX_E2E_SKIPS = 15;
export const MAX_HORIZON_DAYS = 366;

/** Test-API roots and the members that skip or defer a test. */
const ROOTS = new Set(["test", "it", "describe", "suite", "bench"]);
const SKIPPERS = new Set(["skip", "fixme", "todo", "skipIf", "runIf"]);

const ANNOTATION = /\/\/\s*skip-reason:\s*(.*)$/;
const TASK = /^(?:W?\d+(?:\.\d+)+|#\d+)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `test.describe.skip` → { root: "test", member: "skip" }; null for anything else. */
function skipCallee(expr) {
  if (!ts.isPropertyAccessExpression(expr)) return null;
  const member = expr.name.text;
  if (!SKIPPERS.has(member)) return null;
  let e = expr.expression;
  while (ts.isPropertyAccessExpression(e)) e = e.expression;
  if (!ts.isIdentifier(e) || !ROOTS.has(e.text)) return null;
  return { root: e.text, member };
}

/**
 * Parse `<why> | task: <id> | until: <date>`. Returns the fields and a list
 * of problems (empty when the annotation is complete and in date).
 */
export function parseAnnotation(body, today = new Date()) {
  const parts = body.split("|").map((p) => p.trim());
  const why = parts[0] ?? "";
  const field = (name) => parts.slice(1).find((p) => p.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? "";
  const task = field("task");
  const until = field("until");
  const problems = [];
  if (why.length < 10) problems.push("the reason is missing or shorter than 10 characters");
  if (!TASK.test(task)) problems.push(`no task (\`task: W4.12\`, \`task: 0.5\` or \`task: #431\`)${task ? `; got "${task}"` : ""}`);
  const m = DATE.exec(until);
  const date = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!date || date.toISOString().slice(0, 10) !== until) problems.push(`no review date (\`until: YYYY-MM-DD\`)${until ? `; got "${until}"` : ""}`);
  else {
    const day = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    if (date.getTime() < day) problems.push(`the review date ${until} has passed: fix the test, or re-justify it with a new date`);
    else if (date.getTime() - day > MAX_HORIZON_DAYS * 86_400_000) problems.push(`the review date ${until} is more than ${MAX_HORIZON_DAYS} days ahead`);
  }
  return { why, task, until, problems };
}

/** The `// skip-reason:` text for a call starting on `line` (1-based): same line, or the comment lines just above. */
function annotationFor(lines, line) {
  const same = ANNOTATION.exec(lines[line - 1] ?? "");
  if (same) return same[1];
  for (let i = line - 2; i >= 0 && i >= line - 6; i--) {
    const l = lines[i].trim();
    if (!l.startsWith("//")) break;
    const m = ANNOTATION.exec(l);
    if (m) {
      // A reason may continue on the following comment lines.
      const rest = [];
      for (let j = i + 1; j < line - 1; j++) rest.push(lines[j].trim().replace(/^\/\/\s?/, ""));
      return [m[1], ...rest].join(" ").trim();
    }
  }
  return null;
}

/**
 * Every skip/defer call in one file: { line, call, condition, annotation, problems }.
 * `problems` is empty for a call with a complete, in-date skip-reason.
 */
export function findSkips(file, text, today = new Date()) {
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const lines = text.split(/\r?\n/);
  const out = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const c = skipCallee(node.expression);
      if (c) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const annotation = annotationFor(lines, line);
        const problems = annotation === null ? ["no `// skip-reason: <why> | task: <id> | until: YYYY-MM-DD` comment"] : parseAnnotation(annotation, today).problems;
        const first = node.arguments[0];
        const condition = first && !ts.isStringLiteralLike(first) && !ts.isNoSubstitutionTemplateLiteral(first) ? first.getText(sf).replace(/\s+/g, " ") : "";
        out.push({ line, call: `${c.root}${node.expression.getText(sf).slice(c.root.length)}`, condition, annotation, problems });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** All .ts/.tsx files below `dir` (tests included), without node_modules. */
export function testSourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) testSourceFiles(full, out);
    else if (/\.[cm]?tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * The audit of a repo: every skip in src/ and e2e/, the violations, and the
 * e2e count against MAX_E2E_SKIPS.
 */
export function auditSkips(root, { today = new Date() } = {}) {
  const sites = [];
  for (const area of ["src", "e2e"]) {
    let files = [];
    try {
      files = testSourceFiles(join(root, area));
    } catch {
      continue; // no such directory in this checkout
    }
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (!/\b(skip|fixme|todo|skipIf|runIf)\b/.test(text)) continue;
      for (const s of findSkips(file, text, today)) sites.push({ area, file: relative(root, file).split("\\").join("/"), ...s });
    }
  }
  const violations = sites.filter((s) => s.problems.length).map((s) => ({ file: s.file, line: s.line, rule: "skip-reason", text: `${s.call}: ${s.problems.join("; ")}` }));
  const e2eCount = sites.filter((s) => s.area === "e2e").length;
  if (e2eCount > MAX_E2E_SKIPS)
    violations.push({ file: "e2e/", line: 0, rule: "skip-count", text: `${e2eCount} skip calls in e2e/, at most ${MAX_E2E_SKIPS}: fix a test or share one helper for an engine gap` });
  return { sites, violations, e2eCount };
}
