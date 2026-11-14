/**
 * Shared helpers for the nightly / weekly report scripts (plan 0.11).
 * Reports are written under reports/ (gitignored), uploaded as artifacts and
 * appended to the job summary; nothing is committed.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const REPORTS = join(process.cwd(), "reports");

/** Write reports/<name> (creating folders) and return its path. */
export function writeReport(name, content) {
  const path = join(REPORTS, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
  return path;
}

/**
 * Append markdown to the GitHub job summary (and print it). In Actions the
 * report's first heading also goes out as a ::notice annotation, which the
 * REST API can read without downloading the artifact.
 */
export function summary(md) {
  const head = md.split("\n").find((l) => l.startsWith("#"));
  if (process.env.GITHUB_ACTIONS && head) process.stdout.write(`::notice title=report::${head.replace(/^#+\s*/, "")}\n`);
  process.stdout.write(md.endsWith("\n") ? md : md + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.endsWith("\n") ? md : md + "\n");
}

/** A markdown table; cells are escaped for pipes and newlines. */
export function table(head, rows) {
  const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [`| ${head.map(cell).join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

export const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number" && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Whole days between an ISO date and `now`. */
export const ageDays = (iso, now = Date.now()) => Math.floor((now - Date.parse(iso)) / 86_400_000);
