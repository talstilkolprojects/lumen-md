#!/usr/bin/env node
/**
 * Analyse a round of usability sessions (plan W1.29).
 *
 *   node scripts/usability-analyze.mjs <files or folders…> [--round 1|2] [--findings path.md] [--out report.md]
 *
 * Reads the JSON files the in-app recorder exports (Command palette →
 * "Usability study (moderator)…" → Export) and the .zip files participants
 * send from a self-guided session (W4.25), keeps the given round, and
 * prints (or writes) a Hebrew Markdown report: per-task success, time and
 * ease, SUS per participant with a 95% confidence interval, and, for round
 * 2, the plan's acceptance checks against the findings file. Works offline;
 * the session files never leave the machine.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { analyze, parseFindings, parseSession, report, zipJsonEntries } from "./lib/usability.mjs";

const args = process.argv.slice(2);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const inputs = args.filter((a, i) => !a.startsWith("--") && !["--round", "--findings", "--out"].includes(args[i - 1]));
if (!inputs.length) {
  console.error("usage: node scripts/usability-analyze.mjs <files or folders…> [--round 1|2] [--findings findings.md] [--out report.md]");
  process.exit(2);
}

const files = inputs.flatMap((p) => (statSync(p).isDirectory() ? readdirSync(p).filter((n) => /\.(json|zip)$/i.test(n)).map((n) => join(p, n)) : [p]));
const round = opt("--round") ? Number(opt("--round")) : undefined;
let sessions = files.flatMap((f) =>
  /\.zip$/i.test(f) ? zipJsonEntries(readFileSync(f), inflateRawSync).map(([name, text]) => parseSession(text, `${f}:${name}`)) : [parseSession(readFileSync(f, "utf8"), f)],
);
if (round) sessions = sessions.filter((s) => s.round === round);
if (!sessions.length) {
  console.error(round ? `no sessions for round ${round}` : "no sessions");
  process.exit(1);
}
const seen = new Set();
for (const s of sessions) {
  const k = `${s.participant}/${s.round}`;
  if (seen.has(k)) console.warn(`warning: ${k} appears twice; both are counted`);
  seen.add(k);
}

// Task names from the study definition (the TS file, read as text).
const study = readFileSync(new URL("../src/research/usability/study.ts", import.meta.url), "utf8");
const taskNames = [...study.matchAll(/\{ id: (\d+), he: "([^"]+)"/g)].sort((a, b) => a[1] - b[1]).map((m) => m[2]);

const findingsPath = opt("--findings");
const findings = findingsPath ? parseFindings(readFileSync(findingsPath, "utf8")) : null;
const text = report(analyze(sessions), { round, taskNames, findings });
const out = opt("--out");
if (out) {
  writeFileSync(out, text);
  console.error(`wrote ${out} (${sessions.length} sessions)`);
} else process.stdout.write(text);
