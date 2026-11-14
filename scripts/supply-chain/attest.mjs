#!/usr/bin/env node
/**
 * Build a release and record how it was built (plan W7.22): SLSA v1
 * provenance in an in-toto statement, DSSE-signed with the build host's key.
 *
 *   node scripts/supply-chain/attest.mjs --out release -- <the release build command (W4.5, #492)>
 *   node scripts/supply-chain/attest.mjs --out release --no-run      attest a folder that is already built
 *
 * Writes <out>/provenance.intoto.jsonl (one DSSE envelope) and <out>/build.log.
 * Every file in <out> is a subject, except signatures and attestations.
 *
 * With Witness installed (`witness` on PATH, scripts/supply-chain/install-tools.sh)
 * and LUMEN_WITNESS_KEY set, the build runs under `witness run --step build
 * -a slsa …` as well, and its attestation is kept as <out>/provenance.witness.json
 * for `witness verify` (--engine witness forces it, --engine node skips it).
 *
 * Options / environment:
 *   --key <pem>   the build key (default LUMEN_NIGHTLY_KEY: the factory host's Ed25519 key, W6.5)
 *   --host <id>   the builder's name in the provenance (default LUMEN_FACTORY_HOST, else "local")
 * Exit: the build's exit code; 2 on a setup error. A failed build gets no provenance.
 */
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { INTOTO_PAYLOAD, NOT_SUBJECT, provenanceStatement, sha256, signEnvelope, witnessRunArgs } from "./lib.mjs";

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const opts = dash >= 0 ? argv.slice(0, dash) : argv;
const command = dash >= 0 ? argv.slice(dash + 1) : [];
const opt = (name) => {
  const i = opts.indexOf(`--${name}`);
  return i >= 0 ? opts[i + 1] : undefined;
};
const env = process.env;
const die = (msg) => {
  console.error(`attest: ${msg}`);
  process.exit(2);
};
const out = resolve(opt("out") ?? "release");
const keyFile = opt("key") ?? env.LUMEN_NIGHTLY_KEY;
if (!keyFile || !existsSync(keyFile)) die("no build key: pass --key or set LUMEN_NIGHTLY_KEY (the factory host's key)");
if (!opts.includes("--no-run") && !command.length) die("give the build command after --, or --no-run");
const host = opt("host") ?? env.LUMEN_FACTORY_HOST ?? "local";
if (!/^[\w.-]+$/.test(host)) die("--host: letters, digits, . _ - only");
const engine = opt("engine") ?? "auto";
const git = (...a) => spawnSync("git", a, { encoding: "utf8" });
const commit = git("rev-parse", "HEAD").stdout.trim();
if (!/^[0-9a-f]{40}$/.test(commit)) die("not in a git checkout");
const ref = git("symbolic-ref", "-q", "HEAD").stdout.trim() || null;
const outRel = relative(process.cwd(), out);
// Generated output is not "uncommitted source": the release folder and untracked ignored files don't count.
const dirty = git("status", "--porcelain", "--untracked-files=no", "--", ".", `:(exclude)${outRel}`).stdout.trim().length > 0;

const startedOn = new Date().toISOString();
let status = 0;
const witness = engine !== "node" && env.LUMEN_WITNESS_KEY && spawnSync("witness", ["version"], { stdio: "ignore" }).status === 0;
if (engine === "witness" && !witness) die("--engine witness: `witness` is not on PATH or LUMEN_WITNESS_KEY is unset (scripts/supply-chain/install-tools.sh)");
if (!opts.includes("--no-run")) {
  const runArgv = witness ? ["witness", witnessRunArgs({ key: env.LUMEN_WITNESS_KEY, out: join(out, "provenance.witness.json"), productGlob: `${outRel}/*`, command })] : [command[0], command.slice(1)];
  console.log(`attest: building with ${witness ? "witness run (SLSA attestor)" : "no wrapper"}: ${command.join(" ")}`);
  const log = [];
  const r = spawnSync(runArgv[0], runArgv[1], { stdio: ["inherit", "pipe", "pipe"], maxBuffer: 1 << 30 });
  for (const chunk of [r.stdout, r.stderr]) if (chunk) {
    process.stdout.write(chunk);
    log.push(chunk);
  }
  status = r.status ?? 1;
  if (status !== 0) {
    console.error(`attest: the build failed (exit ${status}); no provenance`);
    process.exit(status);
  }
  const stream = createWriteStream(join(out, "build.log"));
  for (const c of log) stream.write(c);
  stream.end();
  await new Promise((r2) => stream.on("close", r2));
}
const finishedOn = new Date().toISOString();
if (!existsSync(out)) die(`${out} does not exist after the build`);

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else {
      const rel = relative(out, p).split("\\").join("/");
      if (!NOT_SUBJECT.test(rel) && rel !== "build.log") files.push({ name: rel, sha256: sha256(readFileSync(p)) });
    }
  }
};
walk(out);
if (!files.length) die(`no release files in ${out}`);
const lockfiles = ["package-lock.json", "src-tauri/Cargo.lock"].filter((f) => existsSync(f)).map((name) => ({ name, sha256: sha256(readFileSync(name)) }));
const byproducts = existsSync(join(out, "build.log")) ? [{ name: "build.log", sha256: sha256(readFileSync(join(out, "build.log"))) }] : [];
const statement = provenanceStatement({
  files,
  command: command.length ? command : ["(attested an existing folder: --no-run)"],
  source: { commit, ref, dirty },
  lockfiles,
  host,
  startedOn,
  finishedOn,
  invocationId: env.BUILDKITE_BUILD_URL ?? `urn:uuid:${randomUUID()}`,
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: availableParallelism(), witness: Boolean(witness) },
  byproducts,
});
const envelope = signEnvelope(INTOTO_PAYLOAD, JSON.stringify(statement), readFileSync(keyFile, "utf8"));
writeFileSync(join(out, "provenance.intoto.jsonl"), JSON.stringify(envelope) + "\n");
console.log(`attest: ${files.length} subjects, commit ${commit.slice(0, 12)}${dirty ? " (DIRTY tree: the policy refuses it)" : ""}, builder ${host}, key ${envelope.signatures[0].keyid.slice(0, 16)} → ${outRel}/provenance.intoto.jsonl`);
