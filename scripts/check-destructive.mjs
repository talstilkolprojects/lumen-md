#!/usr/bin/env node
/**
 * Destructive actions gate (plan W3.2): everything that deletes or
 * replaces what a person made can be undone, or asks first.
 *
 * Walks the TypeScript AST of the UI and command code and finds every call
 * to an API that destroys user data (DESTRUCTIVE below). The function that
 * makes the call — or one that encloses it — must either ask (uiConfirm)
 * or offer an undo (an undo*() helper, or a toast action labelled with an
 * "undo" key). A command (an object with `id:` and `action:`) whose action
 * does this also declares `destructive: "confirm" | "undo"`, matching what
 * it does, so the palette and its test know.
 *
 * A real exception gets `destructive-allow: <reason>` on the line or the
 * line above (automatic clean-up the person set up, for instance).
 *
 *   node scripts/check-destructive.mjs           # report, exit 1 on any finding
 *   node scripts/check-destructive.mjs --json    # { actions, findings }
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
/** Where people act: panels, commands, hooks, blocks, the editor. */
const SCAN = ["ui", "commands", "hooks", "plugins", "editor", "views", "App.tsx"];

/** APIs that delete or replace user data (not caches that rebuild themselves). */
export const DESTRUCTIVE = new Set([
  "deleteWorkspaceFile",
  "moveToTrash",
  "trashPaths",
  "emptyTrash",
  "deleteComment",
  "untrustKey",
  "clearStyleProfile",
  "clearLedger",
  "clearTrace",
  "clearHistory",
  "clearSearchHistory",
  "clearAiPromptHistory",
  "clearAllLumenLocalStorage",
  "clearLumenState",
  "removeSecret",
  "resetCollabKey",
  "deleteWebLlmModel",
  "removeHebrewDictionary",
  "pullRepo",
  "applyLinkFixes",
  "clearUsage",
]);

const CONFIRM = /\b(uiConfirm|window\.confirm)\s*\(/;
const UNDO = /\bundo[A-Z]\w*\s*\(|action:\s*\{\s*label:\s*t\("[^"]*\.undo\w*"/;
const ALLOW = /destructive-allow:\s*\S+/;

function walk(entry, out = []) {
  const full = join(SRC, entry);
  if (statSync(full).isDirectory()) {
    for (const name of readdirSync(full)) {
      if (name === "__tests__") continue;
      const sub = join(entry, name);
      if (statSync(join(SRC, sub)).isDirectory()) walk(sub, out);
      else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$|\.d\.ts$/.test(name)) out.push(join(SRC, sub));
    }
  } else out.push(full);
  return out;
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/** { actions: [{ line, api, how, command? }], findings: [{ line, api, problem, command? }] } */
export function scan(fileName, text) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = text.split(/\r?\n/);
  const actions = [];
  const findings = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const api = calleeName(node.expression);
      if (api && DESTRUCTIVE.has(api)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        let how = null;
        let command = null;
        let declared = null;
        if (ALLOW.test(lines[line] ?? "") || ALLOW.test(lines[line - 1] ?? "")) how = "allowed";
        for (let p = node.parent; p; p = p.parent) {
          if (!how && ts.isFunctionLike(p)) {
            const body = p.getText(sf);
            if (CONFIRM.test(body)) how = "confirm";
            else if (UNDO.test(body)) how = "undo";
          }
          // The command object this call belongs to.
          if (!command && ts.isObjectLiteralExpression(p)) {
            const prop = (n) => p.properties.find((x) => ts.isPropertyAssignment(x) && x.name.getText(sf) === n);
            const id = prop("id");
            if (id && prop("action") && ts.isStringLiteral(id.initializer)) {
              command = id.initializer.text;
              const d = prop("destructive");
              declared = d && ts.isStringLiteral(d.initializer) ? d.initializer.text : null;
            }
          }
        }
        actions.push({ line: line + 1, api, how, ...(command ? { command, declared } : {}) });
        if (!how) findings.push({ line: line + 1, api, problem: "neither asks nor offers an undo", ...(command ? { command } : {}) });
        else if (command && how !== "allowed" && declared !== how) findings.push({ line: line + 1, api, command, problem: `the command must declare destructive: "${how}"` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { actions, findings };
}

export function scanAll() {
  const actions = [];
  const findings = [];
  for (const entry of SCAN) {
    for (const f of walk(entry)) {
      const r = scan(f, readFileSync(f, "utf8"));
      const file = relative(ROOT, f);
      for (const a of r.actions) actions.push({ file, ...a });
      for (const v of r.findings) findings.push({ file, ...v });
    }
  }
  return { actions, findings };
}

function main() {
  const { actions, findings } = scanAll();
  if (process.argv.includes("--json")) process.stdout.write(JSON.stringify({ actions, findings }, null, 2) + "\n");
  else for (const v of findings) console.error(`${v.file}:${v.line}  ${v.api}${v.command ? ` (${v.command})` : ""}  — ${v.problem}`);
  if (findings.length) {
    console.error(`\n✖ ${findings.length} destructive action(s) without a confirmation or an undo.`);
    process.exit(1);
  }
  console.error(`✓ destructive actions: ${actions.length}, each asks first or can be undone.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
