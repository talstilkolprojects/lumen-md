#!/usr/bin/env node
/**
 * Public Hebrew benchmarks (plan W11.H5): manifests in eval/public, results
 * in eval/results/<task>/<model>@<rev>.json, data in eval/public/.data/
 * (git-ignored, never committed or shipped).
 *
 *   npm run eval:public -- check                      the gate (ci:local step "public-eval")
 *   npm run eval:public -- list                       manifests, pinned or not, and what is owed
 *   npm run eval:public -- fetch <id> [--pin]         download a set (network); --pin writes sha256s into the manifest
 *   npm run eval:public -- freeze <id>                freeze a subset (tts-insva-fleurs-he: 200 prompts)
 *   npm run eval:public -- run <id> --engine <m.mjs> --model <registry id> --rev <revision>
 *   npm run eval:public -- run unicode-bidi           Unicode conformance (bidi-js as the UBA engine)
 *   npm run eval:public -- verdicts                   eval/public/_verdicts.json from the results (the app's gates)
 *   npm run eval:public -- coverage                   Hebrew registry entries without a public result
 *   npm run eval:public -- parity                     the ivrit.ai normaliser port vs the Python original (W11.H6)
 *
 * An engine module's default export is an async factory () => engine, where
 * the engine has the method the task needs (transcribe, synthesize + a
 * judge, dot, phonemize, recognize). Runs with tsx (the library is
 * TypeScript in src/eval/public).
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateManifest, isPinned, idsDigest } from "../src/eval/public/manifest.ts";
import { checkPublicEval, resultPath, latestResults, registryRevision } from "../src/eval/public/gate.ts";
import { normalizer, UNVERIFIED_PARITY } from "../src/eval/public/normalize.ts";
import { parseFleursTsv, parseAudioJsonl, scoreAsr } from "../src/eval/public/adapters/asr.ts";
import { freezePrompts, selectFrozen, scoreRoundTrip, voicePasses } from "../src/eval/public/adapters/ttsRoundTrip.ts";
import { parseNakdimonTest, scoreNikud } from "../src/eval/public/adapters/nikud.ts";
import { parseMilimJsonl, scoreG2p } from "../src/eval/public/adapters/g2p.ts";
import { parseImageJsonl, scoreHandwriting, handwritingExposed } from "../src/eval/public/adapters/handwriting.ts";
import { parseBidiCharacterTest, parseBidiTest, runCharacterTest, runClassTest, bidiJsEngine, BIDI_CONFORMANCE_MIN } from "../src/eval/public/adapters/bidi.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUB = join(root, "eval/public");
const DATA = join(PUB, ".data");
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function manifests() {
  return readdirSync(PUB)
    .filter((n) => n.endsWith(".json") && !n.startsWith("_"))
    .sort()
    .map((n) => ({ stem: n.slice(0, -5), path: join(PUB, n), json: readJson(join(PUB, n)) }));
}
function manifest(id) {
  const p = join(PUB, `${id}.json`);
  if (!existsSync(p)) die(`no manifest eval/public/${id}.json`);
  const m = readJson(p);
  const probs = validateManifest(m, id);
  if (probs.length) die(`eval/public/${id}.json: ${probs.join("; ")}`);
  return m;
}
function results() {
  const dir = join(root, "eval/results");
  const out = [];
  if (!existsSync(dir)) return out;
  for (const task of readdirSync(dir)) {
    const d = join(dir, task);
    if (!statSync(d).isDirectory()) continue;
    for (const f of readdirSync(d)) if (f.endsWith(".json")) out.push({ path: `eval/results/${task}/${f}`, json: readJson(join(d, f)) });
  }
  return out;
}
const registry = () => readJson(join(root, "models/registry.json")).models;
function die(msg) {
  console.error(`eval:public: ${msg}`);
  process.exit(2);
}
function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out;
}
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function writeResult(m, model, rev, engine, score, extra = {}) {
  if (!isPinned(m)) die(`eval/public/${m.id}.json is not pinned (revision, sha256 or frozen ids): a number on an unpinned set is not reproducible. Owed: ${(m.owed ?? []).join("; ")}`);
  const r = {
    schema: 1,
    task: m.id,
    dataset: { id: m.dataset.id, revision: m.dataset.revision, split: m.split },
    model: { id: model, revision: rev ?? null },
    engine,
    normalizer: m.normalizer,
    ...(UNVERIFIED_PARITY.has(m.normalizer) ? { normalizerParity: "unverified" } : {}),
    n: score.n,
    metrics: score.metrics,
    date: new Date().toISOString(),
    command: `npm run eval:public -- ${argv.join(" ")}`,
    machine: `${process.platform}-${process.arch} node ${process.version}`,
    synthetic: false,
    ...extra,
  };
  const out = join(root, resultPath(m.id, model, rev ?? null));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(r, null, 2) + "\n");
  console.log(`wrote ${relative(root, out)}\n${JSON.stringify(r.metrics)}`);
}

async function loadEngine() {
  const p = opt("engine");
  if (!p) die("--engine <module.mjs> is required (its default export is an async factory)");
  const mod = await import(pathToFileURL(resolve(p)).href);
  return await mod.default({ argv, dataDir: DATA });
}

const verifyFiles = (m) => {
  const dir = join(DATA, m.id);
  if (m.dataset.hub === "github") {
    const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim();
    if (head !== m.dataset.revision) die(`${relative(root, dir)} is at ${head || "nothing"}, the manifest pins ${m.dataset.revision}: npm run eval:public -- fetch ${m.id}`);
    for (const f of m.dataset.files) if (!existsSync(join(dir, f.path))) die(`missing ${f.path} in ${relative(root, dir)}`);
    return dir;
  }
  for (const f of m.dataset.files) {
    const p = join(dir, f.path);
    if (!existsSync(p)) die(`missing ${relative(root, p)}: npm run eval:public -- fetch ${m.id}`);
    if (f.sha256 && sha256(p) !== f.sha256) die(`${relative(root, p)}: sha256 differs from the manifest (the set changed under the pin)`);
  }
  return dir;
};

async function run(id) {
  const m = manifest(id);
  if (m.task === "bidi-conformance") return runBidi(m);
  const dir = verifyFiles(m);
  const model = opt("model");
  const rev = opt("rev") ?? null;
  if (!model) die("--model <registry id> is required");
  const reg = registry().find((e) => e.id === model);
  const pinned = registryRevision(reg);
  if (pinned && rev !== pinned) die(`${model} is pinned at ${pinned} in models/registry.json; --rev ${rev} would be stale on arrival`);
  const text = (f) => readFileSync(join(dir, f), "utf8");
  const abs = (it) => ({ ...it, audio: it.audio ? join(dir, it.audio) : it.audio, image: it.image ? join(dir, it.image) : it.image });
  const engine = await loadEngine();
  if (m.task === "asr") {
    const tsv = m.dataset.files[0].path;
    const items = (m.format === "fleurs-tsv" ? parseFleursTsv(text(tsv), m.split, dirname(tsv)) : parseAudioJsonl(text(m.export.output))).map(abs);
    return writeResult(m, model, rev, engine.id, await scoreAsr(items, engine, normalizer(m.normalizer)));
  }
  if (m.task === "tts-roundtrip") {
    const all = parseFleursTsv(text(m.dataset.files[0].path), m.split, dirname(m.dataset.files[0].path)).map(abs);
    const prompts = selectFrozen(all, m.frozen.ids);
    if (!engine.judge) die("a tts-roundtrip engine module returns { id, synthesize, judge: { id, transcribe } }");
    const s = await scoreRoundTrip(prompts, engine, engine.judge, normalizer(m.normalizer));
    return writeResult(m, model, rev, `${engine.id} judged by ${s.judge}`, s, { pass: voicePasses(s.metrics) });
  }
  if (m.task === "nikud") {
    const roots = m.dataset.files.map((f) => f.path.replace(/\/+$/, ""));
    const files = Object.fromEntries(walk(dir).filter((f) => f.endsWith(".txt") && roots.some((r) => f === r || f.startsWith(`${r}/`))).map((f) => [f, text(f)]));
    return writeResult(m, model, rev, engine.id, await scoreNikud(parseNakdimonTest(files), engine));
  }
  if (m.task === "g2p") return writeResult(m, model, rev, engine.id, await scoreG2p(parseMilimJsonl(text(m.export?.output ?? m.dataset.files[0].path)), engine));
  if (m.task === "ocr-handwriting") {
    const s = await scoreHandwriting(parseImageJsonl(text(m.export.output)).map(abs), engine);
    return writeResult(m, model, rev, engine.id, s, { exposed: handwritingExposed(s.metrics) });
  }
  die(`no runner for task "${m.task}" here (NER, lemma, retrieval and LLM runners come with their plan tasks)`);
}

async function runBidi(m) {
  const dir = join(DATA, m.id);
  const ct = join(dir, "BidiCharacterTest.txt");
  const bt = join(dir, "BidiTest.txt");
  if (!existsSync(ct)) {
    console.log(`skip: ${relative(root, ct)} is not downloaded (npm run eval:public -- fetch ${m.id})`);
    return;
  }
  verifyFiles(m);
  let engine = null;
  try {
    const bidi = (await import("bidi-js")).default();
    const X9 = new Set(["RLE", "LRE", "RLO", "LRO", "PDF", "BN"]);
    engine = bidiJsEngine(bidi, (cp) => X9.has(bidi.getBidiCharTypeName(String.fromCodePoint(cp))));
  } catch {
    console.log("bidi-js is not installed: levels and order are not checked, only Lumen's paragraph level");
  }
  const rep = runCharacterTest(parseBidiCharacterTest(readFileSync(ct, "utf8")), { engine });
  const reps = [rep];
  if (engine && existsSync(bt)) reps.push(runClassTest(parseBidiTest(readFileSync(bt, "utf8")), engine));
  for (const r of reps) {
    console.log(`${r.file}: ${r.passed}/${r.rows} (${(r.rate * 100).toFixed(3)} %); paragraph level: ${r.checks.paragraphLevel ? "Lumen" : "—"}; levels/order: ${r.checks.levels ?? "not checked"}`);
    for (const [k, v] of Object.entries(r.failures)) if (v.count) console.log(`  ${k}: ${v.count} rows, e.g. lines ${v.examples.join(", ")}`);
  }
  const report = join(root, "eval/results", m.id, "report.json");
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, JSON.stringify({ unicode: m.dataset.revision, date: new Date().toISOString(), reports: reps }, null, 2) + "\n");
  // The paragraph-level rule is Lumen's: its "revision" is the strong table it ran on.
  const table = createHash("sha256").update(readFileSync(join(root, "src/lib/bidiStrong.generated.ts"))).digest("hex").slice(0, 12);
  const metrics = { characterTest: Math.round(rep.rate * 1e6) / 1e6, paragraphLevelFailures: rep.failures.paragraphLevel.count, levelFailures: rep.failures.levels.count, orderFailures: rep.failures.order.count };
  if (reps[1]) metrics.bidiTest = Math.round(reps[1].rate * 1e6) / 1e6;
  writeResult(m, "lumen-md/bidi", `table-${table}`, `firstStrong + ${engine?.id ?? "no UBA engine"}`, { n: rep.rows, metrics });
  if (!(rep.rate >= BIDI_CONFORMANCE_MIN)) {
    console.error(`✗ BidiCharacterTest ${(rep.rate * 100).toFixed(3)} % < ${BIDI_CONFORMANCE_MIN * 100} %`);
    process.exit(1);
  }
  console.log("✓ bidi conformance");
}

function fetchSet(id) {
  const m = manifest(id);
  const dir = join(DATA, id);
  mkdirSync(dir, { recursive: true });
  if (m.dataset.hub === "github") {
    if (!existsSync(join(dir, ".git")) && spawnSync("git", ["clone", "--filter=blob:none", "--no-checkout", m.dataset.url, dir], { stdio: "inherit" }).status !== 0) die("git clone failed");
    if (!m.dataset.revision) die(`${id}: pin dataset.revision to a commit first`);
    if (spawnSync("git", ["-C", dir, "checkout", "--detach", m.dataset.revision], { stdio: "inherit" }).status !== 0) die("git checkout failed");
    return;
  }
  if (m.dataset.hub === "huggingface") {
    const args = ["download", m.dataset.id, "--repo-type", "dataset", "--local-dir", dir, ...(m.dataset.revision ? ["--revision", m.dataset.revision] : []), ...m.dataset.files.map((f) => f.path)];
    const r = spawnSync("huggingface-cli", args, { stdio: "inherit" });
    if (r.status !== 0) die("huggingface-cli download failed (pip install -U huggingface_hub; accept the dataset's terms on the Hub first if it is gated)");
  } else {
    for (const f of m.dataset.files) {
      const url = f.url ?? new URL(f.path, m.dataset.url).href;
      mkdirSync(dirname(join(dir, f.path)), { recursive: true });
      const r = spawnSync("curl", ["-fsSL", "-o", join(dir, f.path), url], { stdio: "inherit" });
      if (r.status !== 0) die(`download failed: ${url}`);
    }
  }
  for (const f of m.dataset.files) if (/\.tar\.gz$/.test(f.path) && existsSync(join(dir, f.path))) spawnSync("tar", ["-xzf", join(dir, f.path), "-C", dirname(join(dir, f.path))], { stdio: "inherit" });
  if (m.export) console.log(`next: python3 ${m.export.script} ${relative(root, dir)} (writes ${m.export.output})`);
  let changed = false;
  for (const f of m.dataset.files) {
    const p = join(dir, f.path);
    if (!existsSync(p)) continue;
    const h = sha256(p);
    if (f.sha256 && f.sha256 !== h) die(`${f.path}: sha256 ${h} ≠ manifest ${f.sha256}`);
    if (!f.sha256) {
      console.log(`${f.path}: sha256 ${h} (${statSync(p).size} bytes)${argv.includes("--pin") ? " → pinned" : " — rerun with --pin to write it"}`);
      if (argv.includes("--pin")) {
        f.sha256 = h;
        f.bytes = statSync(p).size;
        changed = true;
      }
    }
  }
  if (changed) writeFileSync(join(PUB, `${id}.json`), JSON.stringify(m, null, 2) + "\n");
}

async function freeze(id) {
  const m = manifest(id);
  if (!m.frozen) die(`${id} has no frozen subset`);
  const dir = verifyFiles(m);
  const tsv = m.dataset.files[0].path;
  const prompts = freezePrompts(parseFleursTsv(readFileSync(join(dir, tsv), "utf8"), m.split, dirname(tsv)), m.frozen.count);
  m.frozen.ids = prompts.map((p) => p.id);
  m.frozen.sha256 = await idsDigest(m.frozen.ids);
  writeFileSync(join(PUB, `${id}.json`), JSON.stringify(m, null, 2) + "\n");
  console.log(`froze ${m.frozen.count} prompts, sha256 ${m.frozen.sha256}`);
}

function trackedAndDist() {
  const g = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  const tracked = g.status === 0 ? g.stdout.split("\n").filter(Boolean) : [];
  return [...tracked, ...walk(join(root, "dist")).map((f) => `dist/${f}`)];
}

function check() {
  const probs = checkPublicEval({ manifests: manifests(), results: results().filter((r) => !r.path.endsWith("/report.json")), registry: registry(), files: trackedAndDist() });
  const unpinned = manifests().filter((m) => !validateManifest(m.json, m.stem).length && !isPinned(m.json));
  if (unpinned.length) console.log(`not pinned yet (a run refuses them): ${unpinned.map((m) => m.stem).join(", ")}`);
  if (probs.length) {
    for (const p of probs) console.error(`✗ ${p}`);
    process.exit(1);
  }
  console.log(`✓ public eval: ${manifests().length} manifests, ${results().length} result files, no dataset file in the repo or dist`);
}

function verdicts() {
  const latest = latestResults(results().map((r) => r.json).filter((r) => r.schema === 1));
  const out = { about: "Generated by `npm run eval:public -- verdicts` from eval/results; read by the app's gates (W11.H8 voices, W11.H14 handwriting). Do not edit.", voices: {}, handwriting: {} };
  for (const r of latest) {
    if (r.task === "tts-insva-fleurs-he") out.voices[r.model.id] = { pass: voicePasses(r.metrics), cer: r.metrics.cer, naturalCer: r.metrics.naturalCer, result: resultPath(r.task, r.model.id, r.model.revision) };
    if (r.task === "ocr-handwriting-ivrit") out.handwriting[r.model.id] = { exposed: handwritingExposed(r.metrics), medianCer: r.metrics.medianCer, result: resultPath(r.task, r.model.id, r.model.revision) };
  }
  writeFileSync(join(PUB, "_verdicts.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote eval/public/_verdicts.json (${Object.keys(out.voices).length} voices, ${Object.keys(out.handwriting).length} handwriting engines)`);
}

function coverage() {
  const have = new Set(results().map((r) => r.json?.model?.id));
  const missing = registry().filter((e) => Array.isArray(e.benchmarks) && e.benchmarks.length && !have.has(e.id));
  for (const e of missing) console.log(`no public result yet: ${e.id} (${e.benchmarks.join(", ")})`);
  console.log(`${missing.length} Hebrew registry entries without a public result`);
}

/** W11.H6: the TypeScript port must equal the Python original on every parity sample (≥ 50). */
function parity() {
  const p = join(DATA, "normalizer-parity.jsonl");
  if (!existsSync(p)) die("no eval/public/.data/normalizer-parity.jsonl: run scripts/eval-public/normalizer_parity.py first");
  const rows = readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const norm = normalizer("ivrit-leaderboard");
  const bad = rows.filter((r) => norm(r.input) !== r.expected);
  for (const r of bad.slice(0, 10)) console.error(`✗ ${JSON.stringify(r.input)}\n  python: ${JSON.stringify(r.expected)}\n  ours:   ${JSON.stringify(norm(r.input))}`);
  console.log(`normaliser parity: ${rows.length - bad.length}/${rows.length}`);
  if (rows.length < 50 || bad.length) process.exit(1);
}

if (cmd === "check") check();
else if (cmd === "parity") parity();
else if (cmd === "list") for (const m of manifests()) console.log(`${m.stem}\t${isPinned(m.json) ? "pinned" : "NOT pinned"}\t${(m.json.owed ?? []).join(" | ")}`);
else if (cmd === "fetch") fetchSet(argv[1]);
else if (cmd === "freeze") await freeze(argv[1]);
else if (cmd === "run") await run(argv[1]);
else if (cmd === "verdicts") verdicts();
else if (cmd === "coverage") coverage();
else {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
  process.exit(cmd ? 2 : 0);
}
