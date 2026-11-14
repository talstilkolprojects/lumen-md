#!/usr/bin/env node
/**
 * HebOCRBench submission kit (plan W7.12). The input package (34,267 images in
 * five tracks) stays OUTSIDE the repo, on the Sandbox or the second host: its
 * images keep each source's terms, and only the organisers hold the gold.
 *
 *   node scripts/ocr/hebocrbench.mjs predict <package-dir> <out-dir> [--engine tesseract.js|cli] [--track bidi] [--limit N]
 *       Runs the app's OCR (src/ai/ocr.ts recognizeWithMixedFix on the committed
 *       tessdata_fast heb+eng, as scripts/ocr/cer-node.mjs does) on every image
 *       and writes <out-dir>/predictions/<track>.jsonl ({id, track, prediction})
 *       and <out-dir>/submission.json. `--engine cli` uses the Tesseract 5 CLI
 *       on the same models, for a host without npm (it skips ocrMixed's second
 *       pass, so it is labelled in submission.json and never published as ours).
 *   node scripts/ocr/hebocrbench.mjs check-clean <package-dir> [--dist dist]
 *       0 package images in the repo (git ls-files) or in dist: exit 1 otherwise.
 *   node scripts/ocr/hebocrbench.mjs record <scores.json> [--internal internal.json]
 *       Validates the organisers' scores (one per track, with date and version),
 *       appends them to eval/external/hebocrbench.json, and prints the gap to our
 *       internal CER (7.5). A gap over 5 points exits 3: open a fix task.
 *   node scripts/ocr/hebocrbench.mjs bidi <before-dir> <after-dir>
 *       The bidi track as a regression check for W5.4 and W5.5: new direction
 *       marks or reversed words in the predictions exit 4.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { tsImport } from "tsx/esm/api";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LANG_DIR = join(ROOT, "public/tesseract/lang");
const RESULTS = join(ROOT, "eval/external/hebocrbench.json");
const K = await tsImport("../../src/ai/hebocrbench.ts", import.meta.url);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const flag = (args, name, dflt) => {
  const i = args.indexOf(name);
  return i < 0 ? dflt : args[i + 1];
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function refuseInsideRepo(pkg) {
  if (K.isInside(resolve(pkg), ROOT)) {
    console.error(`hebocrbench: the package is inside the repo (${pkg}). Keep it outside: its images keep their sources' terms.`);
    process.exit(2);
  }
}

function gitCommit() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "unknown";
}

async function engineTesseractJs() {
  const { createRequire } = await import("node:module");
  const T = createRequire(import.meta.url)("tesseract.js");
  const { recognizeWithMixedFix } = await tsImport("../../src/ai/ocr.ts", import.meta.url);
  const opts = { langPath: LANG_DIR, gzip: true, cachePath: process.env.TESS_CACHE };
  const main = await T.createWorker(["heb", "eng"], T.OEM.LSTM_ONLY, opts);
  const heb = await T.createWorker(["heb"], T.OEM.LSTM_ONLY, opts);
  await heb.setParameters({ tessedit_pageseg_mode: T.PSM.SINGLE_WORD });
  const latin = await T.createWorker(["eng"], T.OEM.LSTM_ONLY, opts);
  await latin.setParameters({ tessedit_pageseg_mode: T.PSM.SINGLE_WORD });
  const version = createRequire(import.meta.url)("tesseract.js/package.json").version;
  return {
    name: `tesseract.js ${version} + ocrMixed (the app's path)`,
    recognize: async (file) => (await recognizeWithMixedFix(main, heb, readFileSync(file), latin)).text,
    close: async () => Promise.all([main.terminate(), heb.terminate(), latin.terminate()]),
  };
}

function engineCli() {
  const tess = mkdtempSync(join(tmpdir(), "hob-tessdata-"));
  for (const l of ["heb", "eng"]) writeFileSync(join(tess, `${l}.traineddata`), gunzipSync(readFileSync(join(LANG_DIR, `${l}.traineddata.gz`))));
  const v = spawnSync("tesseract", ["--version"], { encoding: "utf8" });
  if (v.status !== 0) throw new Error("tesseract CLI not found");
  return {
    name: `${v.stdout.split("\n")[0]} CLI, psm 6 (no ocrMixed pass: not the app's path)`,
    recognize: async (file) => {
      const r = spawnSync("tesseract", [file, "stdout", "-l", "heb+eng", "--tessdata-dir", tess, "--oem", "1", "--psm", "6"], { encoding: "utf8", maxBuffer: 64 << 20 });
      if (r.status !== 0) throw new Error(`tesseract failed on ${file}: ${r.stderr.slice(0, 200)}`);
      return r.stdout;
    },
    close: async () => undefined,
  };
}

async function predict(args) {
  const [pkg, out] = args;
  if (!pkg || !out) throw new Error("usage: predict <package-dir> <out-dir>");
  refuseInsideRepo(pkg);
  if (K.isInside(resolve(out), ROOT)) throw new Error("write predictions outside the repo too: they are derived from the package");
  const only = flag(args, "--track");
  const limit = Number(flag(args, "--limit", "Infinity"));
  const { items, unknown, perTrack } = K.listPackage(walk(pkg).map((p) => relative(pkg, p)));
  if (unknown.length) console.warn(`hebocrbench: ${unknown.length} images outside any track folder, e.g. ${unknown.slice(0, 3).join(", ")}`);
  for (const c of K.packageCoverage(perTrack)) console.log(`  ${c.track}: ${c.found} images (published: ${c.expected})${c.complete ? "" : " — partial"}`);
  const engine = flag(args, "--engine", "tesseract.js") === "cli" ? engineCli() : await engineTesseractJs();
  mkdirSync(join(out, "predictions"), { recursive: true });
  const done = Object.fromEntries(K.HOB_TRACKS.map((t) => [t.id, 0]));
  const lines = Object.fromEntries(K.HOB_TRACKS.map((t) => [t.id, []]));
  const t0 = Date.now();
  for (const it of items) {
    if (only && it.track !== only) continue;
    if (done[it.track] >= limit) continue;
    let text = "";
    try {
      text = await engine.recognize(join(pkg, it.path));
    } catch (e) {
      console.warn(`hebocrbench: ${it.track}/${it.id}: ${String(e).slice(0, 160)} (empty prediction)`);
    }
    lines[it.track].push(K.predictionLine(it, text));
    done[it.track]++;
  }
  await engine.close();
  for (const t of K.HOB_TRACKS) if (lines[t.id].length) writeFileSync(join(out, "predictions", `${t.id}.jsonl`), lines[t.id].join("\n") + "\n");
  const models = Object.fromEntries(["heb", "eng"].map((l) => [`${l}.traineddata.gz`, sha256(readFileSync(join(LANG_DIR, `${l}.traineddata.gz`)))]));
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const meta = K.submissionMeta({ version, commit: gitCommit(), date: new Date().toISOString().slice(0, 10), engine: engine.name, models, perTrack: done, notes: ["predictions in logical order, NFC, direction marks removed"] });
  writeFileSync(join(out, "submission.json"), JSON.stringify(meta, null, 1) + "\n");
  console.log(`hebocrbench: ${Object.values(done).reduce((a, b) => a + b, 0)} predictions in ${Math.round((Date.now() - t0) / 1000)} s → ${out}`);
}

function checkClean(args) {
  const [pkg] = args;
  if (!pkg) throw new Error("usage: check-clean <package-dir>");
  refuseInsideRepo(pkg);
  const hashes = new Set(walk(pkg).filter((p) => K.IMAGE_EXT.test(p)).map((p) => sha256(readFileSync(p))));
  const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).stdout.split("\0").filter(Boolean);
  const dist = join(ROOT, flag(args, "--dist", "dist"));
  const files = [...tracked.map((p) => join(ROOT, p)), ...(existsSync(dist) ? walk(dist) : [])]
    .filter((p) => K.IMAGE_EXT.test(p) && existsSync(p))
    .map((p) => ({ path: relative(ROOT, p), sha256: sha256(readFileSync(p)) }));
  const leaked = K.leakedImages(hashes, files);
  console.log(`hebocrbench check-clean: ${hashes.size} package images, ${files.length} repo/dist images compared, ${leaked.length} from the package`);
  for (const p of leaked.slice(0, 20)) console.log(`  ${p}`);
  process.exit(leaked.length ? 1 : 0);
}

function record(args) {
  const [file] = args;
  if (!file) throw new Error("usage: record <scores.json> [--internal internal.json]");
  const rec = JSON.parse(readFileSync(file, "utf8"));
  const errors = K.validateScoreRecord(rec);
  if (errors.length) {
    console.error("hebocrbench record: not published:\n  " + errors.join("\n  "));
    process.exit(2);
  }
  const all = JSON.parse(readFileSync(RESULTS, "utf8"));
  all.records = [...all.records.filter((r) => r.submission !== rec.submission), rec];
  writeFileSync(RESULTS, JSON.stringify(all, null, 1) + "\n");
  const internalFile = flag(args, "--internal");
  const internal = internalFile ? JSON.parse(readFileSync(internalFile, "utf8")) : {};
  const g = K.gaps(rec, internal);
  for (const x of g) console.log(`  ${x.track}: external ${(x.external * 100).toFixed(2)}%, internal ${(x.internal * 100).toFixed(2)}%, gap ${x.points} points${x.openFixTask ? " → OPEN A FIX TASK" : ""}`);
  process.exit(g.some((x) => x.openFixTask) ? 3 : 0);
}

function bidi(args) {
  const read = (d) => {
    const f = join(d, "predictions", "bidi.jsonl");
    return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const [a, b] = args;
  const r = K.bidiRegressions(read(a), read(b));
  console.log(`hebocrbench bidi: ${r.changed.length} predictions changed, ${r.newFailures.length} new failures (direction marks or reversed words)`);
  for (const f of r.newFailures.slice(0, 20)) console.log(`  ${f.id}: marks ${f.marks}, reversed ${f.reversed.join(" ")}`);
  process.exit(r.newFailures.length ? 4 : 0);
}

const [cmd, ...rest] = process.argv.slice(2);
const cmds = { predict, "check-clean": checkClean, record, bidi };
if (!cmds[cmd]) {
  console.error("usage: hebocrbench.mjs predict|check-clean|record|bidi …");
  process.exit(2);
}
await cmds[cmd](rest);
