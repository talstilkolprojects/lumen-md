#!/usr/bin/env node
/**
 * Raw error messages gate (plan W3.2): a caught error's own text — its
 * `.message`, `.stack`, `String(e)` or the error itself — never reaches the
 * screen. It goes through `explainError(e)` (src/lib/userError.ts), which
 * logs the raw text and shows one sentence the person can act on.
 *
 * Walks the TypeScript AST of src/ and fails when a value caught by
 * `catch (e)` or `.catch((e) => …)` is used, other than through
 * explainError / errorKind / isCancel, inside:
 *
 *   ui-call     t(), tPlural(), a toast or dialog (showAiToast, toast.error, uiAlert, …)
 *   ui-state    a state setter for something shown (setError, setStatus, setMessage, …)
 *   jsx         a JSX child or a user-visible prop
 *
 * A real exception (the text is a log line, or the error is the user's own
 * code's, as in a code runner) gets `raw-error-allow: <reason>` on the line
 * or the line above.
 *
 *   node scripts/check-raw-errors.mjs           # report, exit 1 on any finding
 *   node scripts/check-raw-errors.mjs --json
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { UI_SINKS, VISIBLE_PROPS } from "./check-i18n-hardcoded.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const SKIP_DIRS = new Set(["__tests__", "node_modules", "build", "cli"]);
const SKIP_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;

/** Calls whose arguments are shown: translation, toasts, dialogs. */
const SHOWN_CALLS = new Set([...UI_SINKS, "t", "tPlural", "tRich"]);
/** `toast.error(…)`, `toast.warn(…)`… */
const TOAST_OBJECTS = new Set(["toast"]);
/** A state setter for shown text. */
const SETTER = /^set\w*(Error|Err|Status|Message|Msg|Problem|Failure|Notice|Warning|Result|Progress)$/;
/** Ways to use a caught error that are fine anywhere. */
const SAFE_CALLS = new Set(["explainError", "errorKind", "isCancel"]);
const ALLOW = /raw-error-allow:\s*\S+/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out);
    } else if (/\.tsx?$/.test(name) && !SKIP_FILE.test(name)) out.push(full);
  }
  return out;
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    if (ts.isIdentifier(expr.expression) && ["window", "globalThis"].includes(expr.expression.text)) return expr.name.text;
    if (ts.isIdentifier(expr.expression) && TOAST_OBJECTS.has(expr.expression.text)) return "toast";
  }
  return null;
}

/** Findings for one source text: { line, rule, text }. */
export function scan(fileName, text) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = text.split(/\r?\n/);
  const out = [];
  const seen = new Set();
  const report = (node, rule) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    if (ALLOW.test(lines[line] ?? "") || (line > 0 && ALLOW.test(lines[line - 1]))) return;
    const key = `${line}:${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ line: line + 1, rule, text: node.getText(sf).replace(/\s+/g, " ").slice(0, 100) });
  };

  /** Does `node` use one of `caught` other than through a safe call? */
  const usesCaught = (node, caught) => {
    let hit = false;
    const look = (n) => {
      if (hit) return;
      // explainError(e), predicates (isQuotaError(e)) and translators (describeAuthError(e)) read the error without showing it.
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (SAFE_CALLS.has(n.expression.text) || /^(is|describe)[A-Z]/.test(n.expression.text))) return;
      // A nested function is its own story (it is checked where it is called).
      if (ts.isIdentifier(n) && caught.has(n.text)) {
        const p = n.parent;
        // `e.name === "AbortError"`, `e instanceof X` as a condition: reading, not showing.
        if (ts.isPropertyAccessExpression(p) && p.expression === n && p.name.text !== "message" && p.name.text !== "stack" && p.name.text !== "toString") return;
        if (ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) return;
        hit = true;
        return;
      }
      ts.forEachChild(n, look);
    };
    look(node);
    return hit;
  };

  const visit = (node, caught) => {
    let inner = caught;
    if (ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) {
      inner = new Set([...caught, node.variableDeclaration.name.text]);
      ts.forEachChild(node.block, (c) => visit(c, inner));
      return;
    }
    // promise.catch((e) => …)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "catch") {
      const fn = node.arguments[0];
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.parameters[0] && ts.isIdentifier(fn.parameters[0].name)) {
        visit(node.expression.expression, caught);
        const names = new Set([...caught, fn.parameters[0].name.text]);
        visit(fn.body, names);
        return;
      }
    }
    if (caught.size) {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node.expression);
        const shown = (name && (SHOWN_CALLS.has(name) || name === "toast")) || (name && SETTER.test(name));
        if (shown && node.arguments.some((a) => usesCaught(a, caught))) report(node, name && SETTER.test(name) ? "ui-state" : "ui-call");
      } else if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
        if (usesCaught(node.expression, caught)) report(node, "jsx");
      } else if (ts.isJsxAttribute(node) && VISIBLE_PROPS.has(node.name.getText(sf)) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        if (usesCaught(node.initializer.expression, caught)) report(node, "jsx");
      }
    }
    ts.forEachChild(node, (c) => visit(c, inner));
  };
  visit(sf, new Set());
  return out;
}

function main() {
  const files = walk(SRC);
  const findings = [];
  for (const f of files) for (const v of scan(f, readFileSync(f, "utf8"))) findings.push({ file: relative(ROOT, f), ...v });
  if (process.argv.includes("--json")) process.stdout.write(JSON.stringify(findings, null, 2) + "\n");
  else for (const v of findings) console.error(`${v.file}:${v.line}  [${v.rule}]  ${v.text}`);
  if (findings.length) {
    console.error(`\n✖ ${findings.length} raw error message(s) reach the screen. Show explainError(e) (src/lib/userError.ts) instead, or mark a real exception with \`raw-error-allow: <reason>\`.`);
    process.exit(1);
  }
  console.error(`✓ no raw error messages in ${files.length} files.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
