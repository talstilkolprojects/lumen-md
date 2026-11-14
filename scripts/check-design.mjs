#!/usr/bin/env node
/**
 * Design-system gate (plan W3.1).
 *
 *   color    src/ui: no hard-coded colour — a hex, rgb()/rgba(), or hsl()/hsla()
 *            whose first argument is not var(…). Colours come from the tokens
 *            (src/ui/tokens.ts, src/index.css).
 *   layout   all of src/: nothing animates or transitions width, height,
 *            top / left / right / bottom, inset, margin, padding, font-size,
 *            line-height or border-width (they move layout every frame).
 *   motion   src/ui and src/index.css: transitions and keyframes move only
 *            transform and opacity (`all` included), and finite durations are
 *            the scale — var(--duration-fast|base|slow) or 100 / 250 / 350 ms.
 *            Infinite loaders (spin, pulse) may keep their own pace.
 *
 * TS/TSX are read through the TypeScript AST (string literals only, so
 * comments and code never count); CSS with comments stripped. A real
 * exception gets `design-allow: <reason>` on the line or the line above.
 *
 *   node scripts/check-design.mjs           # report, exit 1 on any finding
 *   node scripts/check-design.mjs --json
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const ALLOW = /design-allow:\s*\S+/;

const COLOR = /#[0-9a-fA-F]{3,8}\b(?![-\w])|\brgba?\(|\bhsla?\(\s*(?!var\()/;
const LAYOUT = /^(width|height|top|left|right|bottom|inset|inset-[\w-]+|margin(-[\w-]+)?|padding(-[\w-]+)?|font-size|line-height|border(-[\w-]+)?-width|min-width|max-width|min-height|max-height)$/;
const MOVES = new Set(["transform", "opacity"]);
const SCALE = new Set(["0", "0s", "0ms", "100ms", "250ms", "350ms", ".1s", "0.1s", ".25s", "0.25s", ".35s", "0.35s"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__" && name !== "node_modules") walk(full, out);
    } else if (/\.(tsx?|css)$/.test(name) && !/\.(test|spec)\.tsx?$|\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** The properties and durations of a `transition` value: "opacity 100ms, transform 250ms ease". */
export function parseTransition(value) {
  return value
    .split(/,(?![^(]*\))/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const words = part.split(/\s+(?![^(]*\))/);
      const prop = words.find((w) => /^[a-z-]+$/.test(w) && !/^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|infinite|alternate|forwards|backwards|both|none|normal|reverse)$/.test(w)) ?? "all";
      const durations = words.filter((w) => /^-?[\d.]+m?s$/.test(w) || /^var\(--duration-/.test(w));
      return { prop, duration: durations[0] ?? null };
    });
}

/** The keyframe name and duration of an `animation` value, and whether it loops. */
export function parseAnimation(value) {
  return value
    .split(/,(?![^(]*\))/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const words = part.split(/\s+(?![^(]*\))/);
      const name = words.find((w) => /^[a-zA-Z][\w-]*$/.test(w) && !/^(ease|ease-in|ease-out|ease-in-out|linear|infinite|alternate|forwards|backwards|both|none|normal|reverse|running|paused)$/.test(w)) ?? null;
      const duration = words.find((w) => /^-?[\d.]+m?s$/.test(w) || /^var\(--duration-/.test(w)) ?? null;
      return { name, duration, infinite: words.includes("infinite") };
    });
}

const okDuration = (d) => d === null || /^var\(--duration-(fast|base|slow)\)$/.test(d) || SCALE.has(d);

/** Properties each @keyframes block of a CSS text animates. */
export function keyframesOf(css) {
  const out = new Map();
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < css.length && depth) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    const body = css.slice(re.lastIndex, i - 1);
    const props = new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map((x) => x[1]));
    out.set(m[1], { props, line: css.slice(0, m.index).split("\n").length });
  }
  return out;
}

const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));

/** Findings for one file. `strict`: the motion rules apply (src/ui, src/index.css). `colors`: the colour rule applies (src/ui). */
export function scan(fileName, text, { strict, colors }) {
  const out = [];
  const lines = text.split(/\r?\n/);
  const allowed = (line) => ALLOW.test(lines[line - 1] ?? "") || ALLOW.test(lines[line - 2] ?? "");
  const add = (line, rule, what) => {
    if (!allowed(line)) out.push({ line, rule, text: what.replace(/\s+/g, " ").trim().slice(0, 100) });
  };
  const checkDecl = (prop, value, line) => {
    if (prop === "transition" || prop === "transition-property") {
      for (const t of parseTransition(value)) {
        if (LAYOUT.test(t.prop)) add(line, "layout", `${prop}: ${value}`);
        else if (strict && !MOVES.has(t.prop)) add(line, "motion", `${prop}: ${value} — only transform and opacity move`);
        else if (strict && !okDuration(t.duration)) add(line, "motion", `${prop}: ${value} — use the duration scale`);
      }
    }
    if (prop === "animation" || prop === "animation-duration") {
      for (const a of parseAnimation(value)) if (strict && !a.infinite && !okDuration(a.duration)) add(line, "motion", `${prop}: ${value} — use the duration scale`);
    }
  };
  if (fileName.endsWith(".css")) {
    const css = stripCssComments(text);
    const cssLines = css.split("\n");
    cssLines.forEach((l, i) => {
      if (colors && COLOR.test(l) && !/--[\w-]+\s*:/.test(l)) add(i + 1, "color", l);
      const decl = /^\s*(transition|transition-property|animation|animation-duration)\s*:\s*([^;]*)/.exec(l);
      if (decl) {
        let value = decl[2];
        for (let j = i + 1; !l.includes(";") && j < cssLines.length && !value.includes(";"); j++) {
          if (cssLines[j].includes(";")) {
            value += ` ${cssLines[j].split(";")[0]}`;
            break;
          }
          value += ` ${cssLines[j]}`;
        }
        checkDecl(decl[1], value.replace(/;.*$/, ""), i + 1);
      }
    });
    for (const [name, k] of keyframesOf(css)) {
      for (const p of k.props) {
        if (LAYOUT.test(p)) add(k.line, "layout", `@keyframes ${name} animates ${p}`);
        else if (strict && !MOVES.has(p)) add(k.line, "motion", `@keyframes ${name} animates ${p} — only transform and opacity move`);
      }
    }
    return out;
  }
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (node) => {
    if (colors && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))) {
      if (COLOR.test(node.text)) add(lineOf(node), "color", node.text);
    }
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      const key = node.name.text.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      if (/^(transition|transition-property|animation|animation-duration)$/.test(key)) {
        const init = node.initializer;
        const value = ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init) ? init.text : null;
        if (value !== null) checkDecl(key, value, lineOf(node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export function scanAll() {
  const findings = [];
  for (const f of walk(SRC)) {
    const rel = relative(ROOT, f).split("\\").join("/");
    const inUi = rel.startsWith("src/ui/");
    const strict = inUi || rel === "src/index.css";
    for (const v of scan(f, readFileSync(f, "utf8"), { strict, colors: inUi })) findings.push({ file: rel, ...v });
  }
  return findings;
}

function main() {
  const findings = scanAll();
  if (process.argv.includes("--json")) process.stdout.write(JSON.stringify(findings, null, 2) + "\n");
  else for (const v of findings) console.error(`${v.file}:${v.line}  [${v.rule}]  ${v.text}`);
  const by = (r) => findings.filter((f) => f.rule === r).length;
  if (findings.length) {
    console.error(`\n✖ design: ${by("color")} hard-coded colour(s), ${by("layout")} layout animation(s), ${by("motion")} motion rule break(s). Use src/ui/tokens.ts, or mark a real exception with \`design-allow: <reason>\`.`);
    process.exit(1);
  }
  console.error("✓ design: no hard-coded colours in src/ui, nothing animates layout, motion uses transform / opacity and the duration scale.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
