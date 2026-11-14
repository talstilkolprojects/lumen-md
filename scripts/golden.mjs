#!/usr/bin/env node
/**
 * Golden sets CLI (plan 7.1). The rules are in scripts/lib/golden.mjs.
 *
 *   node scripts/golden.mjs verify                 every set: manifest, sha256, canaries, licence files,
 *                                                  and no test-split file anywhere in the repo (exit 1 on a problem)
 *   node scripts/golden.mjs status                 one line per set (add --json for the full table)
 *   node scripts/golden.mjs show <set> [--part p] [--limit n]   dev items as JSON lines
 *   node scripts/golden.mjs canaries               every canary string (to search a corpus or a model's output for)
 *   node scripts/golden.mjs freeze <set> --reason "…"           re-hash after a sanctioned change (new version)
 *   node scripts/golden.mjs attach-dev <set> <part> --reason "…"
 *                                                  after hf_build.py wrote dev/<part>.json (or selection/<part>.json)
 *   node scripts/golden.mjs check-test --dir DIR [set …]        a CI-built test split against the recorded sha256
 *   node scripts/golden.mjs record-test --dir DIR [set …] --reason "…"
 *                                                  record a CI-built test split's sha256 (prints hashes only)
 *   node scripts/golden.mjs hash-test --dir DIR --out hashes.json      the part hashes of a CI-built split (no data)
 *   node scripts/golden.mjs record-test --hashes hashes.json --reason "…"   record them where the split is not
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkTest, freezeSet, listFiles, partFiles, partHash, partWaitsFor, readJson, recordTest, scanForTestData, splitHash, validateAll, validateSet, writeJson, applyTestHashes, completeTestPart } from "./lib/golden.mjs";
import { GOLDEN, ROOT } from "./golden/common.mjs";
import { setById } from "./golden/defs.mjs";
import { writeDocs } from "./golden/docs.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(name);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  rest.splice(i, 2);
  return v;
};
const has = (name) => {
  const i = rest.indexOf(name);
  if (i >= 0) rest.splice(i, 1);
  return i >= 0;
};
const cache = opt("--cache") ?? process.env.GOLDEN_CACHE;
const die = (msg, code = 2) => {
  console.error(msg);
  process.exit(code);
};

function setsArg() {
  const names = rest.filter((a) => !a.startsWith("--"));
  return names.length ? names : validateAll(GOLDEN).map((r) => r.name);
}

switch (cmd) {
  case "verify": {
    const results = validateAll(GOLDEN);
    let bad = 0;
    for (const r of results) {
      if (r.problems.length) {
        bad++;
        console.log(`✗ ${r.name}`);
        for (const p of r.problems) console.log(`    ${p}`);
      } else console.log(`✓ ${r.name} (v${r.manifest.version}, ${r.manifest.status})`);
    }
    const leaks = scanForTestData(ROOT);
    for (const l of leaks) console.log(`✗ ${l}`);
    console.log(`\n${results.length} sets, ${bad} with problems, ${leaks.length} test-data leaks`);
    process.exit(bad || leaks.length ? 1 : 0);
  }
  case "status": {
    const rows = validateAll(GOLDEN).map(({ name, manifest: m, problems }) => {
      if (!m) return { set: name, problems: problems.length };
      const devIn = m.parts.reduce((a, p) => a + (p.status === "local-only" ? (p.devSelection ? p.dev : 0) : p.status === "built" && (p.devFiles ?? []).length ? p.dev : 0), 0);
      const devAll = m.parts.reduce((a, p) => a + p.dev, 0);
      const recorded = m.parts.filter((p) => m.test.parts[p.id]).length;
      return { set: name, version: m.version, status: m.status, target: m.target, dev: `${devIn}/${devAll}`, test: m.test.items, testRecorded: `${recorded}/${m.parts.length}`, licence: m.license, waiting: m.parts.map((p) => [p.id, partWaitsFor(p, m.test)]).filter(([, w]) => w), problems: problems.length };
    });
    if (has("--json")) console.log(JSON.stringify(rows, null, 2));
    else for (const r of rows) console.log(`${r.set.padEnd(10)} v${r.version} ${String(r.status).padEnd(8)} target ${String(r.target).padStart(3)}  dev ${r.dev.padEnd(7)} test ${String(r.test).padStart(3)} (sha256 ${r.testRecorded})  ${r.licence}${r.problems ? `  ✗ ${r.problems} problem(s)` : ""}`);
    break;
  }
  case "show": {
    const [name] = rest.filter((a) => !a.startsWith("--"));
    const part = opt("--part");
    const limit = Number(opt("--limit") ?? Infinity);
    const m = readJson(join(GOLDEN, name, "manifest.json"));
    let n = 0;
    for (const p of m.parts) {
      if (part && p.id !== part) continue;
      const f = (p.devFiles ?? []).find((x) => x.endsWith(".json"));
      if (!f) continue;
      for (const it of readJson(join(GOLDEN, name, f)).items) if (n++ < limit) console.log(JSON.stringify({ part: p.id, ...it }));
    }
    break;
  }
  case "canaries": {
    for (const r of validateAll(GOLDEN)) console.log(`${r.name}\tdev\t${r.manifest?.canary}\n${r.name}\ttest\t${r.manifest?.test?.canary}`);
    break;
  }
  case "freeze": {
    const reason = opt("--reason");
    for (const name of setsArg()) {
      const def = setById(name);
      if (def) writeDocs(def, join(GOLDEN, name), cache ?? join(process.env.RUNNER_TEMP ?? "/tmp", "lumen-golden-cache"));
      const { manifest, changed } = freezeSet(join(GOLDEN, name), { reason });
      console.log(`${name}: ${changed ? `version ${manifest.version}` : "unchanged"} (${manifest.status})`);
    }
    break;
  }
  case "attach-dev": {
    const reason = opt("--reason");
    const [name, partId] = rest.filter((a) => !a.startsWith("--"));
    const dir = join(GOLDEN, name);
    const m = readJson(join(dir, "manifest.json"));
    const p = m.parts.find((x) => x.id === partId);
    if (!p) die(`${name} has no part ${partId}`);
    if (p.status === "local-only") {
      if (!existsSync(join(dir, "selection", `${partId}.json`))) die(`no selection/${partId}.json`);
      p.devSelection = `selection/${partId}.json`;
    } else {
      const files = listFiles(join(dir, "dev")).filter((f) => f === `${partId}.json` || f.startsWith(`${partId}/`));
      if (!files.includes(`${partId}.json`)) die(`no dev/${partId}.json`);
      p.devFiles = files.map((f) => `dev/${f}`);
      if (p.status === "workflow-pending") p.status = "built";
    }
    writeJson(join(dir, "manifest.json"), m);
    const def = setById(name);
    if (def) writeDocs(def, dir, cache ?? join(process.env.RUNNER_TEMP ?? "/tmp", "lumen-golden-cache"));
    const { problems } = validateSet(dir, name);
    const { manifest, changed } = freezeSet(dir, { reason });
    console.log(`${name}/${partId}: attached; ${changed ? `version ${manifest.version}` : "unchanged"}${problems.length ? ` (before freeze: ${problems.length} problem(s))` : ""}`);
    break;
  }
  case "hash-test": {
    // Hashes only (no data): what the record job needs from the job that built the split.
    const dirArg = opt("--dir");
    const outFile = opt("--out");
    if (!dirArg || !outFile) die("hash-test needs --dir and --out");
    const hashes = {};
    for (const name of setsArg()) {
      const testDir = join(dirArg, name, "test");
      if (!existsSync(testDir)) continue;
      // Only complete parts (data file, declared item count, every asset): a half-built part gets no hash.
      const m = readJson(join(GOLDEN, name, "manifest.json"));
      hashes[name] = Object.fromEntries(m.parts.filter((p) => completeTestPart(testDir, m, p.id)).map((p) => [p.id, partHash(testDir, p.id)]));
    }
    writeJson(outFile, hashes);
    for (const [k, v] of Object.entries(hashes)) console.log(`${k}: ${Object.keys(v).length} part(s) hashed`);
    break;
  }
  case "check-test":
  case "record-test": {
    const dirArg = opt("--dir");
    const hashesFile = opt("--hashes");
    const reason = opt("--reason");
    if (cmd === "record-test" && hashesFile) {
      // From a hashes file (the CI record job: it never sees the split).
      const hashes = readJson(hashesFile);
      // Every requested set, also one this run built nothing for (absent from the file): its hashes reset.
      for (const name of setsArg()) {
        const dir = join(GOLDEN, name);
        // Parts this run did not hash go back to null (applyTestHashes): no stale hash completes the split.
        const m = applyTestHashes(readJson(join(dir, "manifest.json")), hashes[name] ?? {});
        writeJson(join(dir, "manifest.json"), m);
        const def = setById(name);
        if (def) writeDocs(def, dir, cache ?? join(process.env.RUNNER_TEMP ?? "/tmp", "lumen-golden-cache"));
        const { manifest, changed } = freezeSet(dir, { reason: reason ?? "test split sha256 recorded from a CI run with GOLDEN_SEED" });
        console.log(`${name}: test sha256 ${m.test.sha256 ?? "(partial)"}; ${changed ? `version ${manifest.version}` : "unchanged"}`);
      }
      break;
    }
    if (!dirArg) die(`${cmd} needs --dir (the CI-built split)`);
    let failed = false;
    for (const name of setsArg()) {
      const testDir = join(dirArg, name, "test");
      if (!existsSync(testDir)) {
        console.log(`${name}: no test split in ${dirArg}`);
        continue;
      }
      if (cmd === "record-test") {
        const t = recordTest(join(GOLDEN, name), testDir);
        const def = setById(name);
        if (def) writeDocs(def, join(GOLDEN, name), cache ?? join(process.env.RUNNER_TEMP ?? "/tmp", "lumen-golden-cache"));
        const { manifest, changed } = freezeSet(join(GOLDEN, name), { reason: reason ?? "test split sha256 recorded from a CI run with GOLDEN_SEED" });
        console.log(`${name}: test sha256 ${t.sha256 ?? "(partial)"}; ${changed ? `version ${manifest.version}` : "unchanged"}`);
        for (const [k, v] of Object.entries(t.parts)) console.log(`  ${k}: ${v ?? "not built"}`);
      } else
        for (const r of checkTest(join(GOLDEN, name), testDir)) {
          console.log(`${name}/${r.part}: ${r.status}${r.sha256 ? ` ${r.sha256}` : ""}`);
          if (r.status === "mismatch") failed = true;
        }
    }
    process.exit(failed ? 1 : 0);
  }
  default:
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*?/, "").replace(/^ \* ?/gm, ""));
    process.exit(cmd ? 2 : 0);
}

