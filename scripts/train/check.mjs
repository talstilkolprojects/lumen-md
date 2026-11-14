#!/usr/bin/env node
/**
 * The train's check after each resolved merge (plan W6.42, promoted from
 * lane T2): parse errors, duplicate top-level declarations (a union can
 * declare a function twice), unused imports, named imports a relative
 * module doesn't export, and names used but declared nowhere (a ported
 * block that needs an import). Syntax only: the real typecheck is the
 * train's Vercel build.
 *
 *   node scripts/train/check.mjs <files…>      or   <rev-range>
 *
 * Exit 1 with one line per problem.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadTs } from "./ts.mjs";

/** → { bad, lines } for `files` (paths relative to `cwd`). */
export function checkFiles(ts, relFiles, cwd = process.cwd()) {
  const files = relFiles.map((f) => path.resolve(cwd, f));
  const out = [];
  let bad = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    const kind = f.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.m?ts$/.test(f) ? ts.ScriptKind.TS : f.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, kind);
    for (const d of sf.parseDiagnostics || []) { bad++; out.push(`PARSE ${f}:${sf.getLineAndCharacterOfPosition(d.start).line + 1} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`); }
    const seen = new Map();
    const add = (name, kindName, node) => {
      if (!name) return;
      const key = name;
      const prev = seen.get(key);
      // allow function overloads, interface/namespace merging, type+const same name
      if (prev && prev.k !== "function-overload" && !(prev.k === kindName && (kindName === "function-overload" || kindName === "interface")) && !((prev.k === "type" || prev.k === "interface") !== (kindName === "type" || kindName === "interface"))) {
        bad++; out.push(`DUP ${f}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${kindName} ${name} (also line ${prev.line})`);
      } else if (!prev) seen.set(key, { k: kindName, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    };
    // unused imports (noUnusedLocals): identifiers referenced nowhere outside import declarations
    const used = new Set();
    const visit = (n) => { if (ts.isImportDeclaration(n)) return; if (ts.isIdentifier(n)) used.add(n.text); ts.forEachChild(n, visit); };
    ts.forEachChild(sf, visit);
    for (const s of sf.statements) if (ts.isImportDeclaration(s) && s.importClause) {
      const c = s.importClause; const names = [];
      if (c.name) names.push(c.name.text);
      const nb = c.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) names.push(nb.name.text);
      if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) names.push(e.name.text);
      for (const nm of names) if (/\.tsx?$/.test(f) && !used.has(nm) && !/^(React|h|Fragment)$/.test(nm) && !text.includes(`{@link ${nm}`)) { bad++; out.push(`UNUSED ${f}:${sf.getLineAndCharacterOfPosition(s.getStart()).line + 1} ${nm}`); }
    }
    for (const s of sf.statements) {
      if (ts.isImportDeclaration(s) && s.importClause) {
        const c = s.importClause;
        if (c.name) add(c.name.text, "value", s);
        const nb = c.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) add(nb.name.text, "value", s);
        if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) add(e.name.text, (c.isTypeOnly || e.isTypeOnly) ? "typeimport" : "value", s);
      } else if (ts.isFunctionDeclaration(s) && s.name) add(s.name.text, s.body ? "value" : "function-overload", s);
      else if (ts.isClassDeclaration(s) && s.name) add(s.name.text, "value", s);
      else if (ts.isInterfaceDeclaration(s)) add(s.name.text, "interface", s);
      else if (ts.isTypeAliasDeclaration(s)) add(s.name.text, "type", s);
      else if (ts.isEnumDeclaration(s)) add(s.name.text, "value", s);
      else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) { if (ts.isIdentifier(d.name)) add(d.name.text, "value", s); }
    }
  }
  // named imports of relative modules that the module does not export
  const exportCache = new Map();
  function resolveMod(from, spec) {
    const base = path.resolve(path.dirname(from), spec);
    for (const c of [base, base + ".ts", base + ".tsx", base + ".mts", base + "/index.ts", base + "/index.tsx", base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts")]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    return null;
  }
  function exportsOf(file, depth = 0) {
    if (exportCache.has(file)) return exportCache.get(file);
    const out = new Set(); let star = false;
    if (/\.(json|css|svg|png|wasm)$/.test(file)) { exportCache.set(file, null); return null; }
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    for (const st of sf.statements) {
      const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined;
      const exp = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (ts.isExportDeclaration(st)) {
        if (!st.exportClause) { const t = st.moduleSpecifier && resolveMod(file, st.moduleSpecifier.text); const e = t && depth < 5 ? exportsOf(t, depth + 1) : null; if (!e) star = true; else for (const x of e) out.add(x); }
        else if (ts.isNamedExports(st.exportClause)) for (const e of st.exportClause.elements) out.add(e.name.text);
        else star = true;
      } else if (exp) {
        if (st.name && st.name.text) out.add(st.name.text);
        if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) out.add(d.name.text); else star = true;
        if (mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) out.add("default");
      } else if (ts.isExportAssignment(st)) out.add("default");
    }
    const r = star ? null : out; exportCache.set(file, r); return r;
  }
  for (const f of files.filter((x) => /\.(m?ts|tsx)$/.test(x))) {
    const sf = ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const check = (spec, names, node) => {
      if (!spec.startsWith(".")) return;
      const t = resolveMod(f, spec); if (!t) { bad++; out.push(`NOMODULE ${f}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${spec}`); return; }
      const e = exportsOf(t); if (!e) return;
      for (const n of names) if (!e.has(n)) { bad++; out.push(`NOEXPORT ${f}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${n} from ${spec}`); }
    };
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && st.importClause) {
        const c = st.importClause; const names = [];
        if (c.name) names.push("default");
        if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) names.push((e.propertyName ?? e.name).text);
        check(st.moduleSpecifier.text, names, st);
      }
      if (ts.isExportDeclaration(st) && st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) check(st.moduleSpecifier.text, st.exportClause.elements.map((e) => (e.propertyName ?? e.name).text), st);
    }
    // dynamic imports: (await import("./x")).name and const { a } = await import("./x")
    const visit = (n) => {
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
        const spec = n.arguments[0].text; let p = n.parent; const names = [];
        while (p && (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p))) p = p.parent;
        if (p && ts.isPropertyAccessExpression(p) && !["then", "catch", "finally"].includes(p.name.text)) names.push(p.name.text);
        if (p && ts.isVariableDeclaration(p) && ts.isObjectBindingPattern(p.name)) for (const el of p.name.elements) names.push(((el.propertyName ?? el.name)).getText());
        check(spec, names, n);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  // names used but declared nowhere (a ported block that needs an import or a context field)
  const tsFiles = files.filter((f) => /\.(m?ts|tsx)$/.test(f) && !f.includes("__tests__") && !f.includes(`${path.sep}e2e${path.sep}`));
  if (tsFiles.length && tsFiles.length < 400) {
    const prog = ts.createProgram(tsFiles, { noResolve: true, noEmit: true, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"], types: [] });
    for (const sf of prog.getSourceFiles()) {
      if (!tsFiles.some((f) => sf.fileName.endsWith(f))) continue;
      for (const d of prog.getSemanticDiagnostics(sf)) {
        if (![2304, 2552].includes(d.code)) continue;
        const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
        if (/'(import\.meta|__dirname|process|require|module|Buffer|global|NodeJS|JSX|React|__APP_VERSION__|__BUILD_[A-Z_]+__)'/.test(msg)) continue;
        bad++; out.push(`NAME ${sf.fileName}:${sf.getLineAndCharacterOfPosition(d.start).line + 1} ${msg}`);
      }
    }
  }
  out.push(`checked ${files.length} files, ${bad} problems`);
  // Paths in the messages relative to cwd, as given.
  return { bad, lines: out.map((l) => l.split(`${cwd}${path.sep}`).join("")) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let files = process.argv.slice(2);
  if (files.length === 1 && files[0].includes("..")) files = execFileSync("git", ["diff", "--name-only", "--diff-filter=AM", files[0]], { encoding: "utf8" }).split("\n");
  files = files.filter((f) => /\.(m?ts|tsx|m?js|jsx)$/.test(f) && fs.existsSync(f));
  const ts = loadTs();
  if (!ts) {
    console.error("✗ train check: no TypeScript (node_modules, or LUMEN_TS)");
    process.exit(2);
  }
  const r = checkFiles(ts, files);
  console.log(r.lines.join("\n"));
  process.exit(r.bad ? 1 : 0);
}
