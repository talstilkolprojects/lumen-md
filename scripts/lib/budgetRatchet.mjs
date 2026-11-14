/**
 * A budget that only goes down (plan W6.26). Plain JavaScript, shared by
 * scripts/bundle-budget.mjs, scripts/budget-ratchet.mjs, scripts/pr-check.mjs
 * and their tests.
 *
 * - `ratchet`: after a train, each bundle budget becomes the measured size
 *   plus the margin when that is lower than today's budget. Never higher.
 * - `budgetRaises`: what a change to scripts/bundle-budgets.json loosens.
 *   It compares the budget each chunk name gets before and after (first
 *   matching rule wins), so a raised number, a new wider rule, a removed
 *   rule whose files fall to a bigger one, a reordering and an extended
 *   exception all count.
 * - `expiredExceptions`: a rule with `expires` is an exception; past its
 *   date the budget fails until it is lowered or decided again.
 * - The same for the performance gate's FCP and LCP limits
 *   (perf-gate.config.json, plan 8.3) and lighthouserc.json.
 */

export const BUDGETS_PATH = "scripts/bundle-budgets.json";
export const PERF_CONFIG_PATH = "perf-gate.config.json";
export const LIGHTHOUSE_PATH = "lighthouserc.json";
/** Lighthouse's mobile run (W10.E9): the same rules as the desktop file. */
export const LIGHTHOUSE_MOBILE_PATH = "lighthouserc.mobile.json";
/** The files whose history must only go down (`npm run budget:history`). */
export const RATCHET_FILES = [BUDGETS_PATH, PERF_CONFIG_PATH, LIGHTHOUSE_PATH, LIGHTHOUSE_MOBILE_PATH];
/** The performance metrics in the ratchet (W6.26 step 4). */
export const PERF_METRICS = ["fcp", "lcp"];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Problems with a budgets file's shape: [] when it is fine. */
export function validateBudgets(b) {
  const out = [];
  if (!b || typeof b !== "object") return ["not an object"];
  if (!(b.startup?.budgetKb > 0)) out.push("startup.budgetKb must be a positive number");
  if (!Array.isArray(b.rules) || !b.rules.length) return [...out, "rules must be a non-empty list"];
  const names = new Set();
  for (const [i, r] of b.rules.entries()) {
    const at = `rules[${i}]${r?.name ? ` (${r.name})` : ""}`;
    if (typeof r?.name !== "string" || !r.name) out.push(`${at}: no name`);
    else if (names.has(r.name)) out.push(`${at}: the name is used twice`);
    else names.add(r.name);
    try {
      new RegExp(r?.pattern);
      if (typeof r?.pattern !== "string") throw new Error();
    } catch {
      out.push(`${at}: pattern is not a regular expression`);
    }
    if (!(r?.budgetKb > 0)) out.push(`${at}: budgetKb must be a positive number`);
    if (r?.expires != null || r?.task != null) {
      if (!DATE.test(String(r.expires ?? ""))) out.push(`${at}: an exception needs expires as YYYY-MM-DD`);
      if (typeof r.task !== "string" || !r.task) out.push(`${at}: an exception needs the task that removes it`);
    }
  }
  return out;
}

/** The rules with regular expressions, in order. */
export const compile = (b) => b.rules.map((r) => ({ ...r, re: new RegExp(r.pattern) }));

/** Exceptions whose date has passed: today is YYYY-MM-DD (the day after `expires` fails). */
export function expiredExceptions(b, today) {
  return b.rules.filter((r) => r.expires && r.expires < today).map((r) => ({ name: r.name, expires: r.expires, task: r.task, budgetKb: r.budgetKb }));
}

/** Today in UTC as YYYY-MM-DD; LUMEN_TODAY overrides it (tests, a rerun of an old build). */
export const today = (env = process.env, now = new Date()) => (DATE.test(env.LUMEN_TODAY ?? "") ? env.LUMEN_TODAY : now.toISOString().slice(0, 10));

/** measured × (1 + pct %), at least measured + minKb, up to the next whole KB. */
export function withMargin(measured, margin = { pct: 2, minKb: 1 }) {
  const headroom = Math.max((measured * (margin.pct ?? 2)) / 100, margin.minKb ?? 0);
  return Math.ceil(measured + headroom - 1e-9);
}

/**
 * The measured numbers of one build, from `bundle-budget.mjs --json` (the
 * budget gate's receipt, reports/bundle-sizes.json): the biggest file per
 * rule, since each rule limits each file, and the startup total.
 */
export function measuredFromSizes(sizes) {
  const rules = {};
  let startupKb = null;
  for (const [name, c] of Object.entries(sizes?.classes ?? {})) {
    if (name === "startup total") startupKb = c.kb;
    else if (typeof c.maxKb === "number") rules[name] = c.maxKb;
  }
  return { startupKb, rules };
}

/** The first-party startup KB from the offline measure's log line ("startup first-party: 218.0 KB gz, …"), or null. */
export function parseFirstParty(text) {
  const m = /startup first-party:\s*([\d.]+)\s*KB/.exec(String(text));
  return m ? Number(m[1]) : null;
}

/**
 * Lower every budget the build measured to measured + margin when that is
 * lower. → { budgets, changes: [{ name, before, after, measured }], unmeasured: [names] }.
 * `entry` (optional) is appended to `history` when something changed.
 */
export function ratchet(b, measured, entry = null) {
  const margin = b.margin ?? { pct: 2, minKb: 1 };
  const changes = [];
  const unmeasured = [];
  const rules = b.rules.map((r) => {
    const m = measured.rules?.[r.name];
    if (typeof m !== "number") {
      unmeasured.push(r.name);
      return r;
    }
    const next = withMargin(m, margin);
    if (next >= r.budgetKb) return r;
    changes.push({ name: r.name, before: r.budgetKb, after: next, measured: m });
    return { ...r, budgetKb: next };
  });
  let startup = b.startup;
  if (typeof measured.startupKb === "number") {
    const next = withMargin(measured.startupKb, margin);
    if (next < b.startup.budgetKb) {
      changes.push({ name: "startup total", before: b.startup.budgetKb, after: next, measured: measured.startupKb });
      startup = { ...b.startup, budgetKb: next };
    }
  } else unmeasured.push("startup total");
  const history = changes.length && entry ? [...(b.history ?? []), { ...entry, lowered: changes.map((c) => `${c.name} ${c.before} → ${c.after}`) }] : b.history;
  return { budgets: { ...b, startup, rules, ...(history ? { history } : {}) }, changes, unmeasured };
}

/** A file name a rule's pattern certainly matches, for the simple prefix/suffix patterns this file uses (else null). */
export function sampleName(pattern) {
  let s = String(pattern);
  const anchored = s.startsWith("^");
  if (anchored) s = s.slice(1);
  const jsEnd = s.endsWith("\\.js$");
  if (jsEnd) s = s.slice(0, -5);
  else if (s.endsWith("$")) return null;
  // Only literal text (escaped dots allowed) is understood.
  if (/[\\](?![.])|[[\](){}*+?|^$]/.test(s)) return null;
  const lit = s.replace(/\\\./g, ".");
  const name = `${anchored ? "" : "x"}${lit}${lit.endsWith("-") || !lit ? "" : "-"}Ab12Cd34.js`;
  return new RegExp(pattern).test(name) ? name : null;
}

/** The budget the first matching rule gives `file`, or null. */
const budgetOf = (rules, file) => rules.find((r) => r.re.test(file)) ?? null;

/**
 * What `after` loosens compared to `before` → [{ what, before, after, why }].
 * Empty when every chunk's budget, the startup budget, every exception's
 * date and the margin stayed or went down.
 */
export function budgetRaises(before, after) {
  const out = [];
  if (after.startup?.budgetKb > before.startup?.budgetKb) out.push({ what: "startup total", before: before.startup.budgetKb, after: after.startup.budgetKb, why: "raised" });
  const bm = before.margin ?? {};
  const am = after.margin ?? {};
  if ((am.pct ?? 0) > (bm.pct ?? 0) || (am.minKb ?? 0) > (bm.minKb ?? 0)) out.push({ what: "ratchet margin", before: `${bm.pct}% / ${bm.minKb} KB`, after: `${am.pct}% / ${am.minKb} KB`, why: "a wider margin" });
  const B = compile(before);
  const A = compile(after);
  const samples = new Map();
  for (const r of [...B, ...A]) {
    const s = sampleName(r.pattern);
    if (s) samples.set(s, r.name);
    else if (!B.some((x) => x.name === r.name && x.pattern === r.pattern)) out.push({ what: r.name, before: null, after: r.budgetKb, why: `pattern ${r.pattern} is not a plain prefix: the check can't tell what it covers` });
  }
  for (const [file] of samples) {
    const b = budgetOf(B, file);
    const a = budgetOf(A, file);
    if (!a || !b) continue;
    if (a.budgetKb > b.budgetKb) out.push({ what: a.name === b.name ? a.name : `${file} (${b.name} → ${a.name})`, before: b.budgetKb, after: a.budgetKb, why: a.name === b.name ? "raised" : "falls to a bigger rule" });
  }
  for (const b of before.rules) {
    if (!b.expires) continue;
    const a = after.rules.find((x) => x.name === b.name);
    if (!a) continue; // removed: its files fall to another rule, checked above
    if (!a.expires) out.push({ what: b.name, before: b.expires, after: "no date", why: "an exception lost its expiry date" });
    else if (a.expires > b.expires) out.push({ what: b.name, before: b.expires, after: a.expires, why: "an exception's expiry moved later" });
  }
  // One line per loosened rule, however many sample names showed it.
  const seen = new Set();
  return out.filter((x) => {
    const k = `${x.what}|${x.why}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

/**
 * Lower the perf gate's FCP/LCP limits (error and warn levels of every
 * profile) to the median run + margin when that is lower. `report` is
 * `perf-gate.mjs --json`. → { config, changes }.
 */
export function ratchetPerf(config, report, margin = { pct: 2, minMs: 50 }) {
  const changes = [];
  const profiles = { ...config.profiles };
  for (const p of report?.profiles ?? []) {
    const prof = profiles[p.name];
    if (!prof || !p.median) continue;
    const assert = { ...prof.assert };
    for (const metric of PERF_METRICS) {
      const m = p.median[metric];
      if (typeof m !== "number" || !assert[metric]) continue;
      const next = Math.ceil(m + Math.max((m * margin.pct) / 100, margin.minMs));
      const a = { ...assert[metric] };
      for (const level of ["error", "warn"]) {
        if (typeof a[level] === "number" && next < a[level]) {
          changes.push({ name: `${p.name} ${metric} ${level}`, before: a[level], after: next, measured: m });
          a[level] = next;
        }
      }
      assert[metric] = a;
    }
    profiles[p.name] = { ...prof, assert };
  }
  return { config: { ...config, profiles }, changes };
}

/** What a change to perf-gate.config.json loosens: a limit raised or dropped, an error level turned into warn. */
export function perfRaises(before, after) {
  const out = [];
  for (const [name, bp] of Object.entries(before?.profiles ?? {})) {
    const ap = after?.profiles?.[name];
    for (const [metric, b] of Object.entries(bp.assert ?? {})) {
      const a = ap?.assert?.[metric] ?? {};
      for (const level of ["error", "warn"]) {
        if (typeof b[level] !== "number") continue;
        const what = `${name} ${metric} ${level}`;
        if (typeof a[level] === "number") {
          if (a[level] > b[level]) out.push({ what, before: b[level], after: a[level], why: "raised" });
        } else if (level === "error" && typeof a.warn === "number") out.push({ what, before: b.error, after: `warn ${a.warn}`, why: "an error limit became a warning" });
        else if (!(level === "warn" && typeof a.error === "number" && a.error <= b.warn)) out.push({ what, before: b[level], after: "none", why: "the limit was removed" });
      }
    }
  }
  if ((after?.runs ?? 0) < (before?.runs ?? 0)) out.push({ what: "runs", before: before.runs, after: after.runs, why: "fewer runs per profile" });
  return out;
}

const LEVEL = { off: 0, warn: 1, error: 2 };

/** What a change to lighthouserc.json loosens: a level lowered, a maxNumericValue raised, a minScore lowered, an assertion dropped. */
export function lighthouseRaises(before, after) {
  const out = [];
  const norm = (v) => (Array.isArray(v) ? { level: v[0], ...(v[1] ?? {}) } : { level: v });
  const ba = before?.ci?.assert?.assertions ?? {};
  const aa = after?.ci?.assert?.assertions ?? {};
  for (const [k, v] of Object.entries(ba)) {
    const b = norm(v);
    if (!(k in aa)) {
      if (b.level !== "off") out.push({ what: k, before: b.level, after: "none", why: "the assertion was removed" });
      continue;
    }
    const a = norm(aa[k]);
    if ((LEVEL[a.level] ?? 0) < (LEVEL[b.level] ?? 0)) out.push({ what: k, before: b.level, after: a.level, why: "a lower level" });
    if (typeof b.maxNumericValue === "number" && (a.maxNumericValue ?? Infinity) > b.maxNumericValue) out.push({ what: k, before: b.maxNumericValue, after: a.maxNumericValue ?? "none", why: "maxNumericValue raised" });
    if (typeof b.minScore === "number" && (a.minScore ?? 0) < b.minScore) out.push({ what: k, before: b.minScore, after: a.minScore ?? "none", why: "minScore lowered" });
  }
  return out;
}

/** The loosening check for one of RATCHET_FILES, by path. Parse errors count as a raise. */
export function raisesFor(path, beforeText, afterText) {
  let before;
  let after;
  try {
    before = JSON.parse(beforeText);
  } catch {
    return []; // why: an unparsable old version has no limits to compare against
  }
  try {
    after = JSON.parse(afterText);
  } catch (e) {
    return [{ what: path, before: "JSON", after: "unparsable", why: String(e.message) }];
  }
  if (path === BUDGETS_PATH) return budgetRaises(before, after);
  if (path === PERF_CONFIG_PATH) return perfRaises(before, after);
  if (path === LIGHTHOUSE_PATH || path === LIGHTHOUSE_MOBILE_PATH) return lighthouseRaises(before, after);
  return [];
}

/** One Markdown line per raise. */
export const raiseLine = (path, x) => `- \`${path}\` ${x.what}: ${x.before ?? "none"} → ${x.after} (${x.why}).`;
