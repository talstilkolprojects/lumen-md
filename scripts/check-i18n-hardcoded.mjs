#!/usr/bin/env node
/**
 * Hard-coded UI strings gate (plan 9.1): every string a user can see goes
 * through t(). Walks the TypeScript AST of src/ (not a regex, so code,
 * comments and class names are never mistaken for text) and fails on:
 *
 *   jsx-text      text between JSX tags            <button>Save</button>
 *   jsx-string    a string literal as a JSX child  <p>{"Saved"}</p>
 *   jsx-prop      a literal in a user-visible prop aria-label="Close", title, placeholder, alt, label…
 *   ui-call       a literal passed to a UI sink    showAiToast("Saved"), uiAlert({ message: "…" }), alert("…")
 *
 * A string counts only if it has words in it: symbols, numbers, keyboard
 * keys and product / format names (Markdown, GitHub, JSON, …) are not
 * translated. A real exception gets `i18n-allow: <reason>` in a comment on
 * the line or the line above (for JSX: `{/* i18n-allow: reason *\/}`).
 *
 *   node scripts/check-i18n-hardcoded.mjs           # report, exit 1 on any finding
 *   node scripts/check-i18n-hardcoded.mjs --json    # machine-readable findings
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

/** Not UI: build tooling, the node CLI, tests. */
const SKIP_DIRS = new Set(["__tests__", "node_modules", "build", "cli"]);
const SKIP_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;

/** Props whose value a user reads or a screen reader speaks. */
export const VISIBLE_PROPS = new Set([
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "title",
  "placeholder",
  "alt",
  "label",
  "tooltip",
  "emptyText",
  "message",
  "okLabel",
  "cancelLabel",
  "confirmLabel",
  "description",
  "hint",
]);

/** Functions that show their string argument to the user. */
export const UI_SINKS = new Set([
  "showAiToast",
  "showToast",
  "uiAlert",
  "uiConfirm",
  "uiPrompt",
  "uiSelect",
  "alert",
  "confirm",
  "prompt",
]);
/** Object-literal fields of a sink's options that are shown. */
const SINK_FIELDS = new Set(["message", "title", "placeholder", "okLabel", "cancelLabel", "label", "body", "detail"]);

/**
 * Words that are the same in every language: product, format and protocol
 * names, keyboard keys, units. A string made only of these (plus symbols,
 * numbers and punctuation) is not flagged.
 */
const UNTRANSLATED = new Set(
  `Lumen Markdown MD GitHub GitLab Git Gist JSON YAML CSV TSV HTML CSS JS TS JSX TSX SVG PNG JPG JPEG GIF WebP PDF DOCX EPUB
   LaTeX KaTeX TeX Mermaid Graphviz DOT PlantUML Excalidraw tldraw ECharts Vega Leaflet Pyodide Python SQL SQLite Lua Ruby R
   WebR GLSL WebGL WebGPU WASM Wasm Node Deno URL URI API ID UUID OK AI LLM GPT OpenAI Claude Anthropic Gemini Ollama Llama
   Qwen Mistral MCP RSS ICS iCal OPFS IndexedDB PWA RTL LTR UTF Unicode Emoji Obsidian Notion Zotero BibTeX DOI doi ORCID arXiv
   Esc Tab Enter Shift Ctrl Alt Cmd Option Space Backspace Delete Home End PgUp PgDn F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12
   KB MB GB ms px pt em rem fps WYSIWYG Yjs WebRTC WebSocket OAuth SSO SAML TOTP HTTP HTTPS DNS CORS CSP
   English עברית العربية Русский Français Deutsch 日本語 简体中文`.split(/\s+/).filter(Boolean),
);

/** Is one whitespace-separated token prose (as opposed to code, a name or a symbol)? */
function isProseToken(token) {
  // Strip surrounding punctuation and symbols: "(array)", "Copy…", "⚠︎".
  const t = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  if (t.length < 2) return false;
  if (UNTRANSLATED.has(t)) return false;
  // Code, ids, versions, paths, domains, env vars: anything with digits,
  // dots, colons, slashes, underscores or @ inside, camelCase, or ALL CAPS.
  if (/[\d._:/@=<>{}\[\]$#]/.test(t)) return false;
  if (/^[a-z]+[A-Z]/.test(t) || /^[A-Z]{2,}$/.test(t)) return false;
  return /\p{L}{2,}/u.test(t);
}

/** Does this text contain anything a translator would translate? */
export function hasWords(text) {
  return text.split(/\s+/).some(isProseToken);
}

/** Elements whose content is code or data, never translated UI text. */
const CODE_ELEMENTS = new Set(["style", "script", "code", "pre", "kbd", "samp", "var"]);
function insideCodeElement(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isJsxElement(n) && CODE_ELEMENTS.has(n.openingElement.tagName.getText())) return true;
  }
  return false;
}

const ALLOW = /i18n-allow:\s*\S+/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out);
    } else if (/\.tsx?$/.test(name) && !SKIP_FILE.test(name)) out.push(full);
  }
  return out;
}

/** The literal text of a string-ish expression, or null when it is not literal. */
function literalText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    // `${n} files selected`: the literal parts are what needs translating.
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" ");
  }
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression);
  return null;
}

/** Literal texts reachable as the value of an expression (both arms of a?b:c, a ?? "x", a || "x"). */
function literalTexts(node) {
  if (!node) return [];
  const own = literalText(node);
  if (own !== null) return [{ node, text: own }];
  if (ts.isConditionalExpression(node)) return [...literalTexts(node.whenTrue), ...literalTexts(node.whenFalse)];
  if (
    ts.isBinaryExpression(node) &&
    [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.PlusToken].includes(node.operatorToken.kind)
  ) {
    return [...literalTexts(node.left), ...literalTexts(node.right)];
  }
  return [];
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && ["window", "globalThis"].includes(expr.expression.text)) {
    return expr.name.text;
  }
  return null;
}

/** Findings for one source text: { line, rule, text }. */
export function scan(fileName, text) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = text.split(/\r?\n/);
  const out = [];
  const report = (node, rule, value) => {
    if (!hasWords(value)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    if (ALLOW.test(lines[line] ?? "") || (line > 0 && ALLOW.test(lines[line - 1]))) return;
    out.push({ line: line + 1, rule, text: value.replace(/\s+/g, " ").trim().slice(0, 80) });
  };
  const visit = (node) => {
    if ((ts.isJsxText(node) || ts.isJsxExpression(node)) && insideCodeElement(node)) {
      // <code>, <pre>, <style>…: data, not UI text.
    } else if (ts.isJsxText(node)) {
      report(node, "jsx-text", node.text);
    } else if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const { node: n, text: v } of literalTexts(node.expression)) report(n, "jsx-string", v);
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      if (VISIBLE_PROPS.has(name) && node.initializer) {
        const values = ts.isStringLiteral(node.initializer)
          ? [{ node: node.initializer, text: node.initializer.text }]
          : ts.isJsxExpression(node.initializer)
            ? literalTexts(node.initializer.expression)
            : [];
        for (const { node: n, text: v } of values) report(n, "jsx-prop", v);
      }
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name && UI_SINKS.has(name)) {
        // The message is the first argument (the rest are kinds, defaults,
        // options); an options object carries its shown fields by name.
        for (const [i, arg] of node.arguments.entries()) {
          if (i === 0) for (const { node: n, text: v } of literalTexts(arg)) report(n, "ui-call", v);
          if (ts.isObjectLiteralExpression(arg)) {
            for (const p of arg.properties) {
              if (ts.isPropertyAssignment(p) && SINK_FIELDS.has(p.name.getText(sf).replace(/["']/g, ""))) {
                for (const { node: n, text: v } of literalTexts(p.initializer)) report(n, "ui-call", v);
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function main() {
  const files = walk(SRC);
  const findings = [];
  for (const f of files) for (const v of scan(f, readFileSync(f, "utf8"))) findings.push({ file: relative(ROOT, f), ...v });
  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify(findings, null, 2) + "\n");
  } else {
    for (const v of findings) console.error(`${v.file}:${v.line}  [${v.rule}]  ${v.text}`);
  }
  if (findings.length) {
    console.error(
      `\n✖ i18n: ${findings.length} hard-coded UI string(s). Move each to src/i18n/locales/<lang>/<domain>.json and use t(), ` +
        "or mark a real exception with `i18n-allow: <reason>`.",
    );
    process.exit(1);
  }
  console.error(`✓ i18n: no hard-coded UI strings in ${files.length} files.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
