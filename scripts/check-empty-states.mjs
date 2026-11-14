#!/usr/bin/env node
/**
 * Empty states gate (plan W3.2): every empty state shows one action. An
 * empty-state string — a key ending in .empty, .emptyHint, .none,
 * .noMatches, .noVersions, .noNotes, .emptyRoom — rendered in JSX must be
 * the `message` of an <EmptyState> (src/ui/EmptyState.tsx), whose `action`
 * is required.
 *
 * Two marks stand in for it, on the line or the two lines above:
 *   empty-action: <where>   the action is a control right next to it (named)
 *   empty-allow: <reason>   the string is not an empty state (a cell value, a diff side)
 *
 *   node scripts/check-empty-states.mjs           # report, exit 1 on any finding
 *   node scripts/check-empty-states.mjs --json    # { states, findings }
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const SKIP_DIRS = new Set(["__tests__", "node_modules", "build", "cli"]);

export const EMPTY_KEY = /\.(empty|emptyHint|none|noMatches|noVersions|noNotes|emptyRoom)$/;
const MARK = /empty-(action|allow):\s*\S+/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out);
    } else if (/\.tsx$/.test(name) && !/\.(test|spec)\.tsx$/.test(name)) out.push(full);
  }
  return out;
}

const tagName = (el) => el.tagName.getText();

/** { states: [{ line, key, how }], findings: [{ line, key }] } for one .tsx source. */
export function scan(fileName, text) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = text.split(/\r?\n/);
  const states = [];
  const findings = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t" && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && EMPTY_KEY.test(node.arguments[0].text)) {
      const key = node.arguments[0].text;
      let inJsx = false;
      let how = null;
      for (let p = node.parent; p; p = p.parent) {
        if (ts.isJsxExpression(p) || ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p)) inJsx = true;
        if (ts.isJsxAttribute(p) && p.name.getText(sf) === "message") {
          const el = p.parent.parent; // JsxAttributes → element
          if ((ts.isJsxSelfClosingElement(el) || ts.isJsxOpeningElement(el)) && tagName(el) === "EmptyState") how = "EmptyState";
        }
        if (ts.isFunctionLike(p)) break;
      }
      if (inJsx) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        if (!how) {
          for (const l of [line, line - 1, line - 2]) {
            const m = MARK.exec(lines[l] ?? "");
            if (m) {
              how = `empty-${m[1]}`;
              break;
            }
          }
        }
        states.push({ line: line + 1, key, how });
        if (!how) findings.push({ line: line + 1, key });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { states, findings };
}

function main() {
  const files = walk(SRC);
  const states = [];
  const findings = [];
  for (const f of files) {
    const r = scan(f, readFileSync(f, "utf8"));
    for (const s of r.states) states.push({ file: relative(ROOT, f), ...s });
    for (const v of r.findings) findings.push({ file: relative(ROOT, f), ...v });
  }
  if (process.argv.includes("--json")) process.stdout.write(JSON.stringify({ states, findings }, null, 2) + "\n");
  else for (const v of findings) console.error(`${v.file}:${v.line}  ${v.key}  — an empty state without an action`);
  if (findings.length) {
    console.error(`\n✖ ${findings.length} of ${states.length} empty states have no action. Render them with <EmptyState message action> (src/ui/EmptyState.tsx).`);
    process.exit(1);
  }
  const withAction = states.filter((s) => s.how === "EmptyState" || s.how === "empty-action").length;
  console.error(`✓ empty states: ${withAction} with an action (${states.length - withAction} marked not an empty state), in ${files.length} files.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
