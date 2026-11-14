/**
 * Golden sets (plan 7.1, appendix 20): held-out, licensed eval sets.
 *
 * Only the DEV split of a set is committed (eval/golden/<set>/dev/, about a
 * quarter of the items, inputs and answers). The TEST split is never in the
 * repo: scripts/golden/* rebuild it in CI from the public sources with the
 * secret seed GOLDEN_SEED, the evals run there and only scores are
 * published. The repo holds the test split's manifest instead: item count,
 * sha256 per part and for the whole split, and its canary.
 *
 * This module holds the rules and the loader:
 *   - deterministic sampling (the same seed gives the same items, in Node and
 *     in scripts/golden/hf_build.py) and the dev / test partition of a pool;
 *   - the manifest and freezing (a frozen set changes only through a new
 *     version with a reason, appendix 20.2 rule 2);
 *   - canaries: one GUID in every dev file, another in every test file, so a
 *     model that trained on either — or a test file that reached the repo —
 *     can be caught;
 *   - loadSet(), the one entry point eval harnesses use.
 *
 * The CLI is scripts/golden.mjs; builders live in scripts/golden/.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export const SCHEMA = 1;
export const CANARY_PREFIX = "LUMEN GOLDEN SET - DO NOT TRAIN ON THIS DATA. canary GUID ";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Where a part's data comes from:
 *   built            — a GitHub / npm source or a generator this repo runs: dev committed now, test rebuilt in CI
 *   workflow-pending — Hugging Face, Tatoeba, Wikipedia or S3: .github/workflows/golden-sets.yml builds dev and test
 *   local-only       — never committed (licence or contamination terms): dev and test are frozen as ids + sha256 only
 *   owner-pending    — the owner's own material (15.11): never in the repo; CI reads it from an encrypted bundle
 */
export const PART_STATUS = ["built", "workflow-pending", "local-only", "owner-pending"];
/** partial = frozen, something still missing; locked = every dev part and every test sha256 is in (7.1.6). */
export const SET_STATUS = ["partial", "locked"];
/** The largest share of a part that may be committed as dev. */
export const MAX_DEV_SHARE = 0.35;

const TEXT_FILE = /\.(json|jsonl|md|txt|tsv|csv)$/i;
const LICENCE_FILE = /^LICEN[CS]E(\.md|\.txt)?$/;
/** Item fields that name a file of the split (an image, a clip). */
export const ASSET_FIELDS = ["image", "audio", "file"];

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export const posix = (p) => p.split(sep).join("/");
export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
export const writeJson = (p, value) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(value, null, 2) + "\n");
};

// ── Canaries ────────────────────────────────────────────────────────────

export const newCanary = () => CANARY_PREFIX + randomUUID();

/** The GUID of a canary string, or null when it is not one. */
export function canaryGuid(canary) {
  if (typeof canary !== "string" || !canary.startsWith(CANARY_PREFIX)) return null;
  const guid = canary.slice(CANARY_PREFIX.length);
  return GUID.test(guid) ? guid : null;
}

// ── Deterministic sampling ──────────────────────────────────────────────

/** sha256(seed \0 key): sort by it to shuffle reproducibly (scripts/golden/hf_build.py computes the same). */
export const rankKey = (seed, key) => sha256(`${seed}\u0000${key}`);

export function shuffle(items, seed, key = (x) => x.id) {
  return items
    .map((item) => ({ item, k: rankKey(seed, String(key(item))) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map((x) => x.item);
}

export function sample(items, n, seed, key = (x) => x.id) {
  const out = shuffle(items, seed, key).slice(0, n);
  if (out.length < n) throw new Error(`asked for ${n} items, only ${out.length} available`);
  return out;
}

/** The public seed of a part's dev split. */
export const devSeed = (set, part) => `lumen-golden-v1:${set}:${part}:dev`;
/** The test seed: the secret GOLDEN_SEED, never logged. */
export const testSeed = (secret, set, part) => `${secret}:${set}:${part}:test`;

/**
 * Partition a pool: dev = the first nDev by the public seed; test = the
 * first nTest of the rest by the secret seed (omitted: no test). Both come
 * back in pool order.
 */
export function splitPool(pool, { set, part, nDev, nTest = 0, secret, key = (x) => x.id }) {
  const ids = new Set();
  for (const it of pool) {
    const k = String(key(it));
    if (ids.has(k)) throw new Error(`${set}/${part}: duplicate pool key ${k}`);
    ids.add(k);
  }
  const dev = new Set(sample(pool, nDev, devSeed(set, part), key).map((x) => String(key(x))));
  let test = new Set();
  if (nTest) {
    if (!secret) throw new Error("the test split needs GOLDEN_SEED");
    test = new Set(sample(pool.filter((x) => !dev.has(String(key(x)))), nTest, testSeed(secret, set, part), key).map((x) => String(key(x))));
  }
  return { dev: pool.filter((x) => dev.has(String(key(x)))), test: pool.filter((x) => test.has(String(key(x)))) };
}

/**
 * Like splitPool, for generated items: walk the pool in seed order and keep
 * make(item, seed) until n are made (make returns null to skip an item).
 * The test walk skips the pool items dev used. Results come back in walk
 * order; make() gets the split's own seed, so the test split's random
 * choices (errors, fonts, values) come from GOLDEN_SEED too.
 */
export function splitPoolWith(pool, { set, part, nDev, nTest = 0, secret, key = (x) => x.id }, make) {
  const take = (items, n, seed) => {
    const out = [];
    const used = [];
    for (const it of shuffle(items, seed, key)) {
      if (out.length === n) break;
      const made = make(it, seed);
      if (made) {
        out.push(made);
        used.push(String(key(it)));
      }
    }
    if (out.length < n) throw new Error(`${set}/${part}: made ${out.length} of ${n}`);
    return { out, used };
  };
  const dev = take(pool, nDev, devSeed(set, part));
  if (!nTest) return { dev: dev.out, test: [] };
  if (!secret) throw new Error("the test split needs GOLDEN_SEED");
  const devUsed = new Set(dev.used);
  const test = take(pool.filter((x) => !devUsed.has(String(key(x)))), nTest, testSeed(secret, set, part));
  return { dev: dev.out, test: test.out };
}

/**
 * sha256 of an item's content: canonical JSON (sorted keys, no spaces, no
 * id) — the bytes of Python's json.dumps(sort_keys=True,
 * separators=(",", ":"), ensure_ascii=False). Strings and integers only.
 * Used for the frozen selections of local-only parts.
 */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export function contentHash(item) {
  const { id: _id, ...rest } = item;
  return sha256(canonicalJson(rest));
}

// ── Files and split hashes ──────────────────────────────────────────────

/** Every file under dir, posix paths relative to it, sorted; `skip` filters top-level names. */
export function listFiles(dir, skip = () => false) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = posix(relative(dir, p));
      if (skip(rel)) continue;
      if (statSync(p).isDirectory()) walk(p);
      else out.push(rel);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** The committed files of a set: everything but manifest.json and local/ (git-ignored downloads). */
export const listSetFiles = (dir) => listFiles(dir, (rel) => rel === "manifest.json" || rel === "local");

export const hashFiles = (dir, files) => Object.fromEntries(files.map((f) => [f, sha256(readFileSync(join(dir, f)))]));

/** sha256 of a list of files: of the lines "<path>\t<sha256>\n", sorted by path. */
export function treeHash(files) {
  return sha256(
    Object.keys(files)
      .sort()
      .map((f) => `${f}\t${files[f]}\n`)
      .join(""),
  );
}

/** The files of one part of a split directory: <part>.json and everything under <part>/. */
export const partFiles = (splitDir, partId) => listFiles(splitDir).filter((f) => f === `${partId}.json` || f.startsWith(`${partId}/`));

/** sha256 of one part of a split, and of the whole split (from the part hashes, by part id). */
export const partHash = (splitDir, partId) => treeHash(hashFiles(splitDir, partFiles(splitDir, partId)));
export const splitHash = (partHashes) =>
  sha256(
    Object.keys(partHashes)
      .sort()
      .map((p) => `${p}\t${partHashes[p]}\n`)
      .join(""),
  );

// ── Status ──────────────────────────────────────────────────────────────

const devIn = (p) => p.dev === 0 || (p.status === "local-only" ? typeof p.devSelection === "string" : (p.devFiles ?? []).length > 0 && p.status === "built");
export const partComplete = (p, test) => devIn(p) && HEX64.test(test?.parts?.[p.id] ?? "") && p.review !== "pending";
export const setComplete = (m) => m.parts.every((p) => partComplete(p, m.test));

/** What a part still waits for, in words. */
export function partWaitsFor(p, test) {
  const out = [];
  if (!devIn(p)) out.push(p.status === "workflow-pending" ? `dev: workflow job ${p.workflow}${p.token ? " (HF_TOKEN, 15.9)" : ""}` : p.status === "local-only" ? `dev selection: workflow job ${p.workflow ?? "?"}` : "dev");
  if (!HEX64.test(test?.parts?.[p.id] ?? "")) out.push(p.status === "owner-pending" ? `test: the owner's encrypted bundle (${p.owner})` : "test sha256: a CI run with GOLDEN_SEED (15.9)");
  if (p.review === "pending") out.push(`owner review (${p.owner})`);
  return out.join("; ");
}

// ── Validation ──────────────────────────────────────────────────────────

const isInt = (n) => Number.isInteger(n);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const partsState = (m) => sha256(JSON.stringify({ parts: m.parts ?? null, test: m.test ?? null }));

/**
 * Every rule a committed set must meet. Returns { name, manifest, problems };
 * `problems` is empty for a good set.
 */
export function validateSet(dir, name) {
  const problems = [];
  const bad = (msg) => problems.push(msg);
  const mPath = join(dir, "manifest.json");
  if (!existsSync(mPath)) return { name, manifest: null, problems: ["no manifest.json"] };
  let m;
  try {
    m = readJson(mPath);
  } catch (e) {
    return { name, manifest: null, problems: [`manifest.json is not JSON: ${e.message}`] };
  }

  if (m.schema !== SCHEMA) bad(`schema must be ${SCHEMA}`);
  if (m.set !== name) bad(`set "${m.set}" does not match the folder "${name}"`);
  for (const k of ["title", "metric", "license"]) if (typeof m[k] !== "string" || !m[k]) bad(`${k} missing`);
  if (!isInt(m.target) || m.target < 1) bad("target must be a positive integer");
  const devGuid = canaryGuid(m.canary);
  const testGuid = canaryGuid(m.test?.canary);
  if (!devGuid) bad(`canary must be "${CANARY_PREFIX}<uuid v4>"`);
  if (!testGuid) bad("test.canary must be a canary string");
  if (devGuid && devGuid === testGuid) bad("the dev and test canaries must differ");
  if (m.frozen !== true) bad(`not frozen: run \`node scripts/golden.mjs freeze ${name}\``);
  if (!SET_STATUS.includes(m.status)) bad(`status must be one of ${SET_STATUS.join(", ")}`);
  if (!isInt(m.version) || m.version < 1) bad("version must be an integer >= 1");
  const log = Array.isArray(m.changelog) ? m.changelog : [];
  for (let v = 1; v <= (isInt(m.version) ? m.version : 0); v++) {
    const e = log.find((x) => x.version === v);
    if (!e) bad(`changelog has no entry for version ${v}`);
    else {
      if (!DATE.test(e.date ?? "")) bad(`changelog v${v}: date must be YYYY-MM-DD`);
      if (typeof e.reason !== "string" || e.reason.trim().length < 10) bad(`changelog v${v}: a reason is required`);
    }
  }
  if (m.frozen === true && m.frozenState !== partsState(m)) bad("parts or test manifest changed since the last freeze: run `freeze --reason`");

  // Committed files: exactly the manifest's, with matching sha256; never a test file.
  const listed = m.files && typeof m.files === "object" ? m.files : {};
  const actual = listSetFiles(dir);
  for (const f of Object.keys(listed)) if (!actual.includes(f)) bad(`listed in the manifest but missing: ${f}`);
  for (const f of actual) {
    if (/^test(\/|$)/.test(f) || /(^|\/)test\//.test(f)) bad(`a test-split file is in the repo: ${f} — the test split is never committed`);
    const buf = readFileSync(join(dir, f));
    const text = TEXT_FILE.test(f) ? buf.toString("utf8") : buf.toString("latin1");
    if (testGuid && text.includes(testGuid)) bad(`${f} carries the TEST canary: test data is in the repo`);
    if (!(f in listed)) {
      bad(`not in the manifest (unfrozen file): ${f}`);
      continue;
    }
    if (sha256(buf) !== listed[f]) bad(`sha256 mismatch: ${f} — the set is frozen; change it only with \`freeze --reason\` (new version)`);
    if (devGuid && TEXT_FILE.test(f) && !LICENCE_FILE.test(f.split("/").pop()) && !text.includes(devGuid)) bad(`canary GUID missing from ${f}`);
  }
  if (!actual.includes("SOURCES.md")) bad("SOURCES.md missing");
  if (!actual.some((f) => LICENCE_FILE.test(f))) bad("LICENSE missing");

  // Parts.
  const parts = Array.isArray(m.parts) ? m.parts : [];
  if (!parts.length) bad("no parts");
  const ids = new Set();
  const itemIds = new Set();
  let sum = 0;
  let testSum = 0;
  for (const p of parts) {
    const label = `part ${p?.id ?? "?"}`;
    if (typeof p?.id !== "string" || !/^[a-z0-9-]+$/.test(p.id)) bad(`${label}: id must be kebab-case`);
    if (ids.has(p.id)) bad(`${label}: duplicate id`);
    ids.add(p.id);
    if (!PART_STATUS.includes(p.status)) bad(`${label}: status must be one of ${PART_STATUS.join(", ")}`);
    if (!isInt(p.items) || !isInt(p.dev) || !isInt(p.test) || p.dev < 0 || p.test < 1 || p.dev + p.test !== p.items) bad(`${label}: items must equal dev + test (test >= 1)`);
    else {
      sum += p.items;
      testSum += p.test;
      if (p.status === "owner-pending" && p.dev !== 0) bad(`${label}: the owner's material never enters the repo (dev must be 0)`);
      if (p.dev / p.items > MAX_DEV_SHARE) bad(`${label}: dev is ${p.dev}/${p.items}, more than ${MAX_DEV_SHARE * 100}% is committed`);
    }
    if (typeof p.license !== "string" || !p.license) bad(`${label}: licence missing`);
    if (p.review !== undefined && !["pending", "done"].includes(p.review)) bad(`${label}: review must be pending or done`);
    if (p.status === "workflow-pending" && !p.workflow) bad(`${label}: workflow-pending needs the workflow job name`);
    if (p.status === "owner-pending" && !p.owner) bad(`${label}: owner-pending needs the plan reference (15.11)`);

    const devFiles = p.devFiles ?? [];
    if (p.status === "local-only" && devFiles.length) bad(`${label}: a local-only part commits no data, only its selection`);
    for (const f of devFiles) {
      if (!(f in listed)) {
        bad(`${label}: dev file ${f} is not in the manifest`);
        continue;
      }
      if (!f.endsWith(".json")) continue;
      const data = readJson(join(dir, f));
      checkSplitData(data, { label, set: m.set, part: p, canary: m.canary, n: p.dev, files: listed, itemIds, bad, assetPrefix: p.status === "built" ? "dev/" : null });
    }
    if (p.status === "built" && p.dev > 0 && !devFiles.some((f) => f.endsWith(".json"))) bad(`${label}: built, but no dev data file`);
    if (p.devSelection !== undefined && p.devSelection !== null) {
      if (p.status !== "local-only") bad(`${label}: only local-only parts have a selection`);
      else if (!(p.devSelection in listed)) bad(`${label}: selection ${p.devSelection} is not in the set`);
      else {
        const sel = readJson(join(dir, p.devSelection));
        if (sel.canary !== m.canary) bad(`${label}: ${p.devSelection} carries a different canary`);
        if (!Array.isArray(sel.items) || sel.items.length !== p.dev) bad(`${label}: ${p.devSelection} must list ${p.dev} items`);
        else for (const it of sel.items) if (!HEX64.test(it.sha256 ?? "") || "text" in it) bad(`${label}: selection item ${it.id} must carry sha256 and no text`);
      }
    }
  }
  if (isInt(m.target) && sum !== m.target) bad(`parts add up to ${sum}, the target is ${m.target}`);

  // The test split's manifest (the split itself is only ever in CI).
  const t = m.test ?? {};
  if (t.items !== testSum) bad(`test.items is ${t.items}, the parts' test counts add up to ${testSum}`);
  const tp = t.parts && typeof t.parts === "object" ? t.parts : {};
  for (const p of parts) if (!(p.id in tp)) bad(`test.parts has no entry for ${p.id} (null until recorded)`);
  for (const [k, v] of Object.entries(tp)) {
    if (!ids.has(k)) bad(`test.parts names an unknown part ${k}`);
    if (v !== null && !HEX64.test(v)) bad(`test.parts.${k} must be null or a sha256`);
  }
  const allRecorded = parts.length && parts.every((p) => HEX64.test(tp[p.id] ?? ""));
  if (allRecorded && t.sha256 !== splitHash(Object.fromEntries(parts.map((p) => [p.id, tp[p.id]])))) bad("test.sha256 does not match the part hashes");
  if (!allRecorded && t.sha256 !== null) bad("test.sha256 must stay null until every part's test sha256 is recorded");

  if (m.status === "locked" && !setComplete({ parts, test: t })) bad("locked, but a part is still missing");
  if (m.status === "partial" && parts.length && setComplete({ parts, test: t })) bad("every part is in: lock it (`freeze --reason`)");
  return { name, manifest: m, problems };
}

/**
 * Rules for a split data file (dev in the repo, test in CI). Asset paths in
 * items are relative to the split directory; `assetPrefix` maps them into
 * `files` (null: do not check assets yet).
 */
export function checkSplitData(data, { label, set, part, canary, n, files, itemIds, bad, assetPrefix }) {
  if (data.canary !== canary) bad(`${label}: data carries a different canary`);
  if (data.set !== set || data.part !== part.id) bad(`${label}: data says set/part ${data.set}/${data.part}`);
  if (data.license !== part.license) bad(`${label}: data licence ${data.license} differs from the manifest's ${part.license}`);
  if (!Array.isArray(data.items)) return bad(`${label}: no items array`);
  if (data.items.length !== n) bad(`${label}: ${data.items.length} items, the manifest says ${n}`);
  for (const it of data.items) {
    if (typeof it?.id !== "string" || !it.id) bad(`${label}: an item without an id`);
    else if (itemIds.has(it.id)) bad(`${label}: duplicate item id ${it.id}`);
    else itemIds.add(it.id);
    if (assetPrefix !== null && assetPrefix !== undefined) for (const k of ASSET_FIELDS) if (typeof it?.[k] === "string" && !(`${assetPrefix}${it[k]}` in files)) bad(`${label}: item ${it.id} names ${it[k]}, which is not there`);
  }
}

/** Every set under root (eval/golden), plus the rules across sets. */
export function validateAll(root) {
  const names = existsSync(root) ? readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory()).sort() : [];
  const results = names.map((n) => validateSet(join(root, n), n));
  const seen = new Map();
  for (const r of results)
    for (const c of [r.manifest?.canary, r.manifest?.test?.canary]) {
      const g = canaryGuid(c);
      if (!g) continue;
      if (seen.has(g)) r.problems.push(`canary GUID shared with ${seen.get(g)}`);
      else seen.set(g, r.name);
    }
  return results;
}

/** The test canary GUIDs of every set: no committed file but a manifest may contain one. */
export const testCanaries = (root) => validateAll(root).map((r) => ({ set: r.name, guid: canaryGuid(r.manifest?.test?.canary) })).filter((x) => x.guid);

/**
 * Files of the repo that carry a test canary — only eval/golden/<set>/manifest.json
 * may. Uses `git ls-files` (tracked and untracked, not ignored) when root is
 * a git checkout, else walks eval/ and scripts/. Returns messages.
 */
export function scanForTestData(root) {
  const canaries = testCanaries(join(root, "eval", "golden"));
  if (!canaries.length) return [];
  const git = spawnSync("git", ["-C", root, "ls-files", "-co", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const files = git.status === 0 ? git.stdout.split("\n").filter(Boolean) : [...listFiles(join(root, "eval")).map((f) => `eval/${f}`), ...listFiles(join(root, "scripts")).map((f) => `scripts/${f}`)];
  const hits = [];
  for (const f of files) {
    if (/(^|\/)node_modules\//.test(f) || /^eval\/golden\/[^/]+\/manifest\.json$/.test(f)) continue;
    const p = join(root, f);
    if (!existsSync(p) || !statSync(p).isFile() || statSync(p).size > 32 * 1024 * 1024) continue;
    const text = readFileSync(p).toString("latin1");
    for (const c of canaries) if (text.includes(c.guid)) hits.push(`${f} carries the TEST canary of ${c.set}: test data is in the repo`);
  }
  return hits;
}

// ── Freezing ────────────────────────────────────────────────────────────

/**
 * Hash the set's committed files into its manifest. The first freeze makes
 * version 1; after that any change to a file, a part or the test manifest
 * needs a reason and becomes a new version. A set whose every part is in
 * becomes locked. Returns { manifest, changed }.
 */
export function freezeSet(dir, { reason, today = new Date().toISOString().slice(0, 10) } = {}) {
  const mPath = join(dir, "manifest.json");
  const m = readJson(mPath);
  const files = hashFiles(dir, listSetFiles(dir));
  const status = setComplete(m) ? "locked" : "partial";
  const same = JSON.stringify(m.files ?? {}) === JSON.stringify(files) && m.status === status && m.frozenState === partsState(m);
  if (m.frozen === true) {
    if (same) return { manifest: m, changed: false };
    if (!reason || reason.trim().length < 10) throw new Error(`${m.set} is frozen: a change needs --reason "<why>" (it becomes version ${m.version + 1})`);
    m.version += 1;
    m.changelog = [...(m.changelog ?? []), { version: m.version, date: today, reason: reason.trim() }];
  } else {
    m.version = 1;
    m.frozen = true;
    m.changelog = [{ version: 1, date: today, reason: (reason ?? "").trim() || "first freeze" }];
  }
  m.status = status;
  m.frozenAt = today;
  m.files = files;
  m.frozenState = partsState(m);
  writeJson(mPath, m);
  return { manifest: m, changed: true };
}

/** Record the sha256 of a CI-built test split (only hashes; the data stays in CI). */
export function recordTest(dir, splitDir) {
  const mPath = join(dir, "manifest.json");
  const m = readJson(mPath);
  for (const p of m.parts) {
    if (!partFiles(splitDir, p.id).length) continue;
    m.test.parts[p.id] = partHash(splitDir, p.id);
  }
  const all = m.parts.every((p) => HEX64.test(m.test.parts[p.id] ?? ""));
  m.test.sha256 = all ? splitHash(Object.fromEntries(m.parts.map((p) => [p.id, m.test.parts[p.id]]))) : null;
  writeJson(mPath, m);
  return m.test;
}

/** Compare a CI-built test split with the recorded hashes. Returns [{ part, status: ok | mismatch | unrecorded | missing }]. */
export function checkTest(dir, splitDir) {
  const m = readJson(join(dir, "manifest.json"));
  return m.parts.map((p) => {
    if (!partFiles(splitDir, p.id).length) return { part: p.id, status: "missing" };
    const want = m.test.parts[p.id];
    if (!want) return { part: p.id, status: "unrecorded", sha256: partHash(splitDir, p.id) };
    return { part: p.id, status: partHash(splitDir, p.id) === want ? "ok" : "mismatch" };
  });
}

// ── Writing a split ─────────────────────────────────────────────────────

/**
 * Write one part of a split: <splitDir>/<part>.json with the split's canary
 * and the part's assets under <splitDir>/<part>/. Returns the files written,
 * relative to splitDir. Writes no item text anywhere else (and logs none).
 */
export function writeSplitPart(splitDir, { manifest, partId, split, items, meta = {}, extra = {} }) {
  const part = manifest.parts.find((p) => p.id === partId);
  if (!part) throw new Error(`${manifest.set} has no part ${partId}`);
  const n = split === "dev" ? part.dev : part.test;
  if (items.length !== n) throw new Error(`${manifest.set}/${partId}: ${items.length} ${split} items, the manifest says ${n}`);
  const canary = split === "dev" ? manifest.canary : manifest.test.canary;
  writeJson(join(splitDir, `${partId}.json`), { canary, set: manifest.set, part: partId, split, license: part.license, ...meta, items, ...extra });
  return partFiles(splitDir, partId);
}

// ── Loading (eval harnesses) ────────────────────────────────────────────

/**
 * The items of a set for an eval run.
 *   split: "dev" (committed) or "test" (testDir: the CI-built split; its
 *          hashes are checked against the manifest).
 *   parts: only these part ids.
 *   local: also the dev items of local-only parts, from local/<part>.json
 *          (written by `hf_build.py fetch-local`), each checked against its
 *          frozen sha256.
 * Asset paths come back absolute. Throws when the set does not validate or
 * a test part does not match its recorded sha256, so a harness never
 * measures against a tampered or drifted set. `unverified` lists test parts
 * whose sha256 is not recorded yet.
 */
/**
 * Parts of a set whose test items are fewer than the manifest declares
 * (`parts[].test`): a builder failed or a gated part was skipped. A score
 * over the rest would be published as the set's metric. → [{ part, have, want }]
 */
export function incompleteParts(manifest, items) {
  return (manifest.parts ?? [])
    .filter((p) => typeof p.test === "number" && p.test > 0)
    .map((p) => ({ part: p.id, have: items.filter((it) => it.part === p.id).length, want: p.test }))
    .filter((x) => x.have < x.want);
}

export function loadSet(root, name, { split = "dev", testDir, parts, local = false } = {}) {
  const dir = join(root, name);
  const { manifest, problems } = validateSet(dir, name);
  if (problems.length) throw new Error(`golden set ${name} does not validate:\n  ${problems.join("\n  ")}`);
  const items = [];
  const unverified = [];
  // Part-level documents a harness needs besides the items (retrieval: the passages the items' ids point to).
  const corpus = {};
  for (const p of manifest.parts) {
    if (parts && !parts.includes(p.id)) continue;
    let base;
    let file;
    if (split === "dev" && p.status === "local-only") {
      // Only with local: true, from local/<part>.json (fetch_local), checked item by item against the frozen selection.
      const f = join(dir, "local", `${p.id}.json`);
      if (!local || !p.devSelection || !existsSync(f)) continue;
      const want = new Map(readJson(join(dir, p.devSelection)).items.map((it) => [it.id, it.sha256]));
      const got = readJson(f).items;
      if (got.length !== want.size) throw new Error(`${name}/${p.id}: local/ has ${got.length} items, the selection ${want.size}`);
      for (const it of got) {
        if (contentHash(it) !== want.get(it.id)) throw new Error(`${name}/${p.id}: local item ${it.id} does not match its frozen sha256`);
        items.push({ ...it, part: p.id });
      }
      continue;
    }
    if (split === "dev") {
      if (p.dev === 0) continue;
      const f = (p.devFiles ?? []).find((x) => x.endsWith(".json"));
      if (!f) continue;
      base = join(dir, "dev");
      file = f.replace(/^dev\//, "");
    } else {
      if (!testDir) throw new Error("loadSet: the test split needs testDir (built in CI)");
      base = join(testDir, name, "test");
      file = `${p.id}.json`;
      if (!existsSync(join(base, file))) continue;
      const want = manifest.test.parts[p.id];
      if (!want) unverified.push(p.id);
      else if (partHash(base, p.id) !== want) throw new Error(`${name}/${p.id}: the test split does not match its recorded sha256`);
    }
    const data = readJson(join(base, file));
    if (Array.isArray(data.corpus)) corpus[p.id] = data.corpus;
    for (const it of data.items) {
      const out = { ...it, part: p.id };
      for (const k of ASSET_FIELDS) if (typeof out[k] === "string") out[k] = join(base, out[k]);
      items.push(out);
    }
  }
  return { manifest, items, unverified, corpus };
}

/**
 * Is a built test part complete enough to hash? Its <part>.json exists, has
 * the manifest's test count of items, and every asset it names is there. A
 * builder that died half way (clips extracted, images downloaded, no data
 * file or fewer items) must not get a recorded hash.
 */
export function completeTestPart(testDir, manifest, partId) {
  const p = manifest.parts.find((x) => x.id === partId);
  const f = join(testDir, `${partId}.json`);
  if (!p || !existsSync(f)) return false;
  let data;
  try {
    data = readJson(f);
  } catch {
    return false;
  }
  if (!Array.isArray(data.items) || (typeof p.test === "number" && data.items.length !== p.test)) return false;
  return data.items.every((it) => ASSET_FIELDS.every((k) => typeof it[k] !== "string" || existsSync(join(testDir, it[k]))));
}

/**
 * Record a CI hashes file into a manifest's test block. Parts the file does
 * not hash (their builder failed or was skipped in that run) are reset to
 * null, so an earlier run's hash cannot complete a split this run never built.
 */
export function applyTestHashes(manifest, partHashes) {
  for (const p of manifest.parts) {
    const sha = partHashes?.[p.id];
    manifest.test.parts[p.id] = typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha) ? sha : null;
  }
  const all = manifest.parts.every((p) => manifest.test.parts[p.id]);
  manifest.test.sha256 = all ? splitHash(Object.fromEntries(manifest.parts.map((p) => [p.id, manifest.test.parts[p.id]]))) : null;
  return manifest;
}

/**
 * What may be published when an eval harness throws: the error's class only.
 * Its message can quote a held-out prompt, a model output or owner text, and
 * the report goes to the Actions log and the job summary (scores only).
 */
export function publicHarnessError(e) {
  const kind = e && typeof e === "object" && typeof e.constructor?.name === "string" ? e.constructor.name : typeof e;
  return `the harness threw ${/^[A-Za-z]\w{0,40}$/.test(kind) ? kind : "an error"} (message withheld: it may quote test data; run the harness locally on the dev split)`;
}
