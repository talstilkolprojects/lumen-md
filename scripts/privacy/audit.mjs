#!/usr/bin/env node
/**
 * Audit mode (plan W2.24): run the whole local-only journey through an
 * outside network analyzer, and compare what it saw with what the app's own
 * signed privacy report says.
 *
 *   node scripts/privacy/audit.mjs [--out <dir>] [--har <file>] [--port 8899]
 *                                  [--sign <release.key>] [--publish]
 *
 *   1. starts mitmproxy (`mitmdump`, 10.1 or newer, for `hardump`) on
 *      127.0.0.1:<port>, unless --har gives a capture made some other way;
 *   2. runs e2e/privacy-audit.spec.ts (chromium) through that proxy, loopback
 *      included, so the app's own requests to the dev server pass it too and
 *      prove the proxy was in the path. The spec sets local-only and audit
 *      mode, runs the journey, exports the signed report and keeps
 *      Playwright's request log;
 *   3. verifies the report (scripts/privacy/report-core.mjs) and compares it
 *      with both observers (scripts/privacy/compare.mjs);
 *   4. writes <out>/audit.json; with --sign, signs it with the release key
 *      (minisign, LUMEN_RELEASE_PASSPHRASE); with --publish (a passing audit
 *      only), copies it to security/privacy-audits/<version>.json and
 *      rewrites the docs page (scripts/privacy/publish.mjs).
 *
 * Owner prerequisites: mitmproxy (`brew install mitmproxy` / `pipx install
 * mitmproxy`), the repo's dev dependencies and Playwright's chromium.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { opts } from "../supply-chain/lib.mjs";
import { signData } from "../supply-chain/minisign.mjs";
import { reportSha256, verifyBundle } from "./report-core.mjs";
import { auditVerdict, compareWithReport, harUrls } from "./compare.mjs";
import { AUDIT_FORMAT, AUDITS_DIR, publish } from "./publish.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Everything the audit decides, from the files the run left behind. Exported for the tests. */
export function evaluateAudit({ bundle, playwrightUrls, harUrls: proxyUrls, version, commit, date = new Date().toISOString(), pub }) {
  const v = verifyBundle(bundle, { pub, localOnly: true });
  const comparisons = [];
  if (v.report) {
    if (proxyUrls) comparisons.push(compareWithReport("mitmproxy", proxyUrls, v.report));
    if (playwrightUrls) comparisons.push(compareWithReport("playwright", playwrightUrls, v.report));
  }
  const verdict = auditVerdict(comparisons, { localOnly: true });
  const problems = [...v.problems.map((p) => `report: ${p}`), ...verdict.problems];
  if (v.report && !v.report.auditMode) problems.push("report: not exported in audit mode");
  return {
    format: AUDIT_FORMAT,
    version,
    commit,
    date,
    journey: "e2e/privacy-audit.spec.ts",
    policy: v.report?.policy ?? null,
    report: v.report ? { sha256: reportSha256(bundle), keyId: v.keyId, requests: v.report.summary.requests, leftDevice: v.report.summary.leftDevice, appVersion: v.report.app.version } : null,
    observers: comparisons,
    result: problems.length === 0 ? "pass" : "fail",
    problems,
  };
}

function waitForPort(port, timeoutMs = 20_000) {
  const t0 = Date.now();
  return new Promise((ok, fail) => {
    const tryOnce = () => {
      const s = createConnection({ host: "127.0.0.1", port }, () => {
        s.end();
        ok();
      });
      s.on("error", () => {
        s.destroy();
        if (Date.now() - t0 > timeoutMs) fail(new Error(`mitmproxy did not listen on ${port}`));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

async function main() {
  const o = opts(process.argv);
  const out = resolve(o.get("--out", join(root, "test-results", "privacy-audit")));
  const port = Number(o.get("--port", "8899"));
  let harFile = o.get("--har");
  mkdirSync(out, { recursive: true });

  let mitm = null;
  if (!harFile) {
    harFile = join(out, "mitmproxy.har");
    const probe = spawnSync("mitmdump", ["--version"], { encoding: "utf8" });
    if (probe.status !== 0) {
      console.error("mitmdump not found. Install mitmproxy (10.1 or newer), or pass --har <capture>.");
      process.exit(2);
    }
    mitm = spawn("mitmdump", ["-q", "--listen-host", "127.0.0.1", "--listen-port", String(port), "--set", `hardump=${harFile}`], { stdio: "inherit" });
    await waitForPort(port);
  }

  const env = { ...process.env, LUMEN_AUDIT_OUT: out, ...(mitm ? { LUMEN_AUDIT_PROXY: `http://127.0.0.1:${port}` } : {}) };
  const run = spawnSync("npx", ["playwright", "test", "e2e/privacy-audit.spec.ts", "--project=chromium"], { cwd: root, env, stdio: "inherit" });
  if (mitm) {
    // mitmdump writes the HAR when it exits.
    await new Promise((r) => {
      mitm.once("exit", r);
      mitm.kill("SIGINT");
    });
  }
  if (run.status !== 0) console.error("The journey failed; the audit still reads what it left.");

  const bundleFile = join(out, "report.json");
  const requestsFile = join(out, "requests.json");
  if (!existsSync(bundleFile)) {
    console.error(`No report at ${bundleFile}: the journey didn't get to the export.`);
    process.exit(1);
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const audit = evaluateAudit({
    bundle: JSON.parse(readFileSync(bundleFile, "utf8")),
    playwrightUrls: existsSync(requestsFile) ? JSON.parse(readFileSync(requestsFile, "utf8")) : null,
    harUrls: existsSync(harFile) ? harUrls(JSON.parse(readFileSync(harFile, "utf8"))) : null,
    version: pkg.version,
    commit,
  });
  if (!audit.observers.some((c) => c.observer === "mitmproxy")) audit.problems.push("no mitmproxy capture"), (audit.result = "fail");
  const auditFile = join(out, "audit.json");
  writeFileSync(auditFile, JSON.stringify(audit, null, 2) + "\n");
  const keyFile = o.get("--sign");
  if (keyFile) {
    const sig = signData(readFileSync(auditFile), readFileSync(keyFile, "utf8"), { passphrase: process.env.LUMEN_RELEASE_PASSPHRASE, trusted: `lumen-md privacy audit ${audit.version} ${audit.commit} ${audit.result}`, untrusted: "privacy audit, signed with the lumen-md release key" });
    writeFileSync(`${auditFile}.minisig`, sig);
  }
  for (const c of audit.observers) console.log(`${c.observer}: ${c.requestsSeen} requests, non-local ${c.observedNonLocal.length} (ledger ${c.ledgerNonLocal.length}), ${c.agree ? "agrees" : "DISAGREES"}`);
  for (const p of audit.problems) console.error(`✗ ${p}`);
  console.log(`${audit.result === "pass" ? "✓" : "✗"} privacy audit ${audit.version} (${audit.commit.slice(0, 9)}): ${audit.result} — ${auditFile}`);
  if (audit.result !== "pass") process.exit(1);
  if (o.has("--publish")) {
    const dest = join(root, AUDITS_DIR);
    mkdirSync(dest, { recursive: true });
    copyFileSync(auditFile, join(dest, `${audit.version}.json`));
    if (keyFile) copyFileSync(`${auditFile}.minisig`, join(dest, `${audit.version}.json.minisig`));
    for (const p of publish(root)) console.error(`  note: ${p}`);
    console.log(`Published ${AUDITS_DIR}/${audit.version}.json and the docs page; commit them.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
