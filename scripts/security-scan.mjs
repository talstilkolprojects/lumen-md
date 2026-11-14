#!/usr/bin/env node
/**
 * The security scanners that run without GitHub Actions (W10.D14, plan 2.8,
 * research R3.7): in Buildkite on every build, in the nightly scheduled
 * build, and in `npm run ci:local` when the binary is installed.
 *
 *   node scripts/security-scan.mjs <tool>        one scanner
 *   node scripts/security-scan.mjs --set pr      gitleaks, npm-audit, cargo-audit, semgrep
 *   node scripts/security-scan.mjs --set nightly osv, cargo-deny, scorecard, sbom
 *   node scripts/security-scan.mjs --list        the tools and their commands
 *
 * A scanner whose binary is missing fails in CI (LUMEN_CI or BUILDKITE set:
 * the agent must have it) and is skipped, with a note, on a developer's
 * machine. --require makes a missing binary fail anywhere.
 * Reports go to reports/security/<tool>.json where the tool can write one.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPORT_DIR = "reports/security";
const LOCKFILES = ["package-lock.json", "mcp-server/package-lock.json", "src-tauri/Cargo.lock"];

/**
 * Each tool: the binary it needs and the commands it runs (all must exit 0).
 * `install` is what an agent's image needs.
 */
export const TOOLS = {
  gitleaks: {
    bin: "gitleaks",
    install: "https://github.com/gitleaks/gitleaks/releases (a static binary)",
    cmds: [["gitleaks", "detect", "--source", ".", "--no-banner", "--redact", "--exit-code", "1", "--report-format", "json", "--report-path", `${REPORT_DIR}/gitleaks.json`]],
  },
  "npm-audit": {
    bin: "npm",
    install: "npm (with Node)",
    // High and critical fail; the dev tree is the developer's, the shipped tree is what users run.
    cmds: [
      ["npm", "audit", "--omit=dev", "--audit-level=high"],
      ["npm", "--prefix", "mcp-server", "audit", "--omit=dev", "--audit-level=high"],
    ],
  },
  "cargo-audit": {
    bin: "cargo-audit",
    install: "cargo install cargo-audit --locked",
    // The offline known-bad list first (it needs nothing), then RustSec.
    cmds: [
      ["node", "scripts/audit-lock.mjs"],
      ["cargo-audit", "audit", "--file", "src-tauri/Cargo.lock", "--json"],
    ],
  },
  semgrep: {
    bin: "semgrep",
    install: "pipx install semgrep",
    // OSS rule packs in place of CodeQL; --error makes any finding fail.
    cmds: [["semgrep", "scan", "--metrics=off", "--error", "--config", "p/javascript", "--config", "p/typescript", "--config", "p/secrets", "--exclude", "node_modules", "--exclude", "dist", "--json", "--output", `${REPORT_DIR}/semgrep.json`, "src", "scripts", "mcp-server/src", "public"]],
  },
  osv: {
    bin: "osv-scanner",
    install: "https://github.com/google/osv-scanner/releases",
    cmds: [["osv-scanner", ...LOCKFILES.map((f) => `--lockfile=${f}`), "--format", "json", "--output", `${REPORT_DIR}/osv.json`]],
  },
  "cargo-deny": {
    bin: "cargo-deny",
    install: "cargo install cargo-deny --locked",
    cmds: [["cargo-deny", "--manifest-path", "src-tauri/Cargo.toml", "check", "advisories", "bans"]],
  },
  scorecard: {
    bin: "scorecard",
    install: "https://github.com/ossf/scorecard/releases (needs GITHUB_AUTH_TOKEN, read-only)",
    cmds: [["scorecard", "--repo=github.com/talstilkol/lumen-md", "--format", "json", "--show-details"]],
    stdout: `${REPORT_DIR}/scorecard.json`,
  },
  sbom: {
    bin: "syft",
    install: "https://github.com/anchore/syft/releases",
    cmds: [["syft", "dir:.", "-o", `cyclonedx-json=${REPORT_DIR}/sbom.cdx.json`]],
  },
};

/** The tool sets: what every PR gets, and what the nightly build adds. */
export const SETS = {
  pr: ["gitleaks", "npm-audit", "cargo-audit", "semgrep"],
  nightly: ["osv", "cargo-deny", "scorecard", "sbom"],
};

import { onPath as onPathIn } from "./lib/ciLocal.mjs";
/** Whether `bin` is on PATH. */
export const onPath = (bin, env = process.env) => onPathIn(bin, env);

/** Running in CI (Buildkite, or ci.yml's LUMEN_CI)? */
export const inCi = (env = process.env) => Boolean(env.BUILDKITE || env.LUMEN_CI);

/**
 * What to do for each tool: run it, skip it (binary missing on a dev
 * machine) or fail (binary missing in CI, or --require).
 * → [{ tool, action: "run" | "skip" | "fail", why?, cmds }]
 */
export function planScan(tools, { hasBin = onPath, ci = inCi(), require = false } = {}) {
  return tools.map((tool) => {
    const t = TOOLS[tool];
    if (!t) return { tool, action: "fail", why: `unknown tool "${tool}" (one of ${Object.keys(TOOLS).join(", ")})`, cmds: [] };
    if (hasBin(t.bin)) return { tool, action: "run", cmds: t.cmds };
    const why = `${t.bin} is not installed (${t.install})`;
    return ci || require ? { tool, action: "fail", why: `${why}: CI must run every scanner`, cmds: t.cmds } : { tool, action: "skip", why, cmds: t.cmds };
  });
}

function main(argv) {
  const i = argv.indexOf("--set");
  if (argv.includes("--list")) {
    for (const [k, t] of Object.entries(TOOLS)) console.log(`${k}: ${t.cmds.map((c) => c.join(" ")).join(" && ")}`);
    return 0;
  }
  const tools = i >= 0 ? SETS[argv[i + 1]] ?? [`set:${argv[i + 1]}`] : argv.filter((a) => !a.startsWith("--"));
  if (!tools.length) {
    console.error("security-scan: name a tool or --set pr|nightly");
    return 2;
  }
  mkdirSync(REPORT_DIR, { recursive: true });
  let bad = 0;
  for (const p of planScan(tools, { require: argv.includes("--require") })) {
    if (p.action === "skip") {
      console.log(`- ${p.tool}: skipped, ${p.why}`);
      continue;
    }
    if (p.action === "fail") {
      console.error(`✗ ${p.tool}: ${p.why}`);
      bad++;
      continue;
    }
    let failed = false;
    for (const [cmd, ...args] of p.cmds) {
      const out = TOOLS[p.tool].stdout;
      const r = spawnSync(cmd, args, { stdio: out ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8" });
      if (out && r.stdout) writeFileSync(out, r.stdout);
      if (r.status !== 0) {
        console.error(`✗ ${p.tool}: \`${[cmd, ...args].join(" ")}\` exited ${r.status ?? r.signal}`);
        failed = true;
        break;
      }
    }
    if (failed) bad++;
    else console.log(`✓ ${p.tool}`);
  }
  return bad ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
