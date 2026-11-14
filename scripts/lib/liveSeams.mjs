/**
 * Live seams (coordinator decision R4.1, wave 10 stage C): a `register*` or
 * `set*` hook that only tests call is a dead seam — an engine, model or
 * transcriber the app never plugs in, so the feature silently runs its
 * fallback (audit: setVoiceTranscriber, setLectureSummarizer,
 * registerGrammarRanker, setOrganizerModel, …).
 *
 * `deadSeams(srcDir)` lists every exported `register[A-Z]…` / `set[A-Z]…`
 * function or const in production code (src/ minus tests, stories and
 * declarations) that no other production line names. A re-export
 * (`export { x } from`) and a comment are not callers.
 *
 * `checkSeams(srcDir, exceptions)` applies the allow list (scripts/seams.allow.json): a dead seam
 * not listed fails; a listed seam that is live now fails too (stale entry:
 * remove it), so the list only shrinks. Each entry says why: `test-only`
 * (a knob for tests, never an app seam) or `pending` with the plan task
 * that wires it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const isProduction = (p) => /\.(ts|tsx)$/.test(p) && !/\.d\.ts$/.test(p) && !/\.(test|spec|stories)\.tsx?$/.test(p) && !p.split(/[\\/]/).includes("__tests__");

export function productionSources(srcDir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__" && e.name !== "node_modules") walk(p);
      } else if (isProduction(p)) out.push(p);
    }
  };
  walk(srcDir);
  return out.sort();
}

/** Comments out, strings kept (a name in a string is not a call, but rare enough). */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const DEF = /\bexport\s+(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+)((?:register|set)[A-Z]\w*)\b/g;

/** Every exported seam → { name, file, line }, and every dead one (no production caller). */
export function deadSeams(srcDir) {
  const files = productionSources(srcDir).map((f) => ({ file: relative(srcDir, f).split("\\").join("/"), text: stripComments(readFileSync(f, "utf8")) }));
  const seams = [];
  for (const { file, text } of files) {
    for (const m of text.matchAll(DEF)) seams.push({ name: m[1], file, line: text.slice(0, m.index).split("\n").length });
  }
  const dead = [];
  for (const s of seams) {
    const word = new RegExp(`\\b${s.name}\\b`);
    let used = false;
    for (const { file, text } of files) {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && !used; i++) {
        const l = lines[i];
        if (!word.test(l)) continue;
        if (file === s.file && i + 1 === s.line) continue; // its definition
        if (/^\s*export\s*(type\s*)?\{[^}]*\}\s*from\b/.test(l)) continue; // a re-export
        used = true;
      }
      if (used) break;
    }
    if (!used) dead.push(s);
  }
  return { seams, dead };
}

/**
 * The seams that may stay without a production caller, each with its reason,
 * from scripts/seams.allow.json (W11.I1). Every entry has:
 * `kind` — `pending` (the plan task wires it), `test-only` (a knob for tests,
 * not an engine the app plugs in) or `dead` (an API nothing uses: the task
 * wires or deletes it; it is never silently fine);
 * `task` — the plan id that closes it; `reason`; and `expires` (YYYY-MM-DD,
 * at most MAX_ALLOW_DAYS ahead). On its expiry day the entry fails the gate,
 * so an exception is reviewed instead of living forever.
 */
export const ALLOW_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "seams.allow.json");
export const MAX_ALLOW_DAYS = 183;
export function loadAllowList(file = ALLOW_FILE) {
  return JSON.parse(readFileSync(file, "utf8")).seams;
}
export const LIVE_SEAM_EXCEPTIONS = loadAllowList();

const DAY = 86_400_000;
/** Problems with one entry's own fields, judged on `today` (YYYY-MM-DD, UTC). */
export function entryProblems(name, e, today) {
  const out = [];
  if (!["pending", "test-only", "dead"].includes(e?.kind)) out.push(`${name}: kind must be pending, test-only or dead`);
  if (!/^W\d+\.\w+$/.test(e?.task ?? "")) out.push(`${name}: an allow-list entry needs the plan task that closes it`);
  if (typeof e?.reason !== "string" || e.reason.trim().length < 6) out.push(`${name}: an allow-list entry needs its reason`);
  const exp = /^\d{4}-\d{2}-\d{2}$/.test(e?.expires ?? "") ? Date.parse(`${e.expires}T00:00:00Z`) : NaN;
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(exp)) out.push(`${name}: an allow-list entry needs an expiry date (YYYY-MM-DD)`);
  else if (exp <= now) out.push(`${name}: the allow-list entry expired on ${e.expires}: wire the seam, delete it, or review the entry`);
  else if (exp - now > MAX_ALLOW_DAYS * DAY) out.push(`${name}: expires ${e.expires}, more than ${MAX_ALLOW_DAYS} days ahead`);
  return out;
}

const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

export function checkSeams(srcDir, exceptions = LIVE_SEAM_EXCEPTIONS, { today = isoDay(Date.now()) } = {}) {
  const { seams, dead } = deadSeams(srcDir);
  const problems = [];
  const deadNames = new Set(dead.map((d) => d.name));
  for (const d of dead) {
    const e = exceptions[d.name];
    if (!e) problems.push({ ...d, rule: "dead-seam", text: `${d.name} has no caller outside tests: wire it in the app, or delete it` });
    else for (const text of entryProblems(d.name, e, today)) problems.push({ ...d, rule: "live-seam-allow", text });
  }
  const known = new Set(seams.map((s) => s.name));
  for (const name of Object.keys(exceptions)) {
    if (!known.has(name)) problems.push({ name, file: "scripts/seams.allow.json", line: 0, rule: "live-seam-stale", text: `${name} is listed in seams.allow.json but no longer exists: remove the entry` });
    else if (!deadNames.has(name)) problems.push({ name, file: "scripts/seams.allow.json", line: 0, rule: "live-seam-stale", text: `${name} has a production caller now: remove it from seams.allow.json` });
  }
  return { seams, dead, problems };
}
