/**
 * Every owner command from every open PR, deduplicated and assigned (plan W6.20).
 *
 * Reads the owner sections of the open PRs' bodies ("## Owner commands",
 * "## Owner steps", "## Owner items", "## The owner's … step"), takes each
 * command (a line in a fenced block, an inline `code` span that starts with
 * a command, or a bullet that names a page to open), normalises it and
 * merges duplicates across PRs. Each unique item is then assigned:
 *
 *   a session step (scripts/owner/steps.mjs `covers`)  Tal does it in that step
 *   agent        a test or build run that agents do on the second host (W6.5) or in the Sandbox
 *   recurring    a loop that comes back with every train or merge (the coordinator runs it, or Tal per merge)
 *   coordinator  a change a lane or the coordinator makes in a PR (vercel.json, a pasted block, a follow-up task)
 *   people       needs other people (speakers, raters, external reviewers), scheduled outside the sittings
 *   deferred     optional and deferred (15.5 Drive/Dropbox OAuth, 15.6 monitoring)
 *   obsolete     a GitHub Actions run (the project doesn't use Actions, decided 9.11)
 *   none         the section says no owner action is needed
 *
 * Anything else is "unassigned": `npm run owner:session -- collect` lists it
 * and exits 1, so a new owner command can't be missed.
 */
import { STEPS } from "./steps.mjs";

export const OWNER_HEADING = /^#{2,3}[ \t]+[^\n]*\bowner(?:['’]s)?\b[^\n]*\b(?:commands?|steps?|items?)\b[^\n]*$/gim;
const CMD_START = /^(?:sudo |cd |export |[A-Z_]+=\S* )*(?:npm|npx|node|gh|git|cargo|bash|sh|curl|ollama|brew|pip3?|python3?|vercel|wrangler|fly|gcloud|firebase|keytool|openssl|ssh|scp|printf|mkdir|cp|rm|kaggle|winget|flatpak-builder|makepkg|shasum|for|\(|mlc_llm|optimum-cli|LUMEN_\w+=|\.\/gradlew)(?=\s|$)/;

/** The text of every owner section in a PR body (up to the next heading of the same or a higher level, or a rule). */
export function ownerSections(body) {
  const out = [];
  const text = String(body ?? "").replace(/\r\n/g, "\n");
  for (const m of text.matchAll(OWNER_HEADING)) {
    if (/decision|proposal|left for/i.test(m[0])) continue; // why: decisions were delegated to the coordinator (15.16)
    const level = m[0].match(/^#+/)[0].length;
    const stop = new RegExp(`^(?:#{1,${level}}[ \\t]|---\\s*$|🤖 Generated)`);
    const lines = [];
    let fence = false;
    for (const line of text.slice(m.index + m[0].length).split("\n")) {
      if (/^\s*```/.test(line)) fence = !fence;
      else if (!fence && stop.test(line)) break; // why: a `# comment` inside a shell block is not a heading
      lines.push(line);
    }
    out.push({ heading: m[0].replace(/^#+\s*/, ""), text: lines.join("\n").trim() });
  }
  return out;
}

/** Normalised form for deduplication: no trailing comment, collapsed spaces, `npx x@v` → `npx x`, `npm run a --` kept. */
export function normalise(cmd) {
  return cmd
    .replace(/\s+#\s.*$/, "")
    .replace(/\s+/g, " ")
    .replace(/\bnpx ([\w-]+)@[\w.^~-]+/g, "npx $1")
    .replace(/<this PR>|<n>|#\d{3}\b/g, "<pr>")
    .trim();
}

/** Commands and to-dos in one section → [{ text, kind: "command" | "step" | "none" }]. */
export function itemsOf(section) {
  const out = [];
  const t = section.text;
  if (/^(?:-\s*)?(?:none|nothing)\b/i.test(t) || /^None (?:required|needed|for this)/im.test(t)) out.push({ text: "None", kind: "none" });
  let inFence = false;
  let code = false; // why: a ```ts or ```json block is code to paste, not a command to run
  let buf = "";
  for (const raw of t.split("\n")) {
    const line = raw.trim();
    if (/^```/.test(line)) {
      inFence = !inFence;
      code = inFence && /^```\s*(?:ts|tsx|js|javascript|json|jsonc|toml|ya?ml)\b/i.test(line);
      continue;
    }
    if (inFence && code) continue;
    if (inFence) {
      if (!line || line.startsWith("#") || /^[{}"\]]/.test(line) || line === "JSON") continue; // why: comments and heredoc bodies are not commands
      buf = buf ? `${buf} ${line}` : line;
      if (buf.endsWith("\\")) {
        buf = buf.slice(0, -1);
        continue;
      }
      out.push({ text: buf, kind: "command" });
      buf = "";
      continue;
    }
    for (const m of line.matchAll(/`([^`\n]{4,})`/g)) if (CMD_START.test(m[1].trim())) out.push({ text: m[1].trim(), kind: "command" });
    const bullet = line.match(/^(?:[-*]|\d+\.)\s+(.*)$/);
    if (bullet && !/`/.test(bullet[1]) && !/^\S+(?:\s+\S+){0,3}:\s*$/.test(bullet[1]) && /\b(open|create|register|apply|export|record|install|run|time|check|merge|request|submit|add|copy|set)\b/i.test(bullet[1])) out.push({ text: bullet[1].replace(/\*\*/g, "").trim(), kind: "step" });
  }
  return out;
}

const AGENT = [
  /^npm run dev$/,
  /^(?:gh pr checkout|npm ci(?: &&| *$)|npx vitest|npx playwright (?:test|install)|npm run (?:typecheck|build|budget|hygiene|licenses|i18n:check|test)\b|node scripts\/(?:bundle-budget|grammar\/make-probe|scan-plugins)|.*eval-arabic-spell|npm --prefix packages\/\S+ test|git diff --exit-code|npm run perf:gate|npm run eval:(?:crosslingual)$)/,
  /Sandbox|after 1\.12|in the Sandbox|ci-docker|ci:docker/i,
];
const COORDINATOR = [/^vercel\.json$|headers:write|PRIVACY\.he\.md|Open migration tasks|printed catalogue line|follow-up task/i];
const PEOPLE = [/\/collaborators\/|second maintainer|Arabic speaker|raters|Discussions \(category Security\)|invite open-source|usability/i];
const DEFERRED = [/\b15\.5\b|\b15\.6\b|OAuth apps|VITE_SENTRY_DSN/];
const OBSOLETE = [/gh workflow run|workflow_dispatch/];
const RECURRING = [/pr:triage|pr:check|restack|train:(?:status|build)|budget:(?:ratchet|history)|plan:check|wip-strict|wipLimit|check-max-lines|docs-parity|docs:parity|git am |gh pr (?:view|comment)|release\.mjs prepare|npm run models:mirror -- --(?:check|verify)/];

/** Assign one item: a step id, "agent", "recurring", "none" or null (unassigned). */
export function assign(text, kind, steps = STEPS) {
  if (kind === "none") return "none";
  if (OBSOLETE.some((re) => re.test(text))) return "obsolete";
  if (DEFERRED.some((re) => re.test(text))) return "deferred";
  if (AGENT.some((re) => re.test(text))) return "agent";
  if (RECURRING.some((re) => re.test(text))) return "recurring";
  if (COORDINATOR.some((re) => re.test(text))) return "coordinator";
  if (PEOPLE.some((re) => re.test(text))) return "people";
  for (const s of steps) if (s.covers.some((c) => new RegExp(c, "i").test(text))) return s.id;
  return null;
}

/**
 * PRs → the deduplicated inbox.
 *   prs: [{ number, title, body }]
 * → { prs: n with a section, items: [{ text, kind, prs: [n…], to }], counts }
 */
export function collect(prs, steps = STEPS) {
  const byKey = new Map();
  let withSection = 0;
  for (const pr of prs) {
    const secs = ownerSections(pr.body);
    if (!secs.length) continue;
    withSection++;
    for (const sec of secs)
      for (const it of itemsOf(sec)) {
        const key = it.kind === "none" ? "None" : normalise(it.text);
        const cur = byKey.get(key) ?? { text: key, kind: it.kind, prs: [], to: assign(key, it.kind, steps) };
        if (!cur.prs.includes(pr.number)) cur.prs.push(pr.number);
        byKey.set(key, cur);
      }
  }
  const items = [...byKey.values()].map((x) => ({ ...x, prs: x.prs.sort((a, b) => a - b) })).sort((a, b) => String(a.to).localeCompare(String(b.to)) || a.text.localeCompare(b.text));
  const counts = {};
  for (const x of items) counts[x.to ?? "unassigned"] = (counts[x.to ?? "unassigned"] ?? 0) + 1;
  return { prs: withSection, items, counts };
}
