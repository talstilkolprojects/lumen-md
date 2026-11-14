#!/usr/bin/env node
/**
 * Design audit (plan W3.1): the checklist, run on each of the 40 surfaces
 * in scripts/design-surfaces.json (src/ui/<Surface>.tsx and its .css):
 *
 *   1. colour     — no hard-coded colour; tokens only        (check-design.mjs)
 *   2. motion     — only transform / opacity, the duration scale, nothing on layout
 *   3. direction  — inline styles use logical sides (margin/padding/border/inset
 *                   InlineStart / End, textAlign start / end), so the surface
 *                   mirrors in Hebrew
 *   4. overlay    — a modal backdrop uses var(--overlay)
 *   5. elevation  — box shadows come from the scale (var(--shadow-*)), an
 *                   accent / border ring may follow
 *
 * Reduced motion needs no per-surface check: every duration is a token or is
 * cut by the global prefers-reduced-motion rule in src/index.css.
 *
 *   node scripts/design-audit.mjs          # one line per surface, exit 1 if any fails
 *   node scripts/design-audit.mjs --json
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { scan } from "./check-design.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOW = /design-allow:\s*\S+/;
const PHYSICAL = new Set(["marginLeft", "marginRight", "paddingLeft", "paddingRight", "borderLeft", "borderRight", "borderLeftWidth", "borderRightWidth", "left", "right"]);

/** Problems of the checklist items 3–5 in one source. */
export function auditSource(fileName, text) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = text.split("\n");
  const out = { direction: [], overlay: [], elevation: [] };
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const allowed = (l) => ALLOW.test(lines[l - 1] ?? "") || ALLOW.test(lines[l - 2] ?? "");
  const visit = (node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === "style" && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression && ts.isObjectLiteralExpression(node.initializer.expression)) {
      for (const p of node.initializer.expression.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const key = p.name.getText(sf).replace(/["']/g, "");
        const l = line(p);
        if (allowed(l)) continue;
        const value = ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer) ? p.initializer.text : null;
        if (PHYSICAL.has(key) || (key === "textAlign" && (value === "left" || value === "right"))) out.direction.push({ line: l, text: `${key}${value ? `: ${value}` : ""}` });
        if (key === "boxShadow" && value && value !== "none" && !/^var\(--shadow-(sm|md|lg|xl|accent)\)(,\s*0 0 0 \d+px hsl\(var\(--[\w-]+\)[^)]*\))?$/.test(value) && !/^(inset )?0 0 0 \d+px hsl\(var\(--[\w-]+\)/.test(value)) out.elevation.push({ line: l, text: `boxShadow: ${value}` });
      }
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(sf) === "background" && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))) {
      // A full-screen backdrop: position fixed and inset 0 in the same object.
      const obj = node.parent;
      const has = (k, v) => obj.properties.some((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === k && (v === undefined || p.initializer.getText(sf).replace(/["']/g, "") === v));
      if (has("position", "fixed") && has("inset", "0") && /hsl\(var\(--(fg|bg)\)|0 0% 0%/.test(node.initializer.text) && !allowed(line(node))) out.overlay.push({ line: line(node), text: node.initializer.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export function audit() {
  const { surfaces } = JSON.parse(readFileSync(join(ROOT, "scripts/design-surfaces.json"), "utf8"));
  return surfaces.map((name) => {
    const tsx = join(ROOT, "src/ui", `${name}.tsx`);
    const css = join(ROOT, "src/ui", `${name}.css`);
    if (!existsSync(tsx)) return { name, missing: true, pass: false, problems: { missing: [{ line: 0, text: `src/ui/${name}.tsx` }] } };
    const text = readFileSync(tsx, "utf8");
    const design = [...scan(tsx, text, { strict: true, colors: true }), ...(existsSync(css) ? scan(css, readFileSync(css, "utf8"), { strict: true, colors: true }) : [])];
    const rest = auditSource(tsx, text);
    const problems = {
      colour: design.filter((d) => d.rule === "color"),
      motion: design.filter((d) => d.rule !== "color"),
      ...rest,
    };
    return { name, pass: Object.values(problems).every((p) => p.length === 0), problems };
  });
}

function main() {
  const rows = audit();
  if (process.argv.includes("--json")) process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  for (const r of rows) {
    const bad = Object.entries(r.problems).filter(([, p]) => p.length);
    console.error(`${r.pass ? "✓" : "✗"} ${r.name}${bad.length ? `  — ${bad.map(([k, p]) => `${k}: ${p.map((x) => `${x.line} ${x.text}`).join("; ")}`).join(" | ")}` : ""}`);
  }
  const passed = rows.filter((r) => r.pass).length;
  console.error(`\n${passed === rows.length ? "✓" : "✗"} design audit: ${passed}/${rows.length} surfaces pass the checklist`);
  if (passed !== rows.length) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
