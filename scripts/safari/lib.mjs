/**
 * Real Safari before every promotion (plan W6.6), on BrowserStack Automate
 * under its open-source plan. Pure parts: which specs, which platforms, the
 * SDK's browserstack.yml, and reading Playwright's JSON report back per
 * platform. scripts/safari/run.mjs runs it.
 *
 * iOS runs real Safari on a real iPhone (BrowserStack: Playwright on real iOS
 * devices, Playwright ≥ 1.50.1, through their Node SDK). macOS runs
 * BrowserStack's "playwright-webkit" browser on a real Mac: that is
 * Playwright's WebKit build, not the Safari app, and the receipt says so.
 */

/**
 * The automated part of the owner's manual Safari check (plan 15.12 / W2.8):
 * the app opens, RTL and Hebrew input, the first run, switching the
 * language, and the data-safety spec (the store and history paths that lost
 * notes on Safari in #470).
 */
export const SAFARI_SPECS = ["e2e/smoke.spec.ts", "e2e/rtl.spec.ts", "e2e/first-run.spec.ts", "e2e/locale-switch.spec.ts", "e2e/data-safety.spec.ts"];

/**
 * Safari versions to keep: the current one, and the two before it, which
 * lack parts of OPFS that the vault's browser store relies on (#470). Edit
 * the device names when BrowserStack retires one.
 */
export const SAFARI_PLATFORMS = [
  { name: "safari ios 26 (iPhone 17)", os: "ios", deviceName: "iPhone 17", osVersion: "26", browserName: "safari" },
  { name: "safari ios 18 (iPhone 16)", os: "ios", deviceName: "iPhone 16", osVersion: "18", browserName: "safari" },
  { name: "safari ios 17 (iPhone 15)", os: "ios", deviceName: "iPhone 15", osVersion: "17", browserName: "safari" },
  { name: "safari macos sequoia (playwright-webkit)", os: "macos", osName: "OS X", osVersion: "Sequoia", browserName: "playwright-webkit" },
];

const q = (s) => JSON.stringify(String(s));

/** The Node SDK's browserstack.yml (credentials come from BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY). */
export function browserstackYml({ build, platforms = SAFARI_PLATFORMS }) {
  const o = [
    "# Written by scripts/safari/run.mjs (plan W6.6); credentials come from the environment.",
    `projectName: ${q("lumen-md")}`,
    `buildName: ${q(build)}`,
    "browserstackLocal: true",
    "parallelsPerPlatform: 1",
    "testObservability: false",
    "platforms:",
  ];
  for (const p of platforms) {
    if (p.os === "ios") o.push(`  - deviceName: ${q(p.deviceName)}`, `    osVersion: ${q(p.osVersion)}`, `    browserName: ${q(p.browserName)}`);
    else o.push(`  - os: ${q(p.osName)}`, `    osVersion: ${q(p.osVersion)}`, `    browserName: ${q(p.browserName)}`);
  }
  return o.join("\n") + "\n";
}

/**
 * Which platform a Playwright project of the SDK's run belongs to. The SDK
 * names a project after the platform's fields; match on the device name or
 * the OS version, case-insensitively.
 */
export function platformOf(projectName, platforms = SAFARI_PLATFORMS) {
  const n = String(projectName ?? "").toLowerCase();
  return (
    platforms.find((p) => p.deviceName && n.includes(p.deviceName.toLowerCase()) && n.includes(p.osVersion)) ??
    platforms.find((p) => p.os === "macos" && (n.includes(p.osVersion.toLowerCase()) || n.includes("os x") || n.includes("osx") || n.includes("mac"))) ??
    null
  );
}

/**
 * Playwright's JSON report of an SDK run → one result per platform:
 * [{ name, os, ok, passed, failed, failedTests, ran }]. A platform with no
 * test in the report did not run, and is not ok.
 */
export function resultsByPlatform(report, platforms = SAFARI_PLATFORMS) {
  const acc = new Map(platforms.map((p) => [p.name, { name: p.name, os: p.os, passed: 0, failed: 0, failedTests: [], ran: false }]));
  const walk = (suite) => {
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? []) {
        const p = platformOf(t.projectName);
        if (!p) continue;
        const a = acc.get(p.name);
        a.ran = true;
        if (t.status === "expected" || t.status === "flaky") a.passed++;
        else if (t.status === "unexpected") {
          a.failed++;
          a.failedTests.push(`${spec.file} › ${spec.title}`);
        }
      }
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const s of report?.suites ?? []) walk(s);
  return [...acc.values()].map((a) => ({ ...a, ok: a.ran && a.failed === 0 && a.passed > 0 }));
}

/** The suites a full receipt gets from a Safari run: { "<platform name>": { ok, detail } }. */
export function safariSuites(results) {
  return Object.fromEntries(results.map((r) => [r.name, { ok: r.ok, detail: r.ran ? `${r.passed} passed, ${r.failed} failed` : "did not run" }]));
}
