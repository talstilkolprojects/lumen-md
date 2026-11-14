/**
 * The steps `npm run ci:local` runs (plan 0.14), as data, so the choice of
 * steps is testable without running any of them.
 *
 * The list mirrors .github/workflows/ci.yml's `check` job plus the e2e job on
 * Chromium. A step whose tool is not in this checkout (an older branch with no
 * licence gate, say) is reported as "not here" instead of failing.
 */

/** @typedef {{ id: string, title: string, cmd: string[], needs?: string[], slow?: boolean, skipReason?: string, coverageMin?: number }} Step */

/** CI's coverage gate (.github/workflows/ci.yml "Coverage gate (lines >= 65%)"). */
export const COVERAGE_MIN = 65;

/**
 * Paths that are app code for build / budget / e2e: sources, specs, scripts,
 * public/, every root HTML file (each is a Vite entry: index.html,
 * playground-runner.html, livejs-runner.html…) and the build configs.
 */
export const isAppCode = (f) => /^(src|e2e|scripts|public)\/|^[^/]+\.html$|^(vite\.config|tsconfig|package|playwright\.config|postcss\.config|tailwind\.config)/.test(f);

const isCodeFile = (f) => /\.(m?[jt]sx?)$/.test(f);

/**
 * OCR inputs (plan 7.5): the OCR code, its traineddata, the golden OCR set
 * and the measuring script. A diff that touches one gets the CER step.
 */
export const isOcrInput = (f) => /^(src\/ai\/ocr[^/]*\.ts|public\/tesseract\/|eval\/golden\/ocr-he\/|scripts\/ocr\/)/.test(f);

/** A module path without its extension or a trailing /index: how imports name it. */
export const moduleStem = (p) => p.replace(/\.(m?[jt]sx?)$/, "").replace(/\/index$/, "");

/** Normalise a/b/../c → a/c (POSIX, relative to the repository root). */
function normalise(p) {
  const out = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * Every module a dynamic `import("./…")` names in these sources, as stems.
 * `vitest related` follows static imports only, so a changed module reached
 * this way (the app's lazy panels, and the tests that load them the same way)
 * would find no related test and pass as "no tests" (W1.32, Codex on #210).
 * @param {{ path: string, text: string }[]} sources repository-relative POSIX paths
 */
export function dynamicImportTargets(sources) {
  const out = new Set();
  for (const { path, text } of sources) {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    for (const m of text.matchAll(/\bimport\(\s*(?:\/\*[^*]*\*\/\s*)?["'](\.{1,2}\/[^"']+)["']\s*\)/g)) out.add(moduleStem(normalise(`${dir}/${m[1]}`)));
  }
  return out;
}

const has = (pkg, name) => Boolean(pkg?.scripts?.[name]);

/**
 * @param {{ pkg: any, exists: (path: string) => boolean, changed: string[] | null, flags: { skip?: string[], only?: string[], coverage?: boolean }, dynamicTargets?: Set<string> }} input
 *   `changed` is the list of changed files for `--changed` (deleted ones included), or null for a full run.
 *   `dynamicTargets`: module stems some source loads with a dynamic import (dynamicImportTargets).
 * @returns {Step[]}
 */
export function planSteps({ pkg, exists, changed, flags, dynamicTargets }) {
  const skip = new Set(flags.skip ?? []);
  const only = flags.only?.length ? new Set(flags.only) : null;
  // A deleted file is a change too: what referenced it may break at build time or at run time.
  const codeChanged = changed === null || changed.some(isAppCode);
  // Unit-test inputs: e2e/ is Playwright's (no vitest test imports a spec).
  const changedCode = (changed ?? []).filter((f) => isCodeFile(f) && !/^e2e\//.test(f));
  // `vitest related` cannot trace a file that is gone, nor a JSON / HTML / CSS
  // input (locales, public/_headers…) that tests read from disk: either means the full suite.
  const deletedCode = changedCode.filter((f) => !exists(f));
  const lazyCode = changedCode.filter((f) => dynamicTargets?.has(moduleStem(f)));
  const otherInputs = (changed ?? []).filter((f) => !isCodeFile(f) && isAppCode(f) && !/^e2e\//.test(f));
  const coverage = flags.coverage && changed === null;
  /** @type {Step[]} */
  const steps = [
    { id: "typecheck", title: "TypeScript", cmd: ["npx", "tsc", "--noEmit", "-p", "."] },
    has(pkg, "hygiene") ? { id: "hygiene", title: "Code hygiene", cmd: ["npm", "run", "-s", "hygiene"] } : { id: "hygiene", title: "Code hygiene", cmd: [], skipReason: "not here" },
    has(pkg, "lint") ? { id: "lint", title: "ESLint", cmd: ["npm", "run", "-s", "lint"] } : { id: "lint", title: "ESLint", cmd: [], skipReason: "not here (plan 0.4)" },
    { id: "i18n", title: "i18n keys + drift", cmd: ["node", "scripts/extract-i18n-keys.mjs", "--check"], needs: ["scripts/extract-i18n-keys.mjs"] },
    has(pkg, "licenses") ? { id: "licenses", title: "Licence gate", cmd: ["npm", "run", "-s", "licenses"] } : { id: "licenses", title: "Licence gate", cmd: [], skipReason: "not here (plan 0.10)" },
    exists("scripts/headers.mjs") ? { id: "headers", title: "Security headers", cmd: ["node", "scripts/headers.mjs", "--check"] } : { id: "headers", title: "Security headers", cmd: [], skipReason: "not here (plan 0.17)" },
    changed === null
      ? coverage
        ? { id: "test", title: `Vitest + coverage gate (lines >= ${COVERAGE_MIN}%)`, cmd: ["npx", "vitest", "run", "--coverage"], slow: true, coverageMin: COVERAGE_MIN }
        : { id: "test", title: "Vitest", cmd: ["npx", "vitest", "run"], slow: true }
      : deletedCode.length
        ? { id: "test", title: `Vitest (full: ${deletedCode.length} code file(s) deleted)`, cmd: ["npx", "vitest", "run"], slow: true }
        : lazyCode.length
          ? { id: "test", title: `Vitest (full: ${lazyCode[0]} is loaded by a dynamic import, which vitest related does not follow)`, cmd: ["npx", "vitest", "run"], slow: true }
          : otherInputs.length
          ? { id: "test", title: `Vitest (full: non-code inputs changed, e.g. ${otherInputs[0]})`, cmd: ["npx", "vitest", "run"], slow: true }
          : // --passWithNoTests: a changed file that no unit test covers is not a failure.
            { id: "test", title: "Vitest (related to the diff)", cmd: ["npx", "vitest", "related", "--run", "--passWithNoTests", ...changedCode], slow: true, empty: changedCode.length === 0 },
    { id: "build", title: "Build", cmd: ["npm", "run", "-s", "build"], slow: true },
    // Measures this run's build (see buildState), never a dist/ left from earlier.
    has(pkg, "budget") ? { id: "budget", title: "Bundle budget", cmd: ["npm", "run", "-s", "budget"] } : { id: "budget", title: "Bundle budget", cmd: [], skipReason: "not here" },
    // Plan 7.5 "runs on every PR": the CER gates (clean ≤ 5 %, degraded ≤ 12 %) on the ocr-he dev split,
    // with the app's own tesseract.js models and post-processing; it was CI's `ocr-cer` job.
    { id: "ocr", title: "OCR CER (Hebrew, English; dev split)", cmd: ["node", "scripts/ocr/cer-node.mjs"], needs: ["scripts/ocr/cer-node.mjs"], slow: true },
    { id: "e2e", title: "e2e (Chromium, production build)", cmd: ["e2e"], slow: true },
  ];
  for (const s of steps) {
    if (s.skipReason) continue;
    if (only && !only.has(s.id)) s.skipReason = "not selected";
    else if (skip.has(s.id)) s.skipReason = "skipped (--skip)";
    else if (s.needs?.some((p) => !exists(p))) s.skipReason = "not here";
    else if (changed !== null && s.id === "test" && s.empty) s.skipReason = "no unit-test inputs in the diff";
    else if (changed !== null && (s.id === "build" || s.id === "budget" || s.id === "e2e") && !codeChanged) s.skipReason = "diff touches no app code";
    else if (changed !== null && s.id === "ocr" && !changed.some(isOcrInput)) s.skipReason = "diff touches no OCR input";
  }
  return steps;
}

/**
 * CI's coverage gate on coverage/coverage-summary.json (json-summary
 * reporter): lines % must be at least `min`. A missing or unreadable
 * summary fails, as it would in CI.
 */
export function coverageGate(summaryText, min = COVERAGE_MIN) {
  let pct;
  try {
    pct = JSON.parse(summaryText ?? "").total?.lines?.pct;
  } catch {
    pct = undefined;
  }
  if (typeof pct !== "number") return { ok: false, pct: null, message: "no coverage/coverage-summary.json with total.lines.pct (json-summary reporter)" };
  return pct >= min ? { ok: true, pct, message: `Coverage lines: ${pct}%` } : { ok: false, pct, message: `Lines coverage ${pct}% < ${min}% gate` };
}

/**
 * The pre-push hook to write. An existing hook that is not ours is never
 * replaced silently: refused, or with `force` backed up first.
 * @returns {{ action: "write" | "refuse" | "backup", content: string }}
 */
export const HOOK_MARK = "installed by `npm run ci:local -- --install-hook`";
export function hookPlan(existing, { force = false } = {}) {
  const content = `#!/bin/sh\n# ${HOOK_MARK} (plan 0.14); skip once with \`git push --no-verify\`\nexec npm run -s ci:local -- --changed --skip e2e --bail\n`;
  if (existing == null || existing.includes(HOOK_MARK)) return { action: "write", content };
  return { action: force ? "backup" : "refuse", content };
}

/**
 * The build that budget and e2e use: "fresh" when the Build step passed in
 * this run, "failed" when it failed (nothing to measure or serve), "none"
 * when it did not run (--only budget, --skip build…): then they build first,
 * since a dist/ left from earlier may not be this checkout.
 */
export function buildState(results) {
  const b = results.find((r) => r.id === "build" && r.status !== "skip");
  return !b ? "none" : b.status === "pass" ? "fresh" : "failed";
}

/** Step ids, for --only / --skip. */
export const STEP_IDS = ["typecheck", "hygiene", "lint", "i18n", "licenses", "headers", "test", "build", "budget", "ocr", "e2e"];
const BOOL_FLAGS = ["--help", "--h", "-h", "--changed", "--coverage", "--bail", "--install-hook", "--force"];
const VALUE_FLAGS = ["--base", "--skip", "--only"];

/** Problems with the command line: a typo must not turn into a green run without the requested checks. */
export function argErrors(argv) {
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.includes(a)) {
      const v = argv[i + 1];
      if (!v || v.startsWith("-")) {
        errors.push(`${a} needs a value`);
        continue;
      }
      i++;
      if (a === "--base") continue;
      for (const id of v.split(",").map((x) => x.trim()).filter(Boolean)) if (!STEP_IDS.includes(id)) errors.push(`${a}: unknown step "${id}" (steps: ${STEP_IDS.join(", ")})`);
    } else if (!BOOL_FLAGS.includes(a)) errors.push(`unknown argument "${a}"`);
  }
  return errors;
}

/** e2e specs for a run: every spec for a full run; with --changed, changed specs plus the smoke test. */
export function e2eSpecs(changed, allSpecs) {
  if (changed === null) return [];
  // A changed (or deleted) helper under e2e/ can break any spec that imports it: the whole suite.
  if (changed.some((f) => /^e2e\//.test(f) && !/\.spec\.ts$/.test(f))) return [];
  const touched = changed.filter((f) => /^e2e\/.*\.spec\.ts$/.test(f) && allSpecs.includes(f));
  return [...new Set(["e2e/smoke.spec.ts", ...touched])].filter((f) => allSpecs.includes(f));
}

/** en vs he key counts must stay within 10 of each other (the CI drift gate). */
export function i18nDrift(enCount, heCount, limit = 10) {
  const diff = Math.abs(enCount - heCount);
  return { diff, ok: diff <= limit };
}

/** A fixed-width summary table. */
export function summary(results) {
  const w = Math.max(...results.map((r) => r.title.length), 10);
  const lines = results.map((r) => {
    const mark = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "–";
    const time = r.ms != null ? `${(r.ms / 1000).toFixed(1)}s` : "";
    return `${mark} ${r.title.padEnd(w)}  ${(r.status === "skip" ? r.reason : time).padEnd(10)}`;
  });
  return lines.join("\n");
}
