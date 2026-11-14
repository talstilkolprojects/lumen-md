#!/usr/bin/env node
/**
 * Code-hygiene gate for production sources.
 *
 * Fails (exit 1) when any production file under `src/` contains:
 *   - an `as any` cast
 *   - a `console.log(...)` call
 *   - a direct file-system handle call (`navigator.storage.getDirectory()`,
 *     `getDirectoryHandle`, `getFileHandle`, `createWritable`,
 *     `createSyncAccessHandle`, `removeEntry`) outside the vault layer —
 *     plan 4.1: every reader and writer of vault files goes through the
 *     VaultBackend in src/storage/vault/. Also caught inside string and
 *     template literals (worker sources). The only exceptions are the files
 *     in DIRECT_FS_ALLOWLIST below, each with its reason; an entry whose
 *     file no longer makes such a call fails the check too, so the list
 *     stays exact.
 *
 * Production = `src/**\/*.{ts,tsx}` excluding `__tests__/` directories,
 * `*.test.*` / `*.spec.*` files and `*.d.ts` declarations.
 *
 * The check walks the TypeScript AST (not a regex), so occurrences inside
 * string literals, template literals (e.g. worker source strings or editor
 * snippets) and comments are ignored by the first two rules.
 *
 * Intentional exceptions to the first two rules: put
 * `// hygiene-allow: <justification>` on the offending line or the line
 * directly above it. A justification is required. (Not for direct
 * file-system calls: those go in DIRECT_FS_ALLOWLIST.)
 *
 * Usage: node scripts/check-code-hygiene.mjs   (or `npm run hygiene`)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const ALLOW_RE = /\/\/\s*hygiene-allow:\s*\S+/;

/**
 * The only production files allowed to call file-system handles directly
 * (repo-relative path → why). Everything else uses the vault layer
 * (src/storage/workspace.ts wrappers or src/storage/vault).
 */
export const DIRECT_FS_ALLOWLIST = {
  "src/storage/vault/handleBackend.ts": "the vault implementation: walks a FileSystemDirectoryHandle (the OPFS root, or a folder the user picked)",
  "src/storage/vault/opfs.ts": "the OPFS backend: opens the OPFS root with navigator.storage.getDirectory()",
  "src/storage/vault/opfsSyncWrite.ts": "the OPFS backend's WebKit write fallback: a worker writing through a sync access handle",
  "src/storage/fs.ts": "Open / Save / Save As of a single file the user picked (showOpenFilePicker / showSaveFilePicker): a real file outside the vault, not OPFS",
  "src/storage/exportDocx.ts": "writes an exported .docx to the location the user picked in the save dialog: not OPFS, not the vault",
};

/** Handle methods that read or change a file system directly. */
const DIRECT_FS_METHODS = new Set(["getDirectoryHandle", "getFileHandle", "createWritable", "createSyncAccessHandle", "removeEntry"]);
/** The same calls written inside a string or template literal (a worker's source). */
const DIRECT_FS_IN_TEXT = /\b(?:storage\s*\??\.\s*getDirectory|getDirectoryHandle|getFileHandle|createWritable|createSyncAccessHandle|removeEntry)\s*\(/;

/** `navigator.storage.getDirectory()`, `storage?.getDirectory()`, … */
function isStorageGetDirectory(callee) {
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "getDirectory") return false;
  const recv = callee.expression;
  return (ts.isIdentifier(recv) && recv.text === "storage") || (ts.isPropertyAccessExpression(recv) && recv.name.text === "storage");
}

function isDirectFsCall(node) {
  const callee = node.expression;
  if (isStorageGetDirectory(callee)) return true;
  if (ts.isPropertyAccessExpression(callee)) return DIRECT_FS_METHODS.has(callee.name.text);
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    return DIRECT_FS_METHODS.has(callee.argumentExpression.text);
  }
  return false;
}

function isProductionFile(path) {
  if (!/\.(ts|tsx)$/.test(path)) return false;
  if (/\.d\.ts$/.test(path)) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return false;
  if (/(^|[\\/])__tests__([\\/]|$)/.test(path)) return false;
  return true;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(full, out);
    } else if (isProductionFile(full)) {
      out.push(full);
    }
  }
  return out;
}

/** Returns a list of `{ line, rule, text }` violations for one source text. */
export function findViolations(fileName, text) {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines = text.split(/\r?\n/);
  const out = [];
  const report = (node, rule) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const here = lines[line] ?? "";
    const above = line > 0 ? lines[line - 1] : "";
    if (rule !== "direct-fs" && (ALLOW_RE.test(here) || ALLOW_RE.test(above))) return;
    out.push({ line: line + 1, rule, text: here.trim() });
  };
  const visit = (node) => {
    if (ts.isAsExpression(node) && node.type.kind === ts.SyntaxKind.AnyKeyword) {
      report(node, "as-any");
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "console" &&
      node.expression.name.text === "log"
    ) {
      report(node, "console-log");
    }
    if (ts.isCallExpression(node) && isDirectFsCall(node)) {
      report(node, "direct-fs");
    } else if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      DIRECT_FS_IN_TEXT.test(node.text)
    ) {
      report(node, "direct-fs");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Repo-relative, forward slashes (the DIRECT_FS_ALLOWLIST key). */
const relKey = (file) => relative(root, file).split("\\").join("/");

/** Cheap pre-filter: a file without any of these words cannot break the direct-fs rule. */
const DIRECT_FS_WORDS = /getDirectory|getFileHandle|createWritable|createSyncAccessHandle|removeEntry/;

/**
 * Violations in `files`, with direct file-system calls in allowlisted files
 * dropped; `stale` lists allowlist entries whose file makes no such call
 * (or is not among `files`). `onlyDirectFs` checks just that rule (and
 * parses only files that mention a handle method) — for the unit test.
 */
export function checkFiles(files, { onlyDirectFs = false } = {}) {
  const violations = [];
  const used = new Set();
  for (const file of files) {
    const key = relKey(file);
    const text = readFileSync(file, "utf8");
    if (onlyDirectFs && !DIRECT_FS_WORDS.test(text)) continue;
    for (const v of findViolations(file, text)) {
      if (onlyDirectFs && v.rule !== "direct-fs") continue;
      if (v.rule === "direct-fs" && Object.hasOwn(DIRECT_FS_ALLOWLIST, key)) {
        used.add(key);
        continue;
      }
      violations.push({ file: key, ...v });
    }
  }
  const stale = Object.keys(DIRECT_FS_ALLOWLIST).filter((k) => !used.has(k));
  return { violations, stale };
}

/** Production files under src/ (so a test can run the check on the real tree). */
export function productionFiles() {
  return walk(srcDir);
}

function main() {
  const files = walk(srcDir);
  const { violations, stale } = checkFiles(files);
  for (const v of violations) console.error(`${v.file}:${v.line}  [${v.rule}]  ${v.text}`);
  for (const k of stale) {
    console.error(`${k}  [direct-fs-allowlist]  listed in DIRECT_FS_ALLOWLIST but makes no direct file-system call: remove the entry`);
  }
  if (violations.length > 0 || stale.length > 0) {
    console.error(
      `\n✖ code hygiene: ${violations.length + stale.length} violation(s). Replace \`as any\` with a real type and ` +
        "`console.log` with `log` from src/lib/logger, or add `// hygiene-allow: <reason>`. " +
        "Read and write vault files through src/storage/workspace.ts / src/storage/vault, not file-system handles.",
    );
    process.exit(1);
  }
  console.error(
    `✓ code hygiene: ${files.length} production files clean (no \`as any\`, no console.log, ` +
      `no direct file-system calls outside the vault layer and ${Object.keys(DIRECT_FS_ALLOWLIST).length} allowlisted files).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
