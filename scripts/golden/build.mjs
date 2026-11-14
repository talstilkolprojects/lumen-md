#!/usr/bin/env node
/**
 * Build the golden sets' parts that come from GitHub, npm or a generator in
 * this repo (plan 7.1). Hugging Face, Tatoeba and Wikipedia parts are built
 * by scripts/golden/hf_build.py in .github/workflows/golden-sets.yml.
 *
 *   node scripts/golden/build.mjs [set ...] --split dev
 *       the public dev split, into eval/golden/<set>/dev/ (committed), then
 *       SOURCES.md, LICENSE and a freeze
 *
 *   GOLDEN_SEED=… node scripts/golden/build.mjs [set ...] --split test --out DIR
 *       the held-out test split, into DIR/<set>/test/ — never inside the repo.
 *       Prints only counts and sha256 (no item text). Then
 *       `node scripts/golden.mjs check-test --dir DIR` compares every part
 *       (these, the workflow's and the owner's) with the recorded hashes, or
 *       `record-test` records them (a new version).
 *
 *   --cache DIR    downloads (default $GOLDEN_CACHE or <tmp>/lumen-golden-cache)
 *   --reason "…"   required when a frozen set changes (new version)
 *
 * Every source is pinned (commit SHA / exact version, sha256 where known) and
 * every choice is seeded, so a rebuild reproduces a split byte for byte.
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { contentHash, freezeSet, partHash, readJson, writeJson, writeSplitPart } from "../lib/golden.mjs";
import { ROOT, ensureSet } from "./common.mjs";
import { SETS } from "./defs.mjs";
import { writeDocs } from "./docs.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const cache = resolve(opt("--cache") ?? process.env.GOLDEN_CACHE ?? join(tmpdir(), "lumen-golden-cache"));
const reason = opt("--reason");
const split = opt("--split") ?? "dev";
const out = opt("--out");
const docsOnly = flag("--docs-only");
const names = args.filter((a) => !a.startsWith("--"));
const secret = process.env.GOLDEN_SEED;

if (!["dev", "test"].includes(split)) fail("--split must be dev or test");
if (split === "test") {
  if (!secret) fail("the test split needs GOLDEN_SEED (a GitHub Actions secret, plan 15.9)");
  if (!out) fail("--split test needs --out DIR (outside the repo)");
  const rel = relative(ROOT, resolve(out));
  if (!rel.startsWith("..") && !isAbsolute(rel)) fail(`--out ${out} is inside the repo: the test split is never written there`);
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

/** set → part → module export (lazy). */
const PARTS = {
  "mt-he-en": { ntrex: ["./sets/mt-typos.mjs", "ntrex"] },
  "typos-he": { synthetic: ["./sets/mt-typos.mjs", "typos"] },
  retrieval: { heq: ["./sets/retrieval.mjs", "heq"] },
  "ner-pii": { iahltwiki: ["./sets/pii.mjs", "iahlt"], synthetic: ["./sets/pii.mjs", "synthetic"] },
  injection: { bipia: ["./sets/injection.mjs", "bipia"] },
  langid: { hard: ["./sets/langid.mjs", "hard"] },
  caption: { xm3600: ["./sets/caption.mjs", "xm3600"] },
  nikud: { benyehuda: ["./sets/nikud.mjs", "benyehuda"], nakdimon: ["./sets/nikud.mjs", "nakdimon"] },
  "ocr-he": { lines: ["./sets/ocr.mjs", "lines"], pages: ["./sets/ocr.mjs", "pages"] },
};

/** Build one part of one split. Throws on failure; the caller reports it without any item content. */
async function buildPart(def, setDir, manifest, partId, file, name) {
  const spec = (await import(file))[name];
  const p = manifest.parts.find((x) => x.id === partId);
  const ctx = { cache, def, manifest, part: p };
  const pool = await spec.pool(ctx);
  const { dev, test } = spec.select(pool, { set: def.id, part: partId, nDev: p.dev, nTest: split === "test" ? p.test : 0, secret });
  const items = split === "dev" ? dev : test;
  const splitDir = split === "dev" ? join(setDir, "dev") : join(resolve(out), def.id, "test");
  rmSync(join(splitDir, partId), { recursive: true, force: true });
  const finished = spec.finish ? await spec.finish(items, { ...ctx, split, splitDir, partId }) : { items, complete: true };

  if (split === "dev" && p.status === "local-only") {
    // Only ids and hashes reach the repo.
    const selItems = finished.items.map(({ text, ...rest }) => ({ ...rest, sha256: contentHash({ text }) }));
    const selFile = `selection/${partId}.json`;
    writeJson(join(setDir, selFile), { canary: manifest.canary, set: def.id, part: partId, split: "dev", license: p.license, note: "Local-only part: the text is never committed. `python -I scripts/golden/hf_build.py fetch-local` downloads it into local/ and checks each sha256.", ...spec.meta(pool, finished.items), items: selItems });
    p.devSelection = selFile;
    report.push({ set: def.id, part: partId, split, items: selItems.length, note: "selection (ids + sha256)" });
    return;
  }
  const files = writeSplitPart(splitDir, { manifest, partId, split, items: finished.items, meta: spec.meta(pool, finished.items), extra: spec.extra?.(pool, split) ?? {} });
  if (split === "dev") {
    p.devFiles = files.map((f) => `dev/${f}`);
    if (p.status === "workflow-pending" && finished.complete) p.status = "built";
    report.push({ set: def.id, part: partId, split, items: finished.items.length, note: finished.complete ? "" : "assets pending (workflow)" });
  } else report.push({ set: def.id, part: partId, split, items: finished.items.length, sha256: partHash(splitDir, partId) });
}

const selected = names.length ? SETS.filter((s) => names.includes(s.id)) : SETS;
if (names.length && selected.length !== names.length) fail(`unknown set: ${names.filter((n) => !SETS.some((s) => s.id === n)).join(", ")}`);

const report = [];
for (const def of selected) {
  const setDir = ensureSet(def);
  const manifest = readJson(join(setDir, "manifest.json"));
  for (const [partId, [file, name]] of Object.entries(docsOnly ? {} : (PARTS[def.id] ?? {}))) {
    try {
      await buildPart(def, setDir, manifest, partId, file, name);
    } catch (e) {
      process.exitCode = 1;
      // In a test build, never echo a message that might quote data: only the error's type and where.
      const where = String(e.stack ?? "").split("\n").find((l) => l.includes("scripts/golden")) ?? "";
      console.error(`${def.id}/${partId}: failed — ${split === "test" ? `${e.name} ${where.trim()}` : e.message}`);
    }
  }
  if (split === "dev") {
    writeJson(join(setDir, "manifest.json"), manifest);
    writeDocs(def, setDir, cache);
    try {
      const { manifest: m, changed } = freezeSet(setDir, { reason: reason ?? (manifest.frozen ? undefined : "dev split built and frozen; test split held out (plan 7.1)") });
      console.log(`${def.id}: ${changed ? `frozen as version ${m.version}` : "unchanged"} (${m.status})`);
    } catch (e) {
      console.error(`${def.id}: ${e.message}`);
      process.exitCode = 1;
    }
  }
}
for (const r of report) console.log(`${r.set}/${r.part}: ${r.split} ${r.items} items${r.sha256 ? ` sha256 ${r.sha256}` : ""}${r.note ? ` (${r.note})` : ""}`);
