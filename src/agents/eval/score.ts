/**
 * Scoring for the agent eval (MASTER_PLAN v2, E1). Every check is
 * deterministic, so a run against a real local model gives a number that
 * can be compared between models, prompts and releases.
 */

export type Check =
  /** At least `min` (0–1) of the letters are Hebrew. */
  | { type: "hebrew"; min: number }
  /** At most `max` (0–1) of the letters are Hebrew (a translation out of Hebrew). */
  | { type: "maxHebrew"; max: number }
  /** Every listed string appears (case-insensitive). */
  | { type: "contains"; all: string[] }
  /** At least one of the listed strings appears (case-insensitive). */
  | { type: "containsAny"; any: string[] }
  | { type: "notContains"; none: string[] }
  | { type: "maxChars"; max: number }
  /** A JSON path into the structured output has at least `min` items. */
  | { type: "minItems"; path: string; min: number }
  /** A regular expression (source + flags) matches the text form. */
  | { type: "matches"; source: string; flags?: string }
  /** At least `min` items of the list at `path` are among `values` (the tagger reuses the vault's own tags, 7.3.2). */
  | { type: "someOf"; path: string; values: string[]; min?: number }
  /** The text form compiles with the real Mermaid parser (7.3.2). Async: judged by `scoreCases`. */
  | { type: "mermaid" };

export interface CheckResult {
  check: Check;
  ok: boolean;
  detail: string;
}

/** The text an output is judged on: strings as is, structures as JSON. */
export function textOf(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output ?? "");
}

/** Share of letters that are Hebrew (0 when there are no letters). */
export { hebrewRatio } from "../../text/hebrew";
import { hebrewRatio } from "../../text/hebrew";

function at(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split(".").filter(Boolean)) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

export function runCheck(check: Check, output: unknown): CheckResult {
  const text = textOf(output);
  const lower = text.toLowerCase();
  switch (check.type) {
    case "hebrew": {
      // Structured answers: judge the values, not the English keys.
      const values = typeof output === "string" ? text : JSON.stringify(output).replace(/"[A-Za-z_]+":/g, "");
      const r = hebrewRatio(values);
      return { check, ok: r >= check.min, detail: `${Math.round(r * 100)}% Hebrew letters` };
    }
    case "maxHebrew": {
      const r = hebrewRatio(text);
      return { check, ok: r <= check.max, detail: `${Math.round(r * 100)}% Hebrew letters` };
    }
    case "contains": {
      const missing = check.all.filter((s) => !lower.includes(s.toLowerCase()));
      return { check, ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : "all present" };
    }
    case "containsAny": {
      const hit = check.any.find((s) => lower.includes(s.toLowerCase()));
      return { check, ok: !!hit, detail: hit ? `found: ${hit}` : `none of: ${check.any.join(", ")}` };
    }
    case "notContains": {
      const hit = check.none.filter((s) => lower.includes(s.toLowerCase()));
      return { check, ok: hit.length === 0, detail: hit.length ? `unexpected: ${hit.join(", ")}` : "clean" };
    }
    case "maxChars":
      return { check, ok: text.length <= check.max, detail: `${text.length} chars` };
    case "minItems": {
      const v = at(output, check.path);
      const n = Array.isArray(v) ? v.length : 0;
      return { check, ok: n >= check.min, detail: `${n} item(s) at ${check.path}` };
    }
    case "matches": {
      const ok = new RegExp(check.source, check.flags ?? "").test(text);
      return { check, ok, detail: ok ? "matches" : `no match for /${check.source}/` };
    }
    case "someOf": {
      const list = at(output, check.path);
      const items = Array.isArray(list) ? list.map((x) => String(x).toLowerCase()) : [];
      const hits = items.filter((x) => check.values.some((v) => v.toLowerCase() === x));
      const ok = hits.length >= (check.min ?? 1);
      return { check, ok, detail: ok ? `from the list: ${hits.join(", ")}` : `none of ${items.join(", ") || "(empty)"} is in the list` };
    }
    case "mermaid":
      // Needs the parser (async): scoreCases compiles it; a sync caller cannot judge it.
      return { check, ok: false, detail: "mermaid is judged by scoreCases (async)" };
  }
}

/** Compile the output with the real Mermaid parser (loaded on demand, like the diagrammer's validator). */
async function runMermaidCheck(check: Check, output: unknown): Promise<CheckResult> {
  const { checkMermaid } = await import("../tools/validate");
  const r = await checkMermaid(textOf(output));
  return { check, ok: r.ok, detail: r.ok ? `compiles${r.diagramType ? ` (${r.diagramType})` : ""}` : `does not compile: ${(r.error ?? "").split("\n")[0]}` };
}

export interface CaseResult {
  id: string;
  agent: string;
  status: "ok" | "failed" | "skipped";
  executor: string | null;
  model: string | null;
  attempts: number;
  ms: number;
  checks: CheckResult[];
  error?: string;
}

/** A case passes when the run succeeded and every check holds. */
export function passed(r: CaseResult): boolean {
  return r.status === "ok" && r.checks.every((c) => c.ok);
}

export async function scoreCases(output: unknown, checks: Check[]): Promise<CheckResult[]> {
  return Promise.all(checks.map((c) => (c.type === "mermaid" ? runMermaidCheck(c, output) : runCheck(c, output))));
}

/** Markdown report: one summary line and a table, in the order run. */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * The eval report as one self-contained HTML page (7.3.3): a summary per
 * agent, then every case with its failed checks. No scripts, no network.
 */
export function formatEvalHtml(results: CaseResult[], meta: { model: string; url: string; date: string }): string {
  const ran = results.filter((r) => r.status !== "skipped");
  const ok = ran.filter(passed).length;
  const agents = [...new Set(results.map((r) => r.agent))].sort();
  const rows = agents
    .map((a) => {
      const mine = ran.filter((r) => r.agent === a);
      const pass = mine.filter(passed).length;
      return `<tr><td>${esc(a)}</td><td>${pass}/${mine.length}</td><td class="${pass === mine.length ? "ok" : "bad"}">${pass === mine.length ? "pass" : "FAIL"}</td></tr>`;
    })
    .join("\n");
  const cases = results
    .map((r) => {
      const res = r.status === "skipped" ? "skipped" : passed(r) ? "pass" : "FAIL";
      const notes = r.error ?? r.checks.filter((c) => !c.ok).map((c) => `${c.check.type}: ${c.detail}`).join("; ");
      return `<tr><td>${esc(r.id)}</td><td>${esc(r.agent)}</td><td class="${res === "pass" ? "ok" : res === "FAIL" ? "bad" : ""}">${res}</td><td>${r.attempts}</td><td>${(r.ms / 1000).toFixed(1)} s</td><td>${esc(notes || "—")}</td></tr>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Agent eval — ${esc(meta.model)}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#1f2328}table{border-collapse:collapse;margin:12px 0}td,th{border:1px solid #d0d7de;padding:4px 8px;text-align:start;vertical-align:top}th{background:#f6f8fa}.ok{color:#1a7f37}.bad{color:#cf222e;font-weight:600}</style>
</head><body>
<h1>Agent eval — ${esc(meta.model)}</h1>
<p>${esc(meta.date)} · ${esc(meta.url)} · <strong>${ok}/${ran.length} passed</strong> · ${agents.length} agents</p>
<h2>By agent</h2>
<table><tr><th>agent</th><th>passed</th><th></th></tr>
${rows}
</table>
<h2>Cases</h2>
<table><tr><th>case</th><th>agent</th><th>result</th><th>attempts</th><th>time</th><th>notes</th></tr>
${cases}
</table>
</body></html>
`;
}

export function formatEvalReport(results: CaseResult[], meta: { model: string; url: string; date: string }): string {
  const ran = results.filter((r) => r.status !== "skipped");
  const ok = ran.filter(passed).length;
  const ms = ran.reduce((a, r) => a + r.ms, 0);
  const lines = [
    `# Agent eval — ${meta.model}`,
    "",
    `${meta.date} · ${meta.url} · **${ok}/${ran.length} passed** · ${(ms / 1000).toFixed(1)} s total`,
    "",
    "| Case | Agent | Result | Attempts | Time | Notes |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    const res = r.status === "skipped" ? "skipped" : passed(r) ? "pass" : "FAIL";
    const notes = r.error ?? r.checks.filter((c) => !c.ok).map((c) => `${c.check.type}: ${c.detail}`).join("; ");
    lines.push(`| ${r.id} | ${r.agent} | ${res} | ${r.attempts} | ${(r.ms / 1000).toFixed(1)} s | ${(notes || "—").replace(/\|/g, "\\|")} |`);
  }
  return lines.join("\n") + "\n";
}
