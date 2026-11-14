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
 * `checkSeams(srcDir, exceptions)` applies LIVE_SEAM_EXCEPTIONS: a dead seam
 * not listed fails; a listed seam that is live now fails too (stale entry:
 * remove it), so the list only shrinks. Each entry says why: `test-only`
 * (a knob for tests, never an app seam) or `pending` with the plan task
 * that wires it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

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
 * The seams that may stay without a production caller, each with its reason.
 * `pending`: the plan task that wires it (the entry goes when it does).
 * `test-only`: a knob for tests, not an engine the app plugs in.
 * `dead`: an API nothing uses and no task wires yet — named so the
 * coordinator decides (wire or delete); it is never silently fine.
 */
export const LIVE_SEAM_EXCEPTIONS = {
  setLectureSummarizer: { kind: "pending", task: "W10.C9", reason: "the verified lecture summary" },
  setOrganizerModel: { kind: "pending", task: "W10.C16", reason: "the organizer's local model" },
  setToolPermission: { kind: "pending", task: "W10.C2", reason: "per-tool MCP permissions from the servers screen" },
  registerGrammarRanker: { kind: "pending", task: "W10.B9", reason: "the model ranking of grammar findings" },
  setArgon2idImplementation: { kind: "pending", task: "W10.D5", reason: "hash-wasm's Argon2id once it is in the lockfile" },
  setKdfPolicyForTests: { kind: "test-only", reason: "cheap KDF costs for tests" },
  setGrammarDebounce: { kind: "test-only", reason: "a zero debounce for tests" },
  setPythonWorkerFactory: { kind: "test-only", reason: "a fake Pyodide worker for tests" },
  registerLocalTranslator: { kind: "dead", reason: "a local translator for cross-lingual passages: no engine registers one" },
  registerPluginSkill: { kind: "dead", reason: "skills from plugins: the plugin host does not call it" },
  setPublishedSlug: { kind: "dead", reason: "the publish dialog does not set a slug through it" },
  setSyncStatus: { kind: "dead", reason: "the sync engines do not report through it" },
  setEncryptionPassword: { kind: "dead", reason: "changing the at-rest password: no UI calls it" },
};

export function checkSeams(srcDir, exceptions = LIVE_SEAM_EXCEPTIONS) {
  const { seams, dead } = deadSeams(srcDir);
  const problems = [];
  const deadNames = new Set(dead.map((d) => d.name));
  for (const d of dead) {
    const e = exceptions[d.name];
    if (!e) problems.push({ ...d, rule: "dead-seam", text: `${d.name} has no caller outside tests: wire it in the app, or delete it` });
    else if (e.kind === "pending" && !/^W\d+\.\w+$/.test(e.task ?? "")) problems.push({ ...d, rule: "dead-seam", text: `${d.name}: a pending seam needs the plan task that wires it` });
  }
  const known = new Set(seams.map((s) => s.name));
  for (const name of Object.keys(exceptions)) {
    if (!known.has(name)) problems.push({ name, file: "scripts/lib/liveSeams.mjs", line: 0, rule: "live-seam-stale", text: `${name} is listed in LIVE_SEAM_EXCEPTIONS but no longer exists: remove the entry` });
    else if (!deadNames.has(name)) problems.push({ name, file: "scripts/lib/liveSeams.mjs", line: 0, rule: "live-seam-stale", text: `${name} has a production caller now: remove it from LIVE_SEAM_EXCEPTIONS` });
  }
  return { seams, dead, problems };
}
