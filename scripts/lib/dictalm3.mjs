/**
 * DictaLM 3.0 in the Hebrew model catalogue (plan W2.4): the rules behind
 * scripts/dictalm3.mjs, kept pure so src/__tests__/dictalm3.test.ts can pin
 * them.
 *
 * - A variant is ready to evaluate only when nothing about it is unverified:
 *   repo, Ollama name, both revisions and a verified licence whose class is
 *   allowed or conditional (models/registry.json classes, gate 0.10).
 * - A run's score is the percentage of non-skipped cases that passed, the
 *   same rule as scripts/eval-compare.mjs, per eval kind: `agents` (the agent
 *   eval, 7.3) and `prompts` (the Hebrew prompt eval). A model's score is
 *   the mean of the two kinds it has.
 * - A variant replaces the current default only with an allowed licence and
 *   a score at least `minGainPoints` above the model it is compared with.
 */

/** @typedef {{ name: string|null, class: string, verified: boolean, source: string }} Licence */
/**
 * @typedef {{ size: string, base: string, repo: string|null, revision: string|null,
 *   ollama: string|null, ollamaRevision: string|null, licence: Licence, ramGB: number,
 *   compareWith: string, tools?: boolean, runtimes: Record<string,string>, ownerChecks: string[] }} Variant
 */

const SHA = /^[0-9a-f]{40}$/;
const CLASSES = ["allowed", "conditional", "forbidden", "unknown"];

/** Problems with the manifest's shape (empty when it is well-formed). */
export function validateManifest(m) {
  const problems = [];
  if (!m || !Array.isArray(m.variants) || !m.variants.length) return ["no variants"];
  if (typeof m.minGainPoints !== "number" || m.minGainPoints < 5) problems.push("minGainPoints must be a number ≥ 5 (plan W2.4)");
  const sizes = new Set();
  for (const v of m.variants) {
    const at = v?.size ?? "(no size)";
    if (typeof v?.size !== "string") problems.push(`${at}: missing size`);
    else if (sizes.has(v.size)) problems.push(`${at}: duplicate size`);
    sizes.add(v?.size);
    for (const f of ["repo", "revision", "ollama", "ollamaRevision"]) {
      if (v?.[f] !== null && typeof v?.[f] !== "string") problems.push(`${at}: ${f} must be a string or null`);
    }
    for (const f of ["revision", "ollamaRevision"]) if (typeof v?.[f] === "string" && !SHA.test(v[f])) problems.push(`${at}: ${f} must be a 40-character commit sha`);
    if (typeof v?.repo === "string" && !/^dicta-il\/DictaLM-3\.0-[\w.-]+$/.test(v.repo)) problems.push(`${at}: repo must be an official dicta-il/DictaLM-3.0-* repository`);
    if (typeof v?.ollama === "string" && !/^hf\.co\/[\w.-]+\/[\w.-]+(:[\w.-]+)?$/.test(v.ollama)) problems.push(`${at}: ollama must be an hf.co/<owner>/<repo>[:quant] name`);
    const l = v?.licence;
    if (!l || !CLASSES.includes(l.class) || typeof l.verified !== "boolean") problems.push(`${at}: licence needs class (${CLASSES.join("|")}) and verified`);
    else if (l.verified && (!l.name || l.class === "unknown")) problems.push(`${at}: a verified licence needs its name and a known class`);
    if (typeof v?.compareWith !== "string" || !v.compareWith) problems.push(`${at}: missing compareWith`);
    if (!Array.isArray(v?.ownerChecks)) problems.push(`${at}: ownerChecks must be a list`);
  }
  return problems;
}

/** What still blocks a variant (empty = ready to evaluate). Derived from the data, not from the ownerChecks text. */
export function openChecks(v) {
  const open = [];
  if (!v.repo) open.push("repo");
  if (!v.revision) open.push("revision");
  if (!v.ollama) open.push("ollama");
  if (!v.ollamaRevision) open.push("ollamaRevision");
  if (!v.licence?.verified) open.push("licence");
  else if (v.licence.class === "forbidden") open.push("licence is forbidden — do not include");
  return open;
}

/** Percentage (0–100) of non-skipped cases that passed in one eval run, or null without cases. */
export function scoreRun(run) {
  const rs = (run?.results ?? []).filter((r) => r.status !== "skipped");
  if (!rs.length) return null;
  const ok = rs.filter((r) => r.status === "ok" && (r.checks ?? []).every((c) => c.ok)).length;
  return (100 * ok) / rs.length;
}

/** eval/results file name slug for a model, as live.eval.ts / prompts.eval.ts write it. */
export const modelSlug = (model) => String(model).replace(/[^\w.-]+/g, "_");

/**
 * The newest run per kind for `model` among `files` ([{ name, json }]),
 * named `<kind>-<YYYY-MM-DD>-<slug>.json`. → { agents?: run, prompts?: run }
 */
export function latestRuns(files, model) {
  const slug = modelSlug(model);
  /** @type {Record<string, { date: string, json: any }>} */
  const best = {};
  for (const f of files) {
    const m = /^(agents|prompts)-(\d{4}-\d{2}-\d{2})-(.+)\.json$/.exec(f.name);
    if (!m || m[3] !== slug) continue;
    if (f.json?.model !== undefined && modelSlug(f.json.model) !== slug) continue;
    if (!best[m[1]] || best[m[1]].date < m[2]) best[m[1]] = { date: m[2], json: f.json };
  }
  return Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.json]));
}

/** { agents, prompts, score } — score is the mean of the kinds present, null if none. */
export function modelScore(runs) {
  const agents = runs.agents ? scoreRun(runs.agents) : null;
  const prompts = runs.prompts ? scoreRun(runs.prompts) : null;
  const parts = [agents, prompts].filter((x) => x !== null);
  return { agents, prompts, score: parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null };
}

/**
 * The verdict for one variant against the model it is compared with.
 * → { size, verdict: "blocked"|"no-results"|"keep"|"switch"|"offer", gain, reason, candidate, current }
 *   switch = becomes the default for its RAM tier; offer = listed (with its
 *   licence notice when conditional) but never the default; keep = the
 *   current default stays.
 */
export function decide(v, files, minGainPoints) {
  const base = { size: v.size, candidate: null, current: null, gain: null };
  const open = openChecks(v);
  if (open.length) return { ...base, verdict: "blocked", reason: `owner checks open: ${open.join(", ")}` };
  const candidate = modelScore(latestRuns(files, v.ollama));
  const current = modelScore(latestRuns(files, v.compareWith));
  const withScores = { ...base, candidate, current };
  if (candidate.score === null || current.score === null) {
    const missing = [candidate.score === null ? v.ollama : null, current.score === null ? v.compareWith : null].filter(Boolean);
    return { ...withScores, verdict: "no-results", reason: `no eval results for ${missing.join(" and ")} in eval/results` };
  }
  const gain = candidate.score - current.score;
  const out = { ...withScores, gain };
  if (v.licence.class !== "allowed") return { ...out, verdict: "offer", reason: `licence ${v.licence.name} is ${v.licence.class}: offered with its notice, never a default` };
  if (gain >= minGainPoints) return { ...out, verdict: "switch", reason: `${fmt(candidate.score)} vs ${fmt(current.score)} for ${v.compareWith}: +${fmt(gain)} ≥ ${minGainPoints} points` };
  return { ...out, verdict: "keep", reason: `${fmt(candidate.score)} vs ${fmt(current.score)} for ${v.compareWith}: ${gain >= 0 ? "+" : ""}${fmt(gain)} < ${minGainPoints} points` };
}

const fmt = (x) => (Math.round(x * 10) / 10).toFixed(1);

/**
 * The OLLAMA_CATALOG line (src/ai/modelCatalog.ts) a verdict asks for, or
 * null when the catalog should not change. `measured` is the 0–1 Hebrew
 * score the catalog ranks by; only a "switch" drops `recommend: false`.
 */
export function catalogLine(v, d) {
  if (d.verdict !== "switch" && d.verdict !== "offer" && d.verdict !== "keep") return null;
  const measured = d.candidate?.score == null ? "null" : String(Math.round(d.candidate.score * 10) / 1000);
  const licClass = v.licence.class === "allowed" ? "allowed" : "conditional";
  const recommend = d.verdict === "switch" ? "" : ", recommend: false";
  return `  { name: "${v.ollama}", label: "DictaLM 3.0 ${v.size} (Hebrew)", params: ${parseFloat(v.size)}, ramGB: ${v.ramGB}, hebrew: "strong", tools: ${v.tools === true}, measured: ${measured}, note: "Dicta's Hebrew model (eval ${d.verdict})", licence: { class: "${licClass}", name: "${v.licence.name}" }${recommend} },`;
}
