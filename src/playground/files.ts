/**
 * Web Playground — the fence body as a small multi-file project.
 *
 *   ```playground react
 *   --- index.html ---
 *   <div id="root"></div>
 *   --- App.jsx ---
 *   export default function App() { return <h1>Hi</h1>; }
 *   --- main.jsx ---
 *   import { createRoot } from "react-dom/client";
 *   import App from "./App.jsx";
 *   createRoot(document.getElementById("root")).render(<App />);
 *   ```
 *
 * A body without markers is a single file: `main.jsx` for react, `main.js`
 * for vue / vanilla. Pure: no DOM.
 */

import { parse, tokenizer } from "acorn";
import { tokenize } from "../plugins/liveJsScope";

export type PlaygroundFramework = "vanilla" | "react" | "vue";

export interface PlaygroundFile {
  name: string;
  code: string;
}

export interface PlaygroundProject {
  framework: PlaygroundFramework;
  files: PlaygroundFile[];
  /** The module the page runs first (`main.*`, else the first script). */
  entry: string | null;
  /** index.html body (the runner adds its own document around it). */
  html: string;
  /** All CSS files, in order. */
  css: string[];
}

const MARKER_RE = /^-{3,}\s*([\w./-]+\.[A-Za-z0-9]+)\s*-{3,}\s*$/;
export const SCRIPT_EXT_RE = /\.(m?jsx?|tsx?)$/i;

export function frameworkFromMeta(meta?: string): PlaygroundFramework {
  const m = meta ?? "";
  if (/\breact\b/i.test(m)) return "react";
  if (/\bvue\b/i.test(m)) return "vue";
  return "vanilla";
}

/** Split the body at `--- name.ext ---` lines. */
export function splitFiles(body: string, framework: PlaygroundFramework): PlaygroundFile[] {
  const lines = body.split("\n");
  const files: PlaygroundFile[] = [];
  let cur: PlaygroundFile | null = null;
  const loose: string[] = [];
  for (const line of lines) {
    const m = MARKER_RE.exec(line);
    if (m) {
      cur = { name: m[1].replace(/^\.\//, ""), code: "" };
      files.push(cur);
      continue;
    }
    if (cur) cur.code += (cur.code ? "\n" : "") + line;
    else loose.push(line);
  }
  const before = loose.join("\n").trim();
  if (!files.length) {
    return before ? [{ name: framework === "react" ? "main.jsx" : "main.js", code: before }] : [];
  }
  // Text before the first marker is ignored unless it's code-like.
  if (before) files.unshift({ name: framework === "react" ? "main.jsx" : "main.js", code: before });
  return files.map((f) => ({ ...f, code: f.code.replace(/\n+$/, "") }));
}

export function buildProject(body: string, meta?: string): PlaygroundProject {
  const framework = frameworkFromMeta(meta);
  const files = splitFiles(body, framework);
  const scripts = files.filter((f) => SCRIPT_EXT_RE.test(f.name));
  const entry =
    scripts
      .filter((f) => /(?:^|\/)(main|index)\.(m?jsx?|tsx?)$/i.test(f.name))
      // The shallowest main / index wins (`main.js` before `src/main.jsx`).
      .sort((a, b) => a.name.split("/").length - b.name.split("/").length)[0]?.name ??
    scripts[0]?.name ??
    null;
  const htmlFiles = files.filter((f) => /\.html?$/i.test(f.name));
  // `index.html` is the page; another HTML file only when there's no index.
  const htmlFile = htmlFiles.find((f) => /(?:^|\/)index\.html?$/i.test(f.name)) ?? htmlFiles[0];
  const html = htmlFile?.code ?? (framework === "vue" ? '<div id="app"></div>' : '<div id="root"></div>');
  return { framework, files, entry, html, css: files.filter((f) => /\.css$/i.test(f.name)).map((f) => f.code) };
}

/** Import attributes right after a specifier: static `with {…}` / `assert {…}`, or a dynamic import's options. */
export const IMPORT_ATTRS_RE = /^\s*(?:(?:with|assert)\s*\{[^{}]*\}|,\s*\{\s*(?:with|assert)\s*:\s*\{[^{}]*\}\s*,?\s*\}\s*,?)/;

/** Resolve a relative import (`./App.jsx`, `./App`) against the project. */
export function resolveImport(spec: string, from: string, names: readonly string[]): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  const base = parts.join("/");
  const candidates = [base, ...[".js", ".jsx", ".ts", ".tsx", ".mjs", ".css", ".json"].map((e) => base + e), ...["/index.js", "/index.jsx", "/index.ts", "/index.tsx"].map((e) => base + e)];
  return candidates.find((c) => names.includes(c)) ?? null;
}

/**
 * The error for a circular import (A4, a documented decision): the runner
 * links every file as its own blob: module, and a blob's URL exists only
 * once its code is final, so two files can't import each other. `stack`
 * is the chain of files being linked, `name` the one imported again.
 */
export function circularImportMessage(stack: readonly string[], name: string): string {
  const loop = [...stack.slice(Math.max(0, stack.indexOf(name))), name];
  return `Circular import: ${loop.join(" → ")}. Playground files are linked one by one, so they can't import each other in a loop; move the shared code into a separate file that both import.`;
}

/** Bare specifiers the runner provides. */
/**
 * Module specifiers of a module's real imports and re-exports — static
 * `import … from "x"`, `import "x"`, `export … from "x"` and `import("x")`
 * with a string literal — found with the live-js tokenizer, so import-like
 * text in comments, strings and templates is ignored. `start` / `end`
 * cover the string literal, quotes included.
 */
export function importSpecifiers(code: string): Array<{ start: number; end: number; spec: string }> {
  const tokens = tokenize(code);
  const out: Array<{ start: number; end: number; spec: string }> = [];
  const add = (i: number) => {
    const t = tokens[i];
    if (t?.type === "str" || isPlainTemplate(t)) out.push({ start: t.start, end: t.end, spec: t.value.slice(1, -1) });
  };
  // Inside a top-level `import` / `export` statement, waiting for `from`.
  let inDecl = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = tokens[i - 1];
    if (t.type === "tpl") {
      // `${ … }` expressions inside a template can hold dynamic imports.
      for (const e of templateExpressions(t.value)) {
        for (const hit of importSpecifiers(e.code)) {
          out.push({ start: t.start + e.offset + hit.start, end: t.start + e.offset + hit.end, spec: hit.spec });
        }
      }
      continue;
    }
    if (t.type === "punct") {
      if (t.value === ";") inDecl = false;
      continue;
    }
    if (t.type !== "ident" || prev?.value === "." || prev?.value === "?.") continue;
    if (t.value === "import") {
      const next = tokens[i + 1];
      if (next?.type === "str") {
        add(i + 1); // import "x"
        continue;
      }
      const arg = tokens[i + 2];
      if (next?.value === "(" && (arg?.type === "str" || isPlainTemplate(arg)) && (tokens[i + 3]?.value === ")" || tokens[i + 3]?.value === ",")) {
        add(i + 2); // import("x") / import(`x`) / import("x", { with: … })
        continue;
      }
      if (t.depth === 0 && next?.value !== "." && next?.value !== "(") inDecl = true;
      continue;
    }
    if (t.value === "export" && t.depth === 0) {
      inDecl = true;
      continue;
    }
    if (t.value === "from" && inDecl && t.depth === 0 && tokens[i + 1]?.type === "str") {
      add(i + 1);
      inDecl = false;
    }
  }
  return out;
}

/** A template literal with no `${…}` substitutions or escapes: a static string. */
function isPlainTemplate<T extends { type: string; value: string }>(t: T | undefined): t is T {
  return t?.type === "tpl" && !/\$\{|\\/.test(t.value);
}

/** The loop guard the runner defines (it throws once the page has been busy too long). */
export const LOOP_GUARD = "__lumenLoop";

/**
 * Loop conditions guarded: `while (c)` → `while (__lumenLoop() && (c))`,
 * `for (a; c; b)` likewise, `do … while (c)` too, so a runaway loop throws
 * instead of freezing the editor. Found with a real parser (acorn), so
 * methods or properties named `for` / `while`, labels, ASI and every other
 * statement position are read exactly as the browser reads them.
 * `for … of / in` loops are left alone. Unparseable code is returned as is
 * (the browser reports its syntax error).
 */
export function guardLoops(code: string): string {
  let ast: AcornNode;
  try {
    ast = parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowHashBang: true,
    }) as unknown as AcornNode;
  } catch {
    return code;
  }
  const edits: Array<{ at: number; text: string }> = [];
  const wrap = (test: AcornNode) =>
    edits.push({ at: test.start, text: `${LOOP_GUARD}() && (` }, { at: test.end, text: ")" });
  const visit = (n: AcornNode) => {
    if (n.type === "WhileStatement" || n.type === "DoWhileStatement") wrap(n.test as AcornNode);
    else if (n.type === "ForStatement") {
      if (n.test) wrap(n.test as AcornNode);
      else {
        // `for (init;; update)`: the guard goes right after the first `;`.
        // Found with acorn's tokenizer, so a `;` in a comment isn't taken.
        // Without an init, tokenize from `for` itself (its `(` may follow a
        // comment that holds one too).
        const from = n.init ? (n.init as AcornNode).end : n.start;
        let inHead = !!n.init;
        for (const t of tokenizer(code.slice(from), { ecmaVersion: "latest" })) {
          if (!inHead) {
            inHead = t.type.label === "(";
            continue;
          }
          if (t.type.label === ";") {
            edits.push({ at: from + t.end, text: ` ${LOOP_GUARD}()` });
            break;
          }
        }
      }
    }
    for (const key in n) {
      const v = (n as unknown as Record<string, unknown>)[key];
      if (Array.isArray(v)) for (const c of v) isNode(c) && visit(c);
      else if (isNode(v)) visit(v);
    }
  };
  visit(ast);
  let out = code;
  for (const e of edits.sort((x, y) => y.at - x.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  return out;
}

interface AcornNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}
const isNode = (v: unknown): v is AcornNode => !!v && typeof v === "object" && typeof (v as AcornNode).type === "string";

/** The `${ … }` expressions of a template literal's source, with offsets into it. */
function templateExpressions(tpl: string): Array<{ offset: number; code: string }> {
  const out: Array<{ offset: number; code: string }> = [];
  for (let i = 1; i < tpl.length; i++) {
    if (tpl[i] === "\\") {
      i++;
      continue;
    }
    if (tpl[i] !== "$" || tpl[i + 1] !== "{") continue;
    const from = i + 2;
    // The expression ends at the first `}` outside its own brackets,
    // strings and nested templates (the tokenizer tracks those).
    const close = tokenize(tpl.slice(from)).find((x) => x.type === "punct" && x.value === "}" && x.depth === 0);
    if (!close) break;
    out.push({ offset: from, code: tpl.slice(from, from + close.start) });
    i = from + close.start;
  }
  return out;
}

/**
 * JSON-like text for a logged value, built with an output budget: the walk
 * stops once `max` characters are written (ending in `…`), so logging a
 * huge object or typed array never serializes all of it. Circular
 * references, functions and bigints are shown the way JSON can't.
 */
export function formatValue(value: unknown, max = 10_000): string {
  let out = "";
  const full = () => out.length >= max;
  const write = (s: string) => {
    if (!full()) out += s;
  };
  // Strings are cut to the remaining budget before JSON-encoding them, so a
  // huge string value or key is never serialized whole.
  const str = (t: string) => JSON.stringify(t.slice(0, Math.max(0, max - out.length) + 1));
  const seen = new WeakSet<object>();
  const walk = (v: unknown, inArray: boolean): void => {
    if (full()) return;
    if (v !== null && typeof v === "object" && typeof (v as { toJSON?: unknown }).toJSON === "function") {
      try {
        v = (v as { toJSON: () => unknown }).toJSON();
      } catch {
        /* keep the object */
      }
    }
    if (typeof v === "function") return write(str(`[Function ${String((v as { name?: string }).name || "anonymous").slice(0, max)}]`));
    if (typeof v === "bigint") return write(JSON.stringify(`${v}n`));
    if (v === undefined || typeof v === "symbol") return write(inArray ? "null" : String(v));
    if (typeof v === "number") return write(Number.isFinite(v) ? String(v) : "null");
    if (typeof v === "string") return write(str(v));
    if (v === null || typeof v !== "object") return write(JSON.stringify(v));
    if (seen.has(v)) return write('"[Circular]"');
    seen.add(v);
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      const list = v as ArrayLike<unknown>;
      write("[");
      for (let k = 0; k < list.length && !full(); k++) {
        if (k) write(",");
        walk(list[k], true);
      }
      write("]");
    } else {
      write("{");
      let first = true;
      for (const k in v) {
        if (full()) break;
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        const x = (v as Record<string, unknown>)[k];
        if (x === undefined || typeof x === "symbol") continue;
        if (!first) write(",");
        first = false;
        write(str(k) + ":");
        walk(x, false);
      }
      write("}");
    }
    seen.delete(v);
  };
  try {
    walk(value, false);
  } catch {
    return String(value).slice(0, max);
  }
  return out.length >= max ? out.slice(0, max) + "…" : out;
}

export const PROVIDED_MODULES = ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "vue"] as const;

/** Messages between the block (page) and the runner (sandboxed iframe). */
export type RunnerRequest = { type: "run"; runId: number; project: PlaygroundProject };
export type RunnerMessage =
  | { type: "ready" }
  | { type: "console"; runId: number; level: "log" | "info" | "warn" | "error"; text: string }
  | { type: "error"; runId: number; message: string }
  | { type: "done"; runId: number; ms: number };
