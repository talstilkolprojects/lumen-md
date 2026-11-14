/**
 * Pure logic of the licence gate (scripts/licenses.mjs): SPDX
 * classification, the production dependency walk over package-lock.json,
 * the model registry check, the eval-dataset check and the allowlist.
 * Everything that touches the disk is passed in, so the rules are tested
 * with fixtures (src/__tests__/licenses.test.ts).
 *
 * Levels, from best to worst: ok < notice < warn < fail. Any `fail`
 * makes the gate exit 1.
 */

export const LEVELS = ["ok", "notice", "warn", "fail"];
const RANK = { ok: 0, notice: 1, warn: 2, fail: 3 };
export const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);
export const best = (a, b) => (RANK[a] <= RANK[b] ? a : b);

// ── SPDX licences ──────────────────────────────────────────────────────

/** Permissive (or file-level copyleft that is fine to ship unmodified). */
const OK_IDS = new Set(
  [
    "MIT", "MIT-0", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause", "BSD-3-Clause-Clear", "Apache-2.0", "Apache-1.1",
    "Unlicense", "CC0-1.0", "CC-BY-3.0", "CC-BY-4.0", "BlueOak-1.0.0", "Zlib", "Python-2.0", "PSF-2.0", "OFL-1.1",
    // SPDX BSL-1.0 is the *Boost* Software License (permissive), not the Business Source License (BUSL-1.1).
    "BSL-1.0",
    "WTFPL", "MPL-1.1", "MPL-2.0", "EPL-1.0", "EPL-2.0", "CDDL-1.0", "CDDL-1.1", "Artistic-2.0", "X11", "W3C", "Ruby",
    "Unicode-DFS-2016", "Unicode-3.0", "AFL-2.1", "AFL-3.0", "Public Domain",
  ].map((s) => s.toLowerCase()),
);

/** Exceptions that turn a GPL into something an app may link against. */
/** Exact SPDX ids only: "Classpath-exception-2.0x" is a typo, not an exception. */
const LINKING_EXCEPTIONS = /^(Classpath-exception-2\.0|GCC-exception-(2\.0|3\.1)|LLVM-exception|Autoconf-exception-(2\.0|3\.0|generic)|Bison-exception-(1\.24|2\.2)|Font-exception-2\.0|Universal-FOSS-exception-1\.0)$/i;

/** Common non-SPDX spellings seen in package.json files. */
const ALIASES = {
  "apache 2.0": "Apache-2.0",
  "apache-2": "Apache-2.0",
  "apache license 2.0": "Apache-2.0",
  "apache license, version 2.0": "Apache-2.0",
  "apache2": "Apache-2.0",
  "mit license": "MIT",
  "the mit license": "MIT",
  "bsd-3": "BSD-3-Clause",
  "new bsd": "BSD-3-Clause",
  "public domain": "Public Domain",
};

/**
 * Long-form, non-SPDX names ("GNU General Public License v3.0", "GNU AGPL",
 * "Creative Commons Attribution-NonCommercial 4.0") → the SPDX family the
 * rules below know. Order matters: "Lesser/Library" and "Affero" names also
 * contain "General Public License".
 */
const LONG_FORMS = [
  { re: /\b(lesser|library)\s+general\s+public\s+licen[cs]e\b|\bgnu\s+lgpl/i, id: "LGPL" },
  { re: /\baffero\b|\bgnu\s+agpl/i, id: "AGPL" },
  { re: /\bgeneral\s+public\s+licen[cs]e\b|\bgnu\s+gpl/i, id: "GPL" },
  { re: /\bserver\s+side\s+public\s+licen[cs]e\b/i, id: "SSPL" },
  { re: /\bcreative\s+commons\b.*\bnon-?\s*commercial\b/i, id: "CC-BY-NC" },
];
/** A linking exception spelled out inside a long-form GPL name. */
const LONG_FORM_EXCEPTION = /\b(classpath|gcc|llvm|autoconf|bison|font|universal\s+foss|linking)\b[\s-]*(runtime\s+library\s+)?exception/i;

/** One licence id (with an optional WITH exception) → level + reason. */
export function classifyId(rawId, exception) {
  const aliased = ALIASES[rawId.toLowerCase()] ?? rawId;
  // Spaced Creative Commons abbreviations ("CC BY-NC 4.0", "CC0 1.0") → their SPDX form ("CC-BY-NC-4.0").
  const id = /^cc(0|[\s_]+by)\b/i.test(aliased.trim()) ? aliased.trim().replace(/[\s_]+/g, "-") : aliased;
  const lower = id.toLowerCase();
  if (/commons[\s-]*clause/i.test(id) || /commons[\s-]*clause/i.test(exception ?? "")) return { level: "fail", reason: "Commons Clause (no selling)" };
  if (/^lgpl/i.test(id)) return { level: "warn", reason: "weak copyleft (LGPL): must stay a separate, replaceable library" };
  if (/^a?gpl/i.test(id)) {
    if (exception && LINKING_EXCEPTIONS.test(exception)) return { level: "warn", reason: `GPL with a linking exception (${exception})` };
    return { level: "fail", reason: /^agpl/i.test(id) ? "strong network copyleft (AGPL)" : "strong copyleft (GPL)" };
  }
  if (/^sspl/i.test(id)) return { level: "fail", reason: "SSPL (not open source; service copyleft)" };
  if (/^busl/i.test(id) || /^bsl$/i.test(id) || /^bsl-1\.1$/i.test(id) || /business source/i.test(id)) return { level: "fail", reason: "Business Source License (no production use)" };
  if (/^elastic/i.test(id) || /^elv2$/i.test(id)) return { level: "fail", reason: "Elastic License (no managed service; not open source)" };
  if (/^cc-by-nc/i.test(id)) return { level: "fail", reason: "Creative Commons NonCommercial" };
  if (/^polyform-(noncommercial|strict)/i.test(id)) return { level: "fail", reason: "PolyForm non-commercial licence" };
  if (/^(cpal|eupl|osl|cc-by-sa|cc-by-nd|polyform)/i.test(id)) return { level: "warn", reason: "copyleft / restricted licence: needs a decision" };
  if (OK_IDS.has(lower)) return { level: "ok", reason: "" };
  const long = LONG_FORMS.find((f) => f.re.test(id));
  if (long) {
    const spelled = exception === undefined && /GPL$/.test(long.id) ? id.match(LONG_FORM_EXCEPTION)?.[0] : undefined;
    const r = spelled ? { level: "warn", reason: `GPL with a linking exception (${spelled})` } : classifyId(long.id, exception);
    return { level: r.level, reason: `${r.reason} (non-SPDX name "${id}")` };
  }
  return { level: "warn", reason: `unrecognised licence id "${id}"` };
}

/** Tokens of an SPDX expression: ids, parentheses, AND / OR / WITH. */
export function tokenize(expr) {
  return expr
    .replace(/[()]/g, (p) => ` ${p} `)
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (/^(and|or|with)$/i.test(t) ? t.toUpperCase() : t));
}

/** SPDX expression → tree. WITH binds tightest, then AND, then OR. Throws on malformed input. */
export function parseSpdx(expr) {
  const tokens = tokenize(expr);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  function primary() {
    const t = next();
    if (t === undefined) throw new Error("unexpected end");
    if (t === "(") {
      const node = or();
      if (next() !== ")") throw new Error("missing )");
      return node;
    }
    if (t === ")" || t === "AND" || t === "OR" || t === "WITH") throw new Error(`unexpected ${t}`);
    const node = { type: "id", id: t.replace(/\+$/, "-or-later") };
    if (peek() === "WITH") {
      next();
      const ex = next();
      if (!ex || ex === "(" || ex === ")") throw new Error("missing exception");
      node.exception = ex;
    }
    return node;
  }
  function and() {
    let left = primary();
    while (peek() === "AND") {
      next();
      left = { type: "and", left, right: primary() };
    }
    return left;
  }
  function or() {
    let left = and();
    while (peek() === "OR") {
      next();
      left = { type: "or", left, right: and() };
    }
    return left;
  }
  const tree = or();
  if (i !== tokens.length) throw new Error(`unexpected ${tokens[i]}`);
  return tree;
}

function evalTree(node) {
  if (node.type === "id") {
    const r = classifyId(node.id, node.exception);
    return { ...r, chosen: node.exception ? `${node.id} WITH ${node.exception}` : node.id };
  }
  const l = evalTree(node.left);
  const r = evalTree(node.right);
  if (node.type === "or") return RANK[l.level] <= RANK[r.level] ? l : r; // the licensee picks the better option
  const level = worst(l.level, r.level); // AND: both apply
  return { level, reason: [l.reason, r.reason].filter(Boolean).join("; "), chosen: `${l.chosen} AND ${r.chosen}` };
}

/**
 * A package.json `license` (SPDX string), or the legacy `licenses` array /
 * `{ type }` object, → { level, reason, license }.
 */
export function classifyLicense(raw) {
  if (Array.isArray(raw)) {
    // Legacy `licenses: [{ type }, …]` lists alternatives: the best one applies.
    const parts = raw.map((x) => (typeof x === "string" ? x : x?.type)).filter(Boolean);
    if (!parts.length) return classifyLicense(undefined);
    const results = parts.map((p) => classifyLicense(p));
    const pick = results.reduce((a, b) => (RANK[b.level] < RANK[a.level] ? b : a));
    return { ...pick, license: parts.join(" OR ") };
  }
  if (raw && typeof raw === "object") return classifyLicense(raw.type);
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { level: "fail", reason: "no licence declared", license: "(missing)" };
  if (/^unlicensed$/i.test(text)) return { level: "fail", reason: "UNLICENSED (proprietary, no grant)", license: text };
  if (/^see licen[cs]e in/i.test(text)) return { level: "warn", reason: "custom licence file: read it and decide", license: text };
  if (/commons[\s-]*clause/i.test(text)) return { level: "fail", reason: "Commons Clause (no selling)", license: text };
  try {
    const r = evalTree(parseSpdx(text));
    const reason = r.chosen !== text && /\bOR\b/.test(text) && r.level === "ok" ? `dual-licensed, using ${r.chosen}` : r.reason;
    return { level: r.level, reason, license: text };
  } catch {
    const r = classifyId(text);
    // A malformed expression ("(GPL-3.0-only", "MIT OR") must not hide a
    // forbidden id inside it: its ids are classified one by one and the worst counts.
    const ids = tokenize(text.replace(/[()]/g, " ")).filter((t) => !["AND", "OR", "WITH"].includes(t));
    const worstId = ids.length > 1 || (ids.length === 1 && ids[0] !== text) ? ids.map((id) => ({ id, ...classifyId(id.replace(/\+$/, "-or-later")) })).reduce((a, b) => (RANK[b.level] > RANK[a.level] ? b : a)) : null;
    if (worstId && worstId.level === "fail" && r.level !== "fail") return { level: worstId.level, reason: `malformed licence expression; it names ${worstId.id}: ${worstId.reason}`, license: text };
    return { level: r.level, reason: r.reason, license: text };
  }
}

/** The licence a LICENSE file's first lines name, when it is an obvious one. */
export function sniffLicenseText(text) {
  const head = (text ?? "").slice(0, 600);
  if (/\bMIT License\b|Permission is hereby granted, free of charge/i.test(head)) return "MIT";
  if (/ISC License|Permission to use, copy, modify, and\/or distribute/i.test(head)) return "ISC";
  if (/Apache License,?\s+Version 2\.0/i.test(head)) return "Apache-2.0";
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(head)) return "AGPL-3.0";
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(head)) return "LGPL-3.0";
  if (/GNU GENERAL PUBLIC LICENSE/i.test(head)) return "GPL-3.0";
  if (/Redistribution and use in source and binary forms/i.test(head)) return "BSD-3-Clause";
  return null;
}

// ── npm: the production dependency tree from package-lock.json ─────────

/**
 * Packages whose declared licence hides copyleft (or that are banned for
 * another reason). Present in production dependencies → that level.
 */
export const HIDDEN_COPYLEFT = [
  { name: "phonemizer", level: "fail", reason: "bundles eSpeak NG (GPL-3.0)" },
  { name: "@mintplex-labs/piper-tts-web", level: "fail", reason: "Piper with the eSpeak NG phonemizer (GPL-3.0)" },
  { name: "@diffusionstudio/vits-web", level: "fail", reason: "VITS/Piper with the eSpeak NG phonemizer (GPL-3.0)" },
  { name: "dictionary-he", level: "fail", reason: "Hspell word list (AGPL-3.0)" },
  { name: "hyperformula", level: "fail", reason: "GPL-3.0 unless a commercial licence key is bought" },
  { name: "expr-eval", level: "fail", reason: "CVE-2025-12735 (code injection), unmaintained" },
  { name: "@hebcal/core", level: "fail", reason: "GPL licence" },
  { name: "@hebcal/hdate", level: "fail", reason: "GPL licence" },
  { name: "citeproc", level: "warn", reason: "CPAL-1.0 / AGPL dual licence: needs a decision" },
  {
    name: "webr",
    level: "fail",
    reason: "declares 'SEE LICENSE IN'; its LICENSE.md says the webR binaries (R, libgfortran) are distributed under GPL-3.0, and scripts/copy-webr.mjs ships them in public/webr/",
  },
];

const nameFromPath = (p) => p.slice(p.lastIndexOf("node_modules/") + "node_modules/".length);

/** Node's lookup: `name` as seen from the package at `from` ("" = the root). */
export function resolveDep(packages, from, name) {
  let base = from;
  for (;;) {
    const cand = `${base ? base + "/" : ""}node_modules/${name}`;
    if (packages[cand]) return cand;
    if (!base) return null;
    const i = base.lastIndexOf("/node_modules/");
    base = i < 0 ? "" : base.slice(0, i);
  }
}

function runtimeDeps(entry) {
  const peersOptional = entry.peerDependenciesMeta ?? {};
  const peers = Object.keys(entry.peerDependencies ?? {}).filter((n) => !peersOptional[n]?.optional);
  return [
    ...Object.keys(entry.dependencies ?? {}).map((n) => ({ name: n, optional: false })),
    ...Object.keys(entry.optionalDependencies ?? {}).map((n) => ({ name: n, optional: true })),
    ...peers.map((n) => ({ name: n, optional: true })),
  ];
}

/**
 * Every package reachable from the root's dependencies / optionalDependencies
 * (never devDependencies) in a lockfile v2/v3 → [{ path, name, version,
 * license, via, optional }], breadth-first, so `via` is the direct dependency
 * on the shortest path. `unresolved` lists required deps the lock lacks.
 */
export function walkProduction(lock) {
  const packages = lock?.packages;
  if (!packages || !packages[""]) throw new Error("package-lock.json has no `packages` map (lockfileVersion 2+ needed)");
  const seen = new Map();
  const unresolved = [];
  const queue = [];
  for (const d of runtimeDeps(packages[""])) queue.push({ from: "", name: d.name, optional: d.optional, via: d.name });
  while (queue.length) {
    const { from, name, optional, via } = queue.shift();
    let path = resolveDep(packages, from, name);
    if (!path) {
      if (!optional) unresolved.push(`${name} (from ${from || "root"})`);
      continue;
    }
    if (seen.has(path)) continue;
    let entry = packages[path];
    let depsFrom = path;
    if (entry.link && entry.resolved && packages[entry.resolved]) {
      depsFrom = entry.resolved;
      entry = packages[entry.resolved];
    }
    seen.set(path, {
      path,
      name: entry.name ?? nameFromPath(path),
      version: entry.version ?? "",
      license: entry.license,
      via,
      optional: Boolean(entry.optional || optional),
    });
    for (const d of runtimeDeps(entry)) queue.push({ from: depsFrom, name: d.name, optional: d.optional, via });
  }
  return { packages: [...seen.values()], unresolved };
}

const nameMatches = (pattern, name) => (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name);

/**
 * Classify every production package. `readPackage(path)` may return the
 * installed package.json (for a licence the lock does not carry) and
 * `readLicenseFile(path)` the text of its LICENSE file; both are optional.
 */
export function checkNpm(lock, { readPackage, readLicenseFile, hidden = HIDDEN_COPYLEFT } = {}) {
  const { packages, unresolved } = walkProduction(lock);
  const byKey = new Map();
  for (const p of packages) {
    let raw = p.license;
    let source = "lock";
    if (raw === undefined || raw === null || raw === "") {
      const pkg = readPackage?.(p.path);
      if (pkg && (pkg.license || pkg.licenses)) {
        raw = pkg.license ?? pkg.licenses;
        source = "package.json";
      } else {
        const sniffed = sniffLicenseText(readLicenseFile?.(p.path));
        if (sniffed) {
          raw = sniffed;
          source = "LICENSE file";
        }
      }
    }
    const c = classifyLicense(raw);
    let { level, reason } = c;
    const h = hidden.find((x) => nameMatches(x.name, p.name));
    if (h) {
      level = worst(level, h.level);
      reason = [reason, `known hidden copyleft / banned: ${h.reason}`].filter(Boolean).join("; ");
    }
    if (source !== "lock" && level === "ok") reason = `licence read from ${source}`;
    const key = `${p.name}@${p.version}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.paths.push(p.path);
      continue;
    }
    byKey.set(key, { area: "npm", name: p.name, version: p.version, license: c.license, level, reason, via: p.via, optional: p.optional, paths: [p.path] });
  }
  const findings = [...byKey.values()];
  // A required package the lock does not have was never classified: it fails until the lock is fixed (npm install).
  for (const u of unresolved) findings.push({ area: "npm", name: u, version: "", license: "", level: "fail", reason: "required dependency missing from package-lock.json (never classified; regenerate the lock)", via: "", optional: false, paths: [], structural: true });
  return findings;
}

// ── Models: models/registry.json ───────────────────────────────────────

export const MODEL_KINDS = ["llm", "asr", "tts", "embedding", "reranker", "ocr", "nikud", "mt", "vision", "other"];
export const MODEL_CLASSES = ["allowed", "conditional", "forbidden", "unknown"];
export const MODEL_RUNS = ["browser", "ollama", "desktop"];
const COMMERCIAL_FOR = { allowed: ["yes"], conditional: ["conditional"], forbidden: ["no"], unknown: ["yes", "conditional", "no", "unknown"] };
const REQUIRED = ["id", "kind", "source", "license", "class", "commercial", "attribution", "size", "runs", "notes"];

/** Problems with one registry entry (empty when it is well-formed). */
export function validateEntry(e) {
  const problems = [];
  for (const f of REQUIRED) if (typeof e?.[f] !== "string") problems.push(`missing ${f}`);
  if (problems.length) return problems;
  if (!MODEL_KINDS.includes(e.kind)) problems.push(`kind "${e.kind}" is not one of ${MODEL_KINDS.join("|")}`);
  if (!MODEL_CLASSES.includes(e.class)) problems.push(`class "${e.class}" is not one of ${MODEL_CLASSES.join("|")}`);
  if (!MODEL_RUNS.includes(e.runs)) problems.push(`runs "${e.runs}" is not one of ${MODEL_RUNS.join("|")}`);
  if (MODEL_CLASSES.includes(e.class) && !COMMERCIAL_FOR[e.class].includes(e.commercial)) problems.push(`commercial "${e.commercial}" contradicts class "${e.class}"`);
  if (!/^https:\/\//.test(e.source)) problems.push("source must be an https URL");
  if (!e.license.trim()) problems.push("empty license");
  if ((e.class === "allowed" || e.class === "conditional") && !e.attribution.trim()) problems.push("allowed/conditional models need attribution text");
  if (e.match !== undefined && !(Array.isArray(e.match) && e.match.every((m) => typeof m === "string" && m.length >= 3))) problems.push("match must be an array of strings (3+ chars)");
  // verified: false means "classified from the model card only" (a notice); a missing or "false" string must not read as verified.
  if (typeof e.verified !== "boolean") problems.push("verified must be true or false");
  // The licence text must not contradict the class: a licence the npm rules
  // fail (AGPL, CC-BY-NC, SSPL…) or one that says non-commercial is never
  // allowed, conditional or unknown.
  if (MODEL_CLASSES.includes(e.class) && e.class !== "forbidden" && e.license.trim()) {
    const lic = classifyLicense(e.license);
    if (lic.level === "fail") problems.push(`license "${e.license}" is forbidden (${lic.reason}) but class is "${e.class}"`);
    else if (/\bnon-?\s*commercial\b/i.test(e.license)) problems.push(`license "${e.license}" is non-commercial but class is "${e.class}"`);
  }
  return problems;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A model token inside source text: not glued to more letters/digits on either side. */
export const tokenRegex = (token) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(token)}(?![A-Za-z0-9])`, "i");

/** A model id for exact comparison: case, surrounding space and a `:latest` tag do not count. */
export const normalizeModelId = (id) => String(id).trim().toLowerCase().replace(/:latest$/, "");

/** Where any of the entry's tokens (its id and `match`) occurs → [{ file, line }]. */
export function findReferences(entry, sources) {
  const res = [entry.id, ...(entry.match ?? [])].map(tokenRegex);
  const refs = [];
  for (const { file, text } of sources) {
    const lines = text.split("\n");
    lines.forEach((l, i) => {
      if (res.some((r) => r.test(l))) refs.push({ file, line: i + 1 });
    });
  }
  return refs;
}

/**
 * Model ids declared in the app's catalogs. A catalog id that no registry
 * entry covers warns, so a new model cannot slip in unclassified.
 */
export const CATALOG_PATTERNS = [
  { file: "src/ai/modelManager.ts", re: /\bbase:\s*"([^"]+)"/g },
  { file: "src/ai/modelCatalog.ts", re: /\{\s*name:\s*"([^"]+)"/g },
  { file: "src/ai/transformersEngine.ts", re: /"([A-Za-z][\w-]*\/[\w.-]+)"/g },
  { file: "src/agents/executors/webllm.ts", re: /"([A-Za-z0-9.-]+?)-q4f(?:16|32)_1-MLC"/g },
  { file: "src/agents/executors/ollama.ts", re: /RECOMMENDED_[A-Z_]*MODEL\s*=\s*"([^"]+)"/g },
  { file: "src/agents/doctor.ts", re: /RECOMMENDED_[A-Z_]*MODEL\s*=\s*"([^"]+)"/g },
  // Downloads outside the model catalogs. `exact`: covered only by an entry
  // whose id, a `match` alias or `source` is that exact name, since one alias
  // ("tessdata_fast", "wooorm/dictionaries") spans files under other licences.
  { file: "src/ai/ocr.ts", re: /\bLANGS\s*=\s*\[([^\]]*)\]/g, ids: (list) => [...list.matchAll(/"([\w-]+)"/g)].map((x) => `tessdata_fast/${x[1]}.traineddata`), exact: true },
  { file: "src/ai/hebrewSpell.ts", re: /_DICT_URL\s*=\s*"([^"]+)"/g, exact: true },
];

export function discoverCatalogIds(sources, patterns = CATALOG_PATTERNS) {
  const found = [];
  for (const p of patterns) {
    const src = sources.find((s) => s.file === p.file);
    if (!src) continue;
    for (const m of src.text.matchAll(p.re)) for (const id of p.ids ? p.ids(m[1]) : [m[1]]) found.push({ id, file: p.file, ...(p.exact ? { exact: true } : {}) });
  }
  return found;
}

/** Check the registry against the app's source files → findings, one per entry (plus problems). */
export function checkModels(registry, sources) {
  const findings = [];
  const entries = Array.isArray(registry?.models) ? registry.models : null;
  if (!entries) return [{ area: "model", name: "models/registry.json", license: "", level: "fail", reason: "no `models` array", refs: [], structural: true }];
  const ids = new Set();
  for (const e of entries) {
    const problems = validateEntry(e);
    if (e?.id && ids.has(e.id)) problems.push("duplicate id");
    if (e?.id) ids.add(e.id);
    if (problems.length) {
      // structural: a broken entry is fixed, never waived by an allowlist exception.
      findings.push({ area: "model", name: e?.id ?? "(no id)", license: e?.license ?? "", class: e?.class, level: "fail", reason: `registry entry invalid: ${problems.join("; ")}`, refs: [], structural: true });
      continue;
    }
    const refs = findReferences(e, sources);
    let level = "ok";
    let reason = refs.length ? "" : "not referenced by app code";
    if (e.class === "forbidden") {
      if (refs.length) {
        level = "fail";
        reason = "forbidden model referenced by app code";
      }
    } else if (e.class === "unknown") {
      level = "warn";
      reason = `licence not established${refs.length ? "" : " (not referenced by app code)"}`;
    } else if (e.class === "conditional" && refs.length) {
      level = "notice";
      reason = "needs its licence notice in the UI; must not be a default";
    }
    if (e.verified === false && e.class !== "forbidden" && refs.length) {
      level = worst(level, "notice");
      reason = [reason, "classified from the model card, not from verified research"].filter(Boolean).join("; ");
    }
    findings.push({ area: "model", name: e.id, license: e.license, class: e.class, kind: e.kind, runs: e.runs, level, reason, refs });
  }
  const valid = entries.filter((e) => validateEntry(e).length === 0);
  // Coverage is by exact id: a fine-tune named after a registered model
  // ("Qwen3-4B-Proprietary-Finetune") can carry another licence. Only an
  // entry's explicit `match` aliases cover a family.
  for (const { id, file, exact } of discoverCatalogIds(sources)) {
    const n = normalizeModelId(id);
    const covered = valid.some((e) =>
      exact
        ? [e.id, e.source, ...(e.match ?? [])].some((t) => normalizeModelId(t) === n)
        : normalizeModelId(e.id) === n || (e.match ?? []).some((t) => tokenRegex(t).test(id)),
    );
    if (!covered) findings.push({ area: "model", name: id, license: "", class: "unknown", level: "warn", reason: `in an app catalog (${file}) but not in models/registry.json`, refs: [{ file, line: 0 }] });
  }
  return findings;
}

// ── Datasets: eval/golden/<set>/ ───────────────────────────────────────

/**
 * Each eval/golden/<set>/ folder must say where its data comes from
 * (SOURCES.md) and under which licence (LICENSE, LICENSE.md or LICENSE.txt),
 * and every licence in the parts table of SOURCES.md (the column headed
 * "Licence") must be one a dataset may carry (plan 7.1, appendix 20.2 rule 4):
 *   - NonCommercial or NoDerivatives: fail (a sampled set is an adaptation);
 *   - ShareAlike: only in a folder whose LICENSE is ShareAlike too;
 *   - no licence (NOASSERTION): fail, unless the row's status is local-only
 *     (never stored or distributed): notice;
 *   - an unrecognised id: fail; one the folder's LICENSE never names: warn.
 * `dirs` = [{ name, files: [...], sources?: SOURCES.md text, license?: LICENSE text }].
 */
const DATA_OK = new Set(
  ["CC0-1.0", "CC-BY-4.0", "CC-BY-3.0", "CC-BY-2.5", "CC-BY-2.0", "LicenseRef-CC-BY-2.0-FR", "LicenseRef-PublicDomain", "CC-PDM-1.0", "PDDL-1.0", "ODC-By-1.0", "MIT", "MIT-0", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unlicense", "OFL-1.1"].map((x) => x.toLowerCase()),
);

export function classifyDatasetLicence(id, { shareAlikeFolder = false, localOnly = false } = {}) {
  const l = id.toLowerCase();
  if (/(^|-)nc(-|$)/.test(l)) return { level: localOnly ? "warn" : "fail", reason: "NonCommercial data" };
  if (/(^|-)nd(-|$)/.test(l)) return { level: localOnly ? "warn" : "fail", reason: "NoDerivatives: a sampled set is an adaptation" };
  if (/^cc-by-sa-/.test(l) || /^odbl/.test(l)) return shareAlikeFolder ? { level: "ok", reason: "" } : { level: "fail", reason: "ShareAlike data in a folder whose LICENSE is not ShareAlike" };
  if (["noassertion", "none", "unknown", ""].includes(l)) return localOnly ? { level: "notice", reason: "no licence: local-only part, never stored or distributed" } : { level: "fail", reason: "data without a licence" };
  if (DATA_OK.has(l)) return { level: "ok", reason: "" };
  return { level: "fail", reason: `unrecognised dataset licence "${id}"` };
}

/** Rows of the first markdown table in `md` whose header has a "Licence"/"License" column: [{ cells by header }]. */
export function sourcesTable(md) {
  const lines = md.split("\n");
  const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue;
    const head = cells(lines[i]).map((h) => h.toLowerCase());
    if (!head.some((h) => /^licen[cs]e$/.test(h))) continue;
    const rows = [];
    for (let j = i + 2; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
      const c = cells(lines[j]);
      rows.push(Object.fromEntries(head.map((h, k) => [h, c[k] ?? ""])));
    }
    return rows;
  }
  return null;
}

export function checkDatasets(dirs) {
  return dirs.map(({ name, files, sources, license }) => {
    const base = { area: "dataset", name: `eval/golden/${name}`, license: "" };
    const missing = [];
    if (!files.includes("SOURCES.md")) missing.push("SOURCES.md");
    if (!files.some((f) => /^LICEN[CS]E(\.md|\.txt)?$/.test(f))) missing.push("LICENSE");
    if (missing.length) return { ...base, level: "fail", reason: `missing ${missing.join(" and ")}` };
    const rows = sourcesTable(sources ?? "");
    if (!rows?.length) return { ...base, level: "fail", reason: "SOURCES.md has no parts table with a Licence column" };
    const shareAlikeFolder = /share-?alike|\bBY-SA\b/i.test(license ?? "");
    let level = "ok";
    const reasons = [];
    const ids = new Set();
    for (const r of rows) {
      const lic = r.licence ?? r.license ?? "";
      const localOnly = /local-only/i.test(r.status ?? "");
      for (const id of lic.split(/\s+AND\s+|\s+OR\s+|[;,]\s*/).map((x) => x.trim()).filter(Boolean).concat(lic.trim() ? [] : [""])) {
        ids.add(id);
        const c = classifyDatasetLicence(id, { shareAlikeFolder, localOnly });
        level = worst(level, c.level);
        if (c.reason) reasons.push(`${r.part ?? "?"}: ${c.reason}`);
        if (id && c.level !== "fail" && !localOnly && !(license ?? "").includes(id)) {
          level = worst(level, "warn");
          reasons.push(`${r.part ?? "?"}: LICENSE does not name ${id}`);
        }
      }
    }
    return { ...base, license: [...ids].filter(Boolean).join(" AND "), level, reason: [...new Set(reasons)].join("; ") };
  });
}

// ── Allowlist: licenses.allow.json ─────────────────────────────────────

/** A real YYYY-MM-DD calendar day (not "2026/11/15", "never" or "2026-02-30"). */
export function isCalendarDate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Documented exceptions. Each { area, name (trailing * = prefix), level
 * (the most it may report: warn | notice | ok; default warn), reason,
 * license (the licence text the decision was about), until? (YYYY-MM-DD) }.
 * A matching finding is capped at that level only while its licence is
 * still that one: a dependency that changes licence (tldraw did, between
 * majors) is reported again instead of waived by the old decision. A
 * capped finding carries the reason. Only licence / policy findings can be capped: a
 * structural one (an invalid registry entry, a broken lockfile) keeps its
 * level. Problems with the allowlist itself are findings too;
 * a malformed `until` is a failure and the exception is not applied, so a
 * typo cannot become a permanent waiver.
 */
export function applyAllowlist(findings, allow, today = new Date().toISOString().slice(0, 10)) {
  const extra = [];
  const exceptions = Array.isArray(allow?.exceptions) ? allow.exceptions : [];
  for (const ex of exceptions) {
    const label = `${ex?.area ?? "?"}:${ex?.name ?? "?"}`;
    if (!ex || !["npm", "model", "dataset"].includes(ex.area) || typeof ex.name !== "string" || !ex.name) {
      extra.push({ area: "allowlist", name: label, license: "", level: "fail", reason: "exception needs area (npm|model|dataset) and name" });
      continue;
    }
    if (typeof ex.reason !== "string" || ex.reason.trim().length < 10) {
      extra.push({ area: "allowlist", name: label, license: "", level: "fail", reason: "exception without a documented reason" });
      continue;
    }
    const cap = ex.level ?? "warn";
    if (!["warn", "notice", "ok"].includes(cap)) {
      extra.push({ area: "allowlist", name: label, license: "", level: "fail", reason: `level "${cap}" must be warn, notice or ok` });
      continue;
    }
    if (ex.license !== undefined && (typeof ex.license !== "string" || !ex.license.trim())) {
      extra.push({ area: "allowlist", name: label, license: "", level: "fail", reason: "license must be the licence text the exception was decided for" });
      continue;
    }
    if (ex.license === undefined) extra.push({ area: "allowlist", name: label, license: "", level: "warn", reason: "exception without `license`: it would waive any licence this package or model gets later; add the one it was decided for" });
    if (ex.until != null && !isCalendarDate(ex.until)) {
      extra.push({ area: "allowlist", name: label, license: "", level: "fail", reason: `until ${JSON.stringify(ex.until)} must be a YYYY-MM-DD date; not applied` });
      continue;
    }
    if (ex.until != null && ex.until < today) {
      extra.push({ area: "allowlist", name: label, license: "", level: "warn", reason: `exception expired on ${ex.until}; not applied` });
      continue;
    }
    const hits = findings.filter((f) => f.area === ex.area && nameMatches(ex.name, f.name));
    if (!hits.length) {
      extra.push({ area: "allowlist", name: label, license: "", level: "warn", reason: "exception matches nothing: remove it" });
      continue;
    }
    const drift = [];
    for (const f of hits) {
      if (f.structural) {
        if (!/allowlist exception cannot waive/.test(f.reason)) f.reason += " (an allowlist exception cannot waive this: fix the entry)";
        continue;
      }
      if (ex.license !== undefined && f.license !== ex.license) {
        if (RANK[f.level] > RANK[cap]) drift.push(f);
        continue;
      }
      f.allowed = ex.reason + (ex.decision ? ` (decision ${ex.decision})` : "");
      f.level = best(f.level, cap);
    }
    if (drift.length)
      extra.push({ area: "allowlist", name: label, license: ex.license, level: "warn", reason: `licence changed: ${drift.map((f) => `${f.name}${f.version ? `@${f.version}` : ""} is now "${f.license}"`).join(", ")}; the exception was decided for "${ex.license}" and is not applied: decide again` });
  }
  return [...findings, ...extra];
}

export function summarize(findings) {
  const counts = { fail: 0, warn: 0, notice: 0, ok: 0 };
  for (const f of findings) counts[f.level]++;
  return counts;
}

/** Plain-text table (no colours) of the rows given. */
export function formatTable(rows, columns) {
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(r[c.key] ?? "").length)));
  const cap = (s, w) => (s.length > w ? s.slice(0, w - 1) + "…" : s);
  const maxW = columns.map((c, i) => Math.min(widths[i], c.max ?? 80));
  const line = (vals) => vals.map((v, i) => cap(String(v ?? ""), maxW[i]).padEnd(maxW[i])).join("  ").trimEnd();
  return [line(columns.map((c) => c.label)), line(maxW.map((w) => "-".repeat(w))), ...rows.map((r) => line(columns.map((c) => r[c.key])))].join("\n");
}
