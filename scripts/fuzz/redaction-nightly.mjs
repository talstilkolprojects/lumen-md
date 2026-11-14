#!/usr/bin/env node
/**
 * The nightly redaction fuzz (plan W8.8): `npm run fuzz:redaction`.
 *
 * Runs tests/fuzz/redaction/redaction.fuzz.ts under vitest.fuzz.config.ts with
 * the night's seed (the UTC date, so a night names its notes and a rerun finds
 * the same ones), 20,000 cases across every generator. A leak is minimised and
 * added to tests/fuzz/redaction/regressions.json, which the main suite replays:
 * from then on it is a permanent test. The report goes to
 * reports/nightly/fuzz-redaction.json, which the second host (#509, W6.5) seals
 * into its receipt with the other steps.
 *
 *   node scripts/fuzz/redaction-nightly.mjs [--night 20261114] [--n 20000] [--no-save] [--commit]
 *
 * --commit: when leaks were saved, commit regressions.json on a new local
 * branch fuzz/redaction-<night> (`[skip ci]`), for the host to push and open
 * as a PR. Exit 0: no leak; 1: leaks (saved unless --no-save); 2: the run broke.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REGRESSIONS = join(root, "tests/fuzz/redaction/regressions.json");
const REPORT = join(root, "reports/nightly/fuzz-redaction.json");

export function parseArgs(argv, now = new Date()) {
  const opt = { night: now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate(), n: 20000, save: true, commit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--night") opt.night = Number(argv[++i]);
    else if (a === "--n") opt.n = Number(argv[++i]);
    else if (a === "--no-save") opt.save = false;
    else if (a === "--commit") opt.commit = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!/^\d{8}$/.test(String(opt.night))) throw new Error(`--night must be YYYYMMDD, got ${opt.night}`);
  if (!Number.isInteger(opt.n) || opt.n < 4) throw new Error(`--n must be a whole number ≥ 4, got ${opt.n}`);
  return opt;
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(REPORT), { recursive: true });
  const env = { ...process.env, LUMEN_FUZZ_NIGHT: String(opt.night), LUMEN_FUZZ_N: String(opt.n), LUMEN_FUZZ_REPORT: REPORT };
  if (opt.save) env.LUMEN_FUZZ_SAVE = REGRESSIONS;
  const r = spawnSync("npx", ["vitest", "run", "--config", "vitest.fuzz.config.ts"], { cwd: root, env, stdio: "inherit" });
  if (!existsSync(REPORT)) {
    console.error(`fuzz:redaction: no report at ${REPORT} (vitest exit ${r.status ?? r.signal})`);
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(REPORT, "utf8"));
  console.log(`fuzz:redaction night ${report.night}: ${report.cases} cases, ${report.shaded} shaded tokens, ${report.leaks.length} leaks (${report.saved} new in regressions.json), ${report.threw.length} threw`);
  if (report.leaks.length && opt.commit && report.saved) {
    const branch = `fuzz/redaction-${report.night}`;
    const git = (...args) => spawnSync("git", args, { cwd: root, stdio: "inherit" }).status === 0;
    const msg = `test(redaction): ${report.saved} leak(s) the nightly fuzz found on ${report.night} [skip ci]\n\nMinimised by scripts/fuzz/redaction-nightly.mjs; replayed by src/__tests__/redactionFuzzRegressions.test.ts.`;
    if (!(git("switch", "-c", branch) && git("add", "tests/fuzz/redaction/regressions.json") && git("-c", "user.name=lumen-factory", "-c", "user.email=factory@localhost", "-c", "core.hooksPath=/dev/null", "commit", "-m", msg))) process.exit(2);
    console.log(`fuzz:redaction: committed on ${branch}; push it and open a PR against the train`);
  }
  const broke = report.threw.length > 0 || (r.status !== 0 && report.leaks.length === 0);
  process.exit(broke ? 2 : report.leaks.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
