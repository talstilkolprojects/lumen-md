/**
 * A Playwright reporter for the e2e gate (scripts/e2e-gate.mjs): after the
 * run, one compact block per failing test — its place, its title, the first
 * lines of its error and of the page snapshot Playwright saved with it
 * (error-context.md). The build log shows only so much, and the line
 * reporter's dump of a failure is mostly attachment paths nobody can open.
 *
 * LUMEN_E2E_REPORT_FILE, when set, also gets the whole block (a probe build
 * writes it under dist/ so it can be read after the build).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

const strip = (s) => String(s ?? "").replace(/\u001b\[[0-9;]*m/g, "");
const head = (s, n) => strip(s).split("\n").slice(0, n);

/** The block for the failures, as lines. Exported for the test. */
export function failureLines(failures, { errorLines = 20, contextLines = 40 } = {}) {
  const out = [];
  for (const f of failures) {
    out.push(`✗ ${f.where} › ${f.title}${f.status === "timedOut" ? " (timed out)" : ""}`);
    for (const l of head(f.error, errorLines)) out.push(`    ${l}`);
    if (f.context) {
      out.push("    page:");
      for (const l of head(f.context, contextLines)) out.push(`      ${l}`);
    }
  }
  return out;
}

export default class CompactFailures {
  constructor() {
    this.failures = [];
    this.counts = { passed: 0, failed: 0, skipped: 0, flaky: 0 };
  }
  onTestEnd(test, result) {
    if (result.status === "skipped") this.counts.skipped++;
    else if (result.status === "passed") this.counts.passed++;
    if (result.status !== "failed" && result.status !== "timedOut") return;
    this.counts.failed++;
    const ctx = result.attachments.find((a) => a.name === "error-context");
    let context = "";
    try {
      context = ctx?.body ? ctx.body.toString("utf8") : ctx?.path ? readFileSync(ctx.path, "utf8") : "";
    } catch {
      /* no snapshot */
    }
    this.failures.push({
      where: `${relative(process.cwd(), test.location.file)}:${test.location.line}`,
      title: test.titlePath().slice(2).join(" › "),
      status: result.status,
      error: result.errors.map((e) => e.message ?? e.value ?? "").join("\n") || "(no error message)",
      context: context.replace(/^# .*\n+/gm, ""),
    });
  }
  onEnd(result) {
    const lines = [
      `e2e summary: ${result.status}; ${this.counts.passed} passed, ${this.counts.failed} failed, ${this.counts.skipped} skipped`,
      ...failureLines(this.failures),
    ];
    console.log(`\n${lines.join("\n")}`);
    const file = process.env.LUMEN_E2E_REPORT_FILE;
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${lines.join("\n")}\n`);
    }
  }
  printsToStdio() {
    return false;
  }
}
