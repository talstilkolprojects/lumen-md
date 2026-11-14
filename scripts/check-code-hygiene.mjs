#!/usr/bin/env node
/**
 * Code-hygiene gate for production sources.
 *
 * Fails (exit 1) when any production file under `src/` contains:
 *   - an `as any` cast
 *   - a `console.log(...)` call
 *   - a read of a `VITE_*` variable named like a secret (TOKEN / SECRET /
 *     KEY, apart from the public names in PUBLIC_VITE_NAMES): every `VITE_*`
 *     value ships in the bundle, so a secret is a user-entered setting in
 *     the secret store instead
 *   - `import.meta.env` read as a whole object (`const env = import.meta.env`,
 *     `env[key]`): Vite then inlines every `VITE_*` value of the build; read
 *     one name at a time (src/lib/publicEnv.ts)
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
 * Skipped tests (plan W4.12): every `test.skip` / `it.skipIf` / `*.todo` /
 * `*.fixme` in src/ and e2e/ needs `// skip-reason: <why> | task: <id> |
 * until: YYYY-MM-DD`, in date, and e2e/ holds at most MAX_E2E_SKIPS of them
 * (scripts/lib/skipAudit.mjs; `npm run skips` lists them).
 *
 * It also fails when an e2e file (`e2e/**\/*.ts`) calls `waitForTimeout`:
 * a fixed sleep is either too short on a slow runner (a flake) or longer
 * than needed everywhere. Wait for the condition instead (plan 0.5).
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
 * CSS (plan 9.3): in `src/**\/*.css`, rules for the preview (`.prose-lumen`)
 * and the editor (`.cm-*`) must use logical properties — `margin-inline-start`,
 * `padding-inline-end`, `border-inline-start`, `inset-inline-start`,
 * `text-align: start` — so Hebrew and Arabic notes lay out mirrored. A
 * physical one (`margin-left`, `right:`, `text-align: left`, `float: right`…)
 * fails unless a `/* hygiene-allow: <justification> *\/` comment sits on its
 * line or the line above.
 *
 * The taken domain (plan W4.3, audit W10.C30): the domain the project never
 * names must appear nowhere in the tree — index.html, public/, docs/,
 * README and every other text file (scripts/lib/takenDomain.mjs), so an
 * old mention on a branch fails as well as a new one. The PR gate checks
 * only the lines a PR adds.
 *
 * Usage: node scripts/check-code-hygiene.mjs   (or `npm run hygiene`)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import postcss from "postcss";
import { auditSkips, MAX_E2E_SKIPS } from "./lib/skipAudit.mjs";
import { domainInTree } from "./lib/takenDomain.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const e2eDir = join(root, "e2e");
const ALLOW_RE = /\/\/\s*hygiene-allow:\s*\S+/;

/** `VITE_*` names that look secret but are public by design (shipped to every browser anyway). */
export const PUBLIC_VITE_NAMES = new Set([
  "VITE_SUPABASE_ANON_KEY", // Supabase anon key: public, row-level security does the gating
  "VITE_DROPBOX_APP_KEY", // OAuth app key (PKCE, no secret)
  "VITE_PLUGIN_TRUSTED_KEYS", // public signing keys
]);
export const SECRET_VITE_NAME = /^VITE_[A-Z0-9_]*(TOKEN|SECRET|KEY)[A-Z0-9_]*$/;

const isSecretViteName = (name) => SECRET_VITE_NAME.test(name) && !PUBLIC_VITE_NAMES.has(name);

/** `import.meta.env`, through parentheses and type assertions on `import.meta`. */
function isImportMetaEnv(node) {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "env") return false;
  let e = node.expression;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression?.(e)) e = e.expression;
  return ts.isMetaProperty(e) && e.keywordToken === ts.SyntaxKind.ImportKeyword && e.name.text === "meta";
}

/** The node a value flows into, skipping parentheses and type-only wrappers. */
function outerOf(node) {
  let n = node;
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isAsExpression(n.parent) || ts.isNonNullExpression(n.parent) || ts.isSatisfiesExpression?.(n.parent))) n = n.parent;
  return n;
}

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
  // Self-converted model weights (plan 6.0) live in OPFS `models/`, beside the vault, not in it: no note is read or written.
  "src/ai/modelCache.ts": "the converted-model cache (plan 6.0): sha256-verified model files in OPFS models/<id>/, not vault files",
  "src/ai/mt/localModels.ts": "hands the OPFS root to modelCache for the converted translation models (plan 6.4): model files, not vault files",
  "src/ai/nikudService.ts": "hands the OPFS root to modelCache for the niqqud model (plan 6.3): model files, not vault files",
  "src/ai/piiNer.ts": "checks whether the converted NER model is cached in OPFS (plan 2.6): model files, not vault files",
  "src/ai/transformers.worker.ts": "the worker's model cache root for converted models (plan 6.0): model files, not vault files",
  "src/ai/imageSearchService.ts": "checks whether the converted image-search model is cached in OPFS (plan 6.7): model files, not vault files",
  "src/ai/modelCache.ts": "the verified model cache of plan 6.0 (models/, outside the vault): downloaded ONNX files checked against their sha256, never notes",
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
export function findViolations(fileName, text, { e2e = false } = {}) {
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
    if (e2e) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "waitForTimeout"
      ) {
        report(node, "e2e-sleep");
      }
      ts.forEachChild(node, visit);
      return;
    }
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
    } else if (ts.isPropertyAccessExpression(node) && isSecretViteName(node.name.text)) {
      report(node, "vite-secret");
    } else if (ts.isStringLiteralLike(node) && isSecretViteName(node.text) && !ts.isImportDeclaration(node.parent)) {
      report(node, "vite-secret");
    }
    if (isImportMetaEnv(node)) {
      const outer = outerOf(node);
      const p = outer.parent;
      const oneName =
        (p && ts.isPropertyAccessExpression(p) && p.expression === outer) ||
        (p && ts.isElementAccessExpression(p) && p.expression === outer && ts.isStringLiteralLike(p.argumentExpression));
      if (!oneName) report(node, "env-whole");
    }
    // Direct file-system calls are a rule for the app; e2e tests seed OPFS on purpose.
    if (!e2e && ts.isCallExpression(node) && isDirectFsCall(node)) {
      report(node, "direct-fs");
    } else if (
      !e2e &&
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

/** Physical properties and the logical one to use instead (plan 9.3). */
const PHYSICAL_PROPS = [
  [/^(margin|padding|scroll-margin|scroll-padding)-(left|right)$/, (m) => `${m[1]}-inline-${m[2] === "left" ? "start" : "end"}`],
  [/^border-(left|right)(-(width|style|color))?$/, (m) => `border-inline-${m[1] === "left" ? "start" : "end"}${m[2] ?? ""}`],
  [/^border-(top|bottom)-(left|right)-radius$/, (m) => `border-${m[1] === "top" ? "start" : "end"}-${m[2] === "left" ? "start" : "end"}-radius`],
  [/^(left|right)$/, (m) => `inset-inline-${m[1] === "left" ? "start" : "end"}`],
];
const PHYSICAL_VALUES = { "text-align": /^(left|right)$/i, float: /^(left|right)$/i, clear: /^(left|right)$/i };
const LOGICAL_SCOPE = /\.prose-lumen|\.cm-/;

/** Split a CSS value on top-level whitespace (not inside `calc(...)`, `var(...)`). */
function cssWords(value) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of String(value).trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const BOX_SHORTHANDS = /^(margin|padding|inset|scroll-margin|scroll-padding|border-width|border-style|border-color)$/;

/**
 * A shorthand that sets left and right (or the left and right corners)
 * differently does not mirror in RTL: `margin: 0 1rem 0 2rem`,
 * `border-radius: 0 0.5rem 0.5rem 0`. Symmetric ones (`margin: 0 auto`) are fine.
 */
function physicalShorthand(prop, value) {
  if (BOX_SHORTHANDS.test(prop)) {
    const v = cssWords(value);
    if (v.length === 4 && v[1] !== v[3]) {
      const base = prop.startsWith("border-") ? `border-inline-start-${prop.slice(7)} / border-inline-end-${prop.slice(7)}` : `${prop}-block + ${prop}-inline-start / ${prop}-inline-end`;
      return base;
    }
    return null;
  }
  if (prop === "border-radius") {
    for (const part of String(value).split("/")) {
      const v = cssWords(part);
      // corners in order: top-left, top-right, bottom-right, bottom-left
      const [tl, tr, br, bl] = v.length === 1 ? [v[0], v[0], v[0], v[0]] : v.length === 2 ? [v[0], v[1], v[0], v[1]] : v.length === 3 ? [v[0], v[1], v[2], v[1]] : v;
      if (tl !== tr || br !== bl) return "border-start-start-radius / border-start-end-radius / border-end-end-radius / border-end-start-radius";
    }
  }
  return null;
}
const CSS_ALLOW_RE = /hygiene-allow:\s*[^\s*/]/; // a justification, not just the comment's closing */

/** Physical properties in `.prose-lumen` / `.cm-*` rules of one stylesheet: `{ line, rule, text }`. */
export function findCssViolations(fileName, text) {
  const root = postcss.parse(text, { from: fileName });
  const lines = text.split(/\r?\n/);
  const out = [];
  root.walkDecls((d) => {
    const rule = d.parent;
    if (!rule || rule.type !== "rule" || !LOGICAL_SCOPE.test(rule.selector)) return;
    let use = null;
    for (const [re, fix] of PHYSICAL_PROPS) {
      const m = re.exec(d.prop);
      if (m) use = fix(m);
    }
    if (!use) use = physicalShorthand(d.prop, d.value);
    const valRe = PHYSICAL_VALUES[d.prop];
    if (!use && valRe && valRe.test(String(d.value).trim())) use = `${d.prop}: ${/left/i.test(d.value) ? "start" : "end"}` + (d.prop === "text-align" ? "" : " (inline-start / inline-end)");
    if (!use) return;
    const line = d.source?.start?.line ?? 1;
    const here = lines[line - 1] ?? "";
    const above = line > 1 ? lines[line - 2] : "";
    if (CSS_ALLOW_RE.test(here) || CSS_ALLOW_RE.test(above)) return;
    out.push({ line, rule: "physical-css", text: `${rule.selector.replace(/\s+/g, " ")} { ${d.prop}: ${d.value} } → ${use}` });
  });
  return out;
}

function walkE2e(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkE2e(full, out);
    else if (/\.[cm]?tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function walkCss(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walkCss(full, out);
    } else if (name.endsWith(".css")) out.push(full);
  }
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

/** Every mention of the taken domain in the tree under `dir` (default: this checkout) → violations. */
export function takenDomainViolations(dir = root) {
  return domainInTree(dir).map((h) => ({ file: h.file, line: h.line, rule: "taken-domain", text: "names the domain the project never writes: use lumen-md.vercel.app" }));
}

/** Production files under src/ (so a test can run the check on the real tree). */
export function productionFiles() {
  return walk(srcDir);
}

function main() {
  const files = walk(srcDir);
  const { violations, stale } = checkFiles(files);
  const e2eFiles = walkE2e(e2eDir);
  for (const file of e2eFiles) {
    for (const v of findViolations(file, readFileSync(file, "utf8"), { e2e: true })) violations.push({ file: relKey(file), ...v });
  }
  const skips = auditSkips(root);
  violations.push(...skips.violations);
  violations.push(...takenDomainViolations());
  for (const v of violations) console.error(`${v.file}:${v.line}  [${v.rule}]  ${v.text}`);
  for (const k of stale) {
    console.error(`${k}  [direct-fs-allowlist]  listed in DIRECT_FS_ALLOWLIST but makes no direct file-system call: remove the entry`);
  }
  const sheets = walkCss(srcDir);
  let cssTotal = 0;
  for (const file of sheets) {
    for (const v of findCssViolations(file, readFileSync(file, "utf8"))) {
      cssTotal++;
      console.error(`${relative(root, file)}:${v.line}  [${v.rule}]  ${v.text}`);
    }
  }
  const total = violations.length + stale.length;
  if (total > 0 || cssTotal > 0) {
    if (total > 0)
      console.error(
        `\n✖ code hygiene: ${total} violation(s). Replace \`as any\` with a real type and ` +
          "`console.log` with `log` from src/lib/logger and an e2e `waitForTimeout` with a wait " +
          "for the condition; take secrets from the secret store, not VITE_* [vite-secret]; " +
          "read import.meta.env one name at a time (src/lib/publicEnv.ts) [env-whole]; " +
          "or add `// hygiene-allow: <reason>`. " +
          "Give a skipped test `// skip-reason: <why> | task: <id> | until: YYYY-MM-DD` [skip-reason], or fix it. " +
          "Read and write vault files through src/storage/workspace.ts / src/storage/vault, not file-system handles. " +
          "Never name the taken domain anywhere in the tree [taken-domain].",
      );
    if (cssTotal > 0)
      console.error(
        `\n✖ code hygiene: ${cssTotal} physical CSS propert${cssTotal === 1 ? "y" : "ies"} in preview/editor rules. ` +
          "Use the logical property shown, or add `/* hygiene-allow: <reason> */`.",
      );
    process.exit(1);
  }
  console.error(
    `✓ code hygiene: ${files.length} production files clean (no \`as any\`, no console.log, no secret VITE_*, no whole import.meta.env, ` +
      `no direct file-system calls outside the vault layer and ${Object.keys(DIRECT_FS_ALLOWLIST).length} allowlisted files); ` +
      `${sheets.length} stylesheets use logical properties in .prose-lumen / .cm-* rules; ` +
      `${e2eFiles.length} e2e files without waitForTimeout; ` +
      `${skips.sites.length} skipped tests each with a reason, task and date (${skips.e2eCount} of at most ${MAX_E2E_SKIPS} in e2e); ` +
      "the taken domain appears nowhere in the tree.",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
