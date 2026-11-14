#!/usr/bin/env node
/**
 * Real Safari on BrowserStack (plan W6.6): build this checkout for e2e, run
 * SAFARI_SPECS once per SAFARI_PLATFORMS through BrowserStack's Node SDK
 * (with BrowserStack Local, so the devices reach this machine's server),
 * and write the result per platform.
 *
 *   node scripts/safari/run.mjs                 # in the checkout to test (the factory runs it in its container)
 *   node scripts/safari/run.mjs --seal --out safari.json   # standalone: a sealed "safari" receipt (nightly key)
 *   node scripts/safari/run.mjs --seal --tasks W6.1,3.7      # …that names the plan tasks it verifies on real
 *                                                            # devices (W6.7 counts "real" only for named tasks)
 *   node scripts/safari/run.mjs --dry-run       # print browserstack.yml and the commands; run nothing
 *
 * Needs BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY (the open-source
 * plan's Automate credentials). LUMEN_BS_SDK overrides the SDK package
 * (default browserstack-node-sdk; npx fetches it, nothing is added to the
 * lockfile).
 *
 * Writes reports/nightly/safari.json ({ platforms, specs }); exit 1 when a
 * platform failed or did not run, 2 when it could not start.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOrCreateKey, seal } from "../nightly/receipt.mjs";
import { SAFARI_PLATFORMS, SAFARI_SPECS, browserstackYml, resultsByPlatform } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function main() {
  const argv = process.argv.slice(2);
  const opt = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
  const cwd = process.cwd();
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() || null;
  const build = `lumen-md ${sha ? sha.slice(0, 12) : "local"} ${new Date().toISOString().slice(0, 16)}`;
  const sdk = process.env.LUMEN_BS_SDK || "browserstack-node-sdk";
  const json = ".factory/safari-report.json";
  const cmds = [
    ["npx", ["vite", "build", "--outDir", ".factory/dist-safari"], { VITE_E2E: "1" }],
    ["npx", ["-y", sdk, "playwright", "test", "-c", ".factory/playwright.browserstack.config.mjs", ...SAFARI_SPECS, "--reporter=json"], { PLAYWRIGHT_JSON_OUTPUT_NAME: json }],
  ];
  if (argv.includes("--dry-run")) {
    process.stdout.write(browserstackYml({ build }));
    for (const [c, a, e] of cmds) console.log(`${Object.entries(e).map(([k, v]) => `${k}=${v} `).join("")}${c} ${a.join(" ")}`);
    return 0;
  }
  if (!process.env.BROWSERSTACK_USERNAME || !process.env.BROWSERSTACK_ACCESS_KEY) {
    console.error("✗ safari: BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY are not set (docs: contributing/promotion)");
    return 2;
  }
  mkdirSync(join(cwd, ".factory"), { recursive: true });
  copyFileSync(join(HERE, "playwright.browserstack.config.mjs"), join(cwd, ".factory/playwright.browserstack.config.mjs"));
  writeFileSync(join(cwd, "browserstack.yml"), browserstackYml({ build }));
  const startedAt = new Date().toISOString();
  const steps = [];
  for (const [c, a, e] of cmds) {
    const r = spawnSync(c, a, { cwd, stdio: "inherit", env: { ...process.env, ...e } });
    steps.push({ cmd: `${c} ${a.join(" ")}`, status: r.status ?? String(r.signal) });
    if (steps.length === 1 && r.status !== 0) break;
  }
  let report = null;
  try {
    report = JSON.parse(readFileSync(join(cwd, json), "utf8"));
  } catch {
    /* why: the SDK stopped before Playwright wrote its report; every platform is then "did not run" */
  }
  const platforms = resultsByPlatform(report).map((p) => ({ ...p, ...SAFARI_PLATFORMS.find((x) => x.name === p.name) }));
  const out = { specs: SAFARI_SPECS, build, platforms };
  mkdirSync(join(cwd, "reports/nightly"), { recursive: true });
  writeFileSync(join(cwd, "reports/nightly/safari.json"), JSON.stringify(out, null, 2) + "\n");
  for (const p of platforms) console.log(`${p.ok ? "✓" : "✗"} ${p.name}: ${p.ran ? `${p.passed} passed, ${p.failed} failed` : "did not run"}`);
  if (argv.includes("--seal")) {
    const file = resolve(opt("out") ?? "safari-receipt.json");
    const { privateKeyPem } = loadOrCreateKey();
    const sealed = seal(
      {
        version: 1,
        kind: "safari",
        startedAt,
        finishedAt: new Date().toISOString(),
        commit: { sha, branch: spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout.trim() },
        machine: { platform: process.platform, arch: process.arch, node: process.version, host: process.env.LUMEN_FACTORY_HOST ?? "manual" },
        real: { type: "device", what: "BrowserStack Automate: real iOS devices (Safari) and a real Mac (playwright-webkit)", tasks: opt("tasks")?.split(",").map((x) => x.trim()).filter(Boolean) ?? [] },
        steps,
        ...out,
      },
      privateKeyPem,
    );
    writeFileSync(file, JSON.stringify(sealed, null, 2) + "\n");
    console.log(`receipt ${file}`);
  }
  return platforms.every((p) => p.ok) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
