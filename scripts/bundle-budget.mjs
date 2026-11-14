#!/usr/bin/env node
/**
 * Bundle-size budget enforcer.
 *
 * Runs after `npm run build` and walks `dist/assets/*.js`, comparing each
 * file (gzipped) against the per-chunk-class budgets in bundle-budgets.json. Exits non-zero
 * when any budget is exceeded — so CI fails on a regression.
 *
 * The budgets live in scripts/bundle-budgets.json (plan W6.26): they only
 * go down. After each train `npm run budget:ratchet` lowers them to the
 * measured size plus a small margin; `npm run pr:check` fails a diff that
 * raises one. A rule with `expires` is an exception, and the budget fails
 * once its date has passed (LUMEN_TODAY=YYYY-MM-DD overrides today).
 *
 * `--json <file>` also writes the gzipped size per budget class (summed
 * over its files), the biggest file per class (`maxKb`, what the ratchet
 * lowers to) and in total, for scripts/bundle-diff.mjs. The same record is
 * printed as one `bundle-sizes: {…}` line, the receipt a Vercel build log
 * carries.
 */

import { promises as fs, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { compile, expiredExceptions, today, validateBudgets } from "./lib/budgetRatchet.mjs";

const DIST = path.join(process.cwd(), "dist", "assets");
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Each rule applies to files whose name matches `pattern`. Budget is in KB
// (gzipped). The first matching rule wins (scripts/bundle-budgets.json).
const SPEC = JSON.parse(readFileSync(path.join(HERE, "bundle-budgets.json"), "utf8"));
const BUDGETS = compile(SPEC);

function format(kb) {
  return kb.toFixed(1).padStart(7) + " KB";
}

async function main() {
  let entries;
  try {
    entries = await fs.readdir(DIST);
  } catch {
    console.error(`No dist/assets directory — run \`npm run build\` first.`);
    process.exit(2);
  }
  const jsFiles = entries.filter((f) => f.endsWith(".js"));
  // Plan 11.5: 0 source maps in the build — no .map files and no
  // sourceMappingURL comments anywhere in dist/ (LUMEN_SOURCEMAP=1 is for local use only).
  if (process.env.LUMEN_SOURCEMAP !== "1") {
    const { findSourceMaps } = await import("./lib/sourcemaps.mjs");
    const maps = await findSourceMaps(path.join(process.cwd(), "dist"));
    if (maps.length) {
      console.error(`✗ ${maps.length} source map(s) in dist/ (plan 11.5 allows none):\n  ${maps.slice(0, 10).join("\n  ")}`);
      process.exit(1);
    }
    console.log("  ✓ 0 source maps in dist/");
  }
  if (jsFiles.length === 0) {
    console.error("dist/assets has no .js files.");
    process.exit(2);
  }

  let failed = 0;
  /** Every failure, repeated in one block at the end of the output. */
  const failures = [];
  const shape = validateBudgets(SPEC);
  for (const p of shape) {
    failed++;
    failures.push(`bundle-budgets.json: ${p}`);
  }
  // W6.26: an exception past its date fails until it is lowered or decided again.
  const day = today();
  for (const x of expiredExceptions(SPEC, day)) {
    failed++;
    failures.push(`exception "${x.name}" (${x.budgetKb} KB) expired on ${x.expires}: finish ${x.task}, or decide it again with a new date`);
    console.log(`  ✗ exception ${x.name} expired on ${x.expires} (task ${x.task}, today ${day})`);
  }
  for (const r of SPEC.rules.filter((r) => r.expires && r.expires >= day)) console.log(`  ⏳ exception ${r.name} ${r.budgetKb} KB until ${r.expires} (task ${r.task})`);
  let total = 0;
  /** Gzipped KB per budget class, for --json. */
  const classes = {};
  console.log(
    "\n  Budget                  Actual          File\n" +
      "  ─────────               ─────────       ────",
  );

  for (const file of jsFiles.sort()) {
    const buf = await fs.readFile(path.join(DIST, file));
    const gzipped = gzipSync(buf).length;
    const kb = gzipped / 1024;
    total += kb;
    const rule = BUDGETS.find((r) => r.re.test(file));
    if (!rule) continue;
    const c = (classes[rule.name] ??= { kb: 0, files: 0, maxKb: 0 });
    c.kb += kb;
    c.files++;
    c.maxKb = Math.max(c.maxKb, kb);
    const ok = kb <= rule.budgetKb;
    if (!ok) {
      failed++;
      failures.push(`${rule.name}: ${file} ${kb.toFixed(1)} KB / ${rule.budgetKb} KB`);
      // An annotation, so the failing file shows on the PR without the job log.
      if (process.env.GITHUB_ACTIONS) console.log(`::error title=bundle budget::${rule.name}: ${file} is ${kb.toFixed(1)} KB gzipped, budget ${rule.budgetKb} KB`);
    }
    const mark = ok ? "✓" : "✗";
    console.log(
      `  ${mark} ${rule.name.padEnd(20)} ${format(kb)} / ${format(rule.budgetKb)}   ${file}`,
    );
  }

  console.log(`\n  Total gzipped: ${format(total)}`);

  // Plan 4.19: tldraw left the bundle with the move to Excalidraw. No chunk
  // may carry it again (its licence beacon and CDN fonts are third-party
  // traffic), and nothing may point at its CDN.
  const TLDRAW_MARKS = [/vendor-tldraw-/i, /cdn\.tldraw\.com/, /tldraw\/tldraw\.css/, /@tldraw\//, /"tldraw"/];
  const tldrawHits = [];
  for (const file of jsFiles) {
    if (/^vendor-tldraw-/.test(file)) tldrawHits.push(file);
    else {
      const text = await fs.readFile(path.join(DIST, file), "utf8");
      if (TLDRAW_MARKS.some((re) => re.test(text))) tldrawHits.push(file);
    }
  }
  if (tldrawHits.length) {
    failed++;
    failures.push(`tldraw in the build output: ${tldrawHits.join(", ")}`);
    console.log(`  ✗ tldraw is in the build output: ${tldrawHits.join(", ")}`);
  } else console.log("  ✓ tldraw absent from the build output");

  // C2: the budget that matters for startup is the SUM of what index.html
  // loads before the app can run (its entry script + every modulepreload),
  // not each file alone. Measured 448 KB (18.10); goal 250 KB. Ratchet down
  // as startup work moves out of the eager graph.
  const STARTUP_BUDGET_KB = SPEC.startup.budgetKb;
  try {
    const html = await fs.readFile(path.join(process.cwd(), "dist", "index.html"), "utf8");
    const startup = [...new Set([...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]))];
    let sum = 0;
    for (const f of startup) sum += gzipSync(await fs.readFile(path.join(DIST, f))).length / 1024;
    const ok = sum <= STARTUP_BUDGET_KB;
    if (!ok) {
      failed++;
      failures.push(`startup total: ${sum.toFixed(1)} KB / ${STARTUP_BUDGET_KB} KB`);
    }
    console.log(`  ${ok ? "✓" : "✗"} startup total (${startup.length} files) ${format(sum)} / ${format(STARTUP_BUDGET_KB)}`);
    classes["startup total"] = { kb: sum, files: startup.length };
  } catch {
    /* no dist/index.html (partial build) — per-file budgets still apply */
  }
  const round = (x) => Math.round(x * 10) / 10;
  const out = { totalKb: round(total), classes: Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, v.maxKb === undefined ? { kb: round(v.kb), files: v.files } : { kb: round(v.kb), files: v.files, maxKb: round(v.maxKb) }])) };
  // The receipt (W6.26): one line a build log keeps, for `npm run budget:ratchet -- --sizes`.
  console.log(`bundle-sizes: ${JSON.stringify(out)}`);
  const jsonAt = process.argv.indexOf("--json");
  if (jsonAt !== -1 && process.argv[jsonAt + 1]) {
    await fs.mkdir(path.dirname(path.resolve(process.argv[jsonAt + 1])), { recursive: true });
    await fs.writeFile(process.argv[jsonAt + 1], JSON.stringify(out, null, 2) + "\n");
  }
  if (failed > 0) {
    // One summary at the very end, so a long build log needs no scrolling (or paging) to find them.
    console.error(`\n✗ budget failures (${failed}):\n  ${failures.join("\n  ")}`);
    console.error(
      `\n✗ ${failed} chunk${failed === 1 ? "" : "s"} exceeded its budget. ` +
        `Budgets only go down (plan W6.26): split the chunk or load it lazily.\n`,
    );
    process.exit(1);
  }
  console.log("\n✓ All chunks within budget.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
