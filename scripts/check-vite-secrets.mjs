#!/usr/bin/env node
/**
 * Fails when the value of a secret-named `VITE_*` variable (TOKEN / SECRET /
 * KEY, apart from the public names in check-code-hygiene's
 * PUBLIC_VITE_NAMES) appears in the built app.
 *
 * CI builds with canary values in such variables — one the app used to
 * read (VITE_RESEARCH_TOKEN) and one nothing reads (VITE_CI_CANARY_SECRET),
 * which catches Vite inlining the whole import.meta.env object — then runs:
 *
 *   node scripts/check-vite-secrets.mjs [dir]     # default dist/
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_VITE_NAMES, SECRET_VITE_NAME } from "./check-code-hygiene.mjs";

const TEXT = /\.(m?js|cjs|css|html|json|map|txt|webmanifest|svg)$/i;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (TEXT.test(name)) yield p;
  }
}

/** Findings ({file, name}) for every secret-named VITE_* value of `env` found under `dir`. */
export function scanViteSecrets(dir, env = process.env) {
  const needles = Object.entries(env).filter(
    ([name, v]) => SECRET_VITE_NAME.test(name) && !PUBLIC_VITE_NAMES.has(name) && typeof v === "string" && v.length >= 8,
  );
  const findings = [];
  if (!needles.length) return { findings, checked: [] };
  for (const file of files(dir)) {
    const text = readFileSync(file, "utf8");
    for (const [name, v] of needles) if (text.includes(v)) findings.push({ file: relative(dir, file), name });
  }
  return { findings, checked: needles.map(([n]) => n) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist"));
  if (!existsSync(dir)) {
    console.error(`${dir} does not exist: build first.`);
    process.exit(2);
  }
  const hasJs = existsSync(join(dir, "assets")) && readdirSync(join(dir, "assets")).some((f) => f.endsWith(".js"));
  if (!hasJs) {
    console.error(`${dir} has no built JavaScript (dist/assets/*.js): the build did not finish.`);
    process.exit(2);
  }
  const { findings, checked } = scanViteSecrets(dir);
  if (!checked.length) {
    console.error("::error::No secret-named VITE_* variable is set: build with canaries (see .github/workflows/ci.yml).");
    process.exit(2);
  }
  if (findings.length) {
    for (const f of findings) console.error(`::error file=${f.file}::the value of ${f.name} is in the bundle`);
    process.exit(1);
  }
  console.log(`✓ none of ${checked.join(", ")} reached ${relative(process.cwd(), dir) || dir}.`);
}
