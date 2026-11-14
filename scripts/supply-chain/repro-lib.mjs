/**
 * A build that two infrastructures reproduce (plan W7.23): the pure parts,
 * shared by dist-manifest.mjs, repro-compare.mjs and repro-two-paths.mjs.
 *
 * A *dist manifest* names every file of a build output with its SHA-256 and
 * size, plus what the build ran on: the commit, the lockfile's hash, Node, the
 * platform and the names of the VITE_* variables (a value never; only its
 * hash, because a VITE_* value ships in the bundle anyway and two builders
 * must agree on it). Two manifests of one commit must list the same files with
 * the same hashes; anything else is a finding, named per file.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filesUnder, sha256 } from "./lib.mjs";

export const MANIFEST_SCHEMA = "lumen-dist-manifest/v1";
/** The in-toto predicate for W7.22's attestation: "built identically on two infrastructures". */
export const PREDICATE_TYPE = "https://lumen-md.vercel.app/attestations/two-infra-build/v1";

/** Where a build carries its own manifest: Vercel's `manifest` gate writes it into dist/ (served at /.well-known/lumen-build.json). */
export const MANIFEST_PATH = ".well-known/lumen-build.json";
/** The plan's bar: this many consecutive commits with every file identical. */
export const STREAK_TARGET = 10;

/**
 * Files a builder adds to the build and that are never compared: the manifest
 * itself (in dist/ on Vercel) and the Cloudflare Worker's copy of it.
 */
export const BUILDER_FILES = [/^\.well-known\/lumen-build\.json$/, /^lumen-build\.json$/];

/** The commit a CI builder checked out: Cloudflare Workers Builds, Vercel, else git. */
export function commitOf(env, git) {
  return env.WORKERS_CI_COMMIT_SHA || env.VERCEL_GIT_COMMIT_SHA || env.LUMEN_COMMIT || git() || "unknown";
}

/** The VITE_* variables a build saw: names, and a hash per value (never the value). */
export function viteEnv(env) {
  return Object.fromEntries(
    Object.keys(env)
      .filter((k) => k.startsWith("VITE_"))
      .sort()
      .map((k) => [k, sha256(String(env[k])).slice(0, 16)]),
  );
}

/** The manifest of directory `dir` (default: everything but BUILDER_FILES). */
export function manifestOf(dir, meta = {}) {
  const files = {};
  let bytes = 0;
  for (const p of filesUnder(dir)) {
    if (BUILDER_FILES.some((re) => re.test(p))) continue;
    const data = readFileSync(join(dir, p));
    files[p] = { sha256: sha256(data), size: data.length };
    bytes += data.length;
  }
  return { schema: MANIFEST_SCHEMA, ...meta, fileCount: Object.keys(files).length, bytes, files };
}

/** The manifest's own digest: of its sorted file list only, so the metadata can differ. */
export function filesDigest(manifest) {
  const h = createHash("sha256");
  for (const p of Object.keys(manifest.files).sort()) h.update(`${manifest.files[p].sha256}  ${p}\n`);
  return h.digest("hex");
}

/**
 * Compare two manifests. Returns the per-file findings and the metadata that
 * differs (different Node or VITE_* values explain a finding; a different
 * commit or lockfile makes the comparison meaningless, so it is an error).
 */
export function compareManifests(a, b) {
  for (const m of [a, b]) if (m?.schema !== MANIFEST_SCHEMA) throw new Error(`not a ${MANIFEST_SCHEMA} manifest`);
  const errors = [];
  if (a.commit && b.commit && a.commit !== b.commit) errors.push(`different commits: ${a.commit} vs ${b.commit}`);
  if (a.lockfileSha256 && b.lockfileSha256 && a.lockfileSha256 !== b.lockfileSha256) errors.push("different package-lock.json");
  const notes = [];
  if (a.node && b.node && a.node !== b.node) notes.push(`Node ${a.node} vs ${b.node}`);
  const va = JSON.stringify(a.viteEnv ?? {});
  const vb = JSON.stringify(b.viteEnv ?? {});
  if (va !== vb) notes.push(`VITE_* variables differ: ${va} vs ${vb}`);
  const differs = [];
  const onlyA = [];
  const onlyB = [];
  const paths = [...new Set([...Object.keys(a.files), ...Object.keys(b.files)])].sort();
  for (const p of paths) {
    const x = a.files[p];
    const y = b.files[p];
    if (!y) onlyA.push(p);
    else if (!x) onlyB.push(p);
    else if (x.sha256 !== y.sha256) differs.push({ path: p, sizeA: x.size, sizeB: y.size });
  }
  const same = paths.length - differs.length - onlyA.length - onlyB.length;
  // Two empty builds prove nothing: identical needs at least one file.
  return { errors, notes, differs, onlyA, onlyB, same, total: paths.length, identical: paths.length > 0 && !errors.length && !differs.length && !onlyA.length && !onlyB.length };
}

export function formatComparison(r, labelA = "A", labelB = "B") {
  const lines = [];
  for (const e of r.errors) lines.push(`ERROR ${e}`);
  for (const n of r.notes) lines.push(`note  ${n}`);
  for (const d of r.differs) lines.push(`differs      ${d.path} (${d.sizeA} vs ${d.sizeB} bytes)`);
  for (const p of r.onlyA) lines.push(`only in ${labelA}: ${p}`);
  for (const p of r.onlyB) lines.push(`only in ${labelB}: ${p}`);
  const pct = r.total ? ((100 * r.same) / r.total).toFixed(2) : "0.00";
  lines.push(r.identical ? `IDENTICAL: ${r.total} files, the same SHA-256 on ${labelA} and ${labelB}` : `DIFFERENT: ${r.same}/${r.total} files identical (${pct} %), ${r.differs.length} differ, ${r.onlyA.length} only in ${labelA}, ${r.onlyB.length} only in ${labelB}`);
  return lines.join("\n");
}

/** diffoscope commands for the files that differ (run on the second host, plan W7.23 step 3). */
export function diffoscopeCommands(r, dirA, dirB) {
  return r.differs.map((d) => `diffoscope --text - ${JSON.stringify(`${dirA}/${d.path}`)} ${JSON.stringify(`${dirB}/${d.path}`)}`);
}

/** One ledger line (JSONL) per compared commit. */
export function ledgerEntry(r, a, b, when = new Date()) {
  return { at: when.toISOString(), commit: a.commit ?? b.commit ?? "unknown", builders: [a.builder ?? "A", b.builder ?? "B"], identical: r.identical, same: r.same, total: r.total, differs: r.differs.map((d) => d.path), onlyA: r.onlyA, onlyB: r.onlyB };
}

/**
 * The acceptance "10 consecutive commits: 100 % identical": the newest run of
 * identical commits in the ledger (one verdict per commit: its latest line).
 */
export function streak(entries) {
  const latest = new Map();
  for (const e of entries) latest.set(e.commit, e);
  let n = 0;
  for (const e of [...latest.values()].sort((x, y) => (x.at < y.at ? 1 : -1))) {
    if (!e.identical) break;
    n++;
  }
  return n;
}

/**
 * The in-toto Statement W7.22 signs: one subject per dist file (so any single
 * file can be checked against it), predicate = both builders and the digest of
 * the whole file list.
 */
export function attestationStatement(a, b, r) {
  if (!r.identical) throw new Error("only an identical comparison can be attested");
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: Object.keys(a.files)
      .sort()
      .map((name) => ({ name, digest: { sha256: a.files[name].sha256 } })),
    predicateType: PREDICATE_TYPE,
    predicate: {
      commit: a.commit,
      lockfileSha256: a.lockfileSha256,
      filesDigest: filesDigest(a),
      fileCount: r.total,
      identical: true,
      builders: [a, b].map((m) => ({ id: m.builder, node: m.node, platform: m.platform, builtAt: m.builtAt })),
    },
  };
}

/** Where each host serves its manifest: Vercel inside the app's dist, the Cloudflare Worker at its root. */
export const manifestUrl = (base, host = "vercel") => `${String(base).replace(/\/+$/, "")}/${host === "cloudflare" ? "lumen-build.json" : MANIFEST_PATH}`;
