/**
 * Built the same on two infrastructures (plan W7.23): Vercel builds main, and
 * Cloudflare Workers Builds builds the same commit from the same lockfile.
 * Each build writes a manifest of its dist (`dist-manifest.mjs`); this file
 * compares two of them, keeps the streak of consecutive identical commits,
 * and states the result as an in-toto predicate for W7.22's attestation.
 * Pure: no network, no file system.
 */

export const MANIFEST_PATH = ".well-known/lumen-build.json";
export const PREDICATE_TYPE = "https://lumen-md.vercel.app/attestations/two-host-build/v1";
/** The plan's bar: this many consecutive commits with every file identical. */
export const STREAK_TARGET = 10;

/** A dist's manifest: every file's sha256, the manifest itself left out. Paths sorted. */
export function manifestOf(entries, meta) {
  const files = {};
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) if (e.path !== MANIFEST_PATH) files[e.path] = e.hash;
  return { v: 1, commit: meta.commit, lockfile: meta.lockfile, node: meta.node, host: meta.host, builtAt: meta.builtAt, files };
}

/** Per file: identical, different, or only on one host. `host`, `node` and `builtAt` are context, never compared. */
export function compareManifests(a, b) {
  if (a.commit !== b.commit) return { comparable: false, reason: `different commits: ${a.commit} vs ${b.commit}` };
  if (a.lockfile !== b.lockfile) return { comparable: false, reason: "different lockfiles for the same commit" };
  const differ = [];
  const onlyA = [];
  const onlyB = [];
  let same = 0;
  for (const [p, h] of Object.entries(a.files)) {
    if (!(p in b.files)) onlyA.push(p);
    else if (b.files[p] !== h) differ.push(p);
    else same++;
  }
  for (const p of Object.keys(b.files)) if (!(p in a.files)) onlyB.push(p);
  const total = same + differ.length + onlyA.length + onlyB.length;
  return { comparable: true, commit: a.commit, total, same, differ, onlyA, onlyB, identical: total > 0 && same === total };
}

/**
 * The history, one entry per main commit in order: `{commit, date, identical}`.
 * The streak is the number of consecutive identical commits at the end.
 */
export function withResult(history, entry) {
  const rest = history.filter((h) => h.commit !== entry.commit);
  return [...rest, entry];
}

export function streak(history) {
  let n = 0;
  for (let i = history.length - 1; i >= 0 && history[i].identical; i--) n++;
  return n;
}

/** An in-toto Statement v1 for W7.22: the subject is every dist file, the predicate says who built it and that both agreed. */
export function attestation(result, a, b) {
  if (!result.comparable || !result.identical) return null;
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: Object.entries(a.files).map(([name, hash]) => ({ name, digest: { sha256: hash } })),
    predicateType: PREDICATE_TYPE,
    predicate: {
      commit: result.commit,
      lockfile: a.lockfile,
      builders: [
        { host: a.host, node: a.node, builtAt: a.builtAt },
        { host: b.host, node: b.node, builtAt: b.builtAt },
      ],
      files: result.total,
      identical: true,
    },
  };
}

/** The report's lines, the differing files first (each one needs diffoscope). */
export function reportLines(result, history) {
  if (!result.comparable) return [`two-hosts: not comparable: ${result.reason}`];
  const lines = [`two-hosts ${result.commit.slice(0, 10)}: ${result.same}/${result.total} files identical${result.identical ? "" : ` — ${result.differ.length} differ, ${result.onlyA.length} only on the first host, ${result.onlyB.length} only on the second`}`];
  for (const p of result.differ.slice(0, 50)) lines.push(`  differs: ${p}`);
  for (const p of result.onlyA.slice(0, 20)) lines.push(`  only on the first: ${p}`);
  for (const p of result.onlyB.slice(0, 20)) lines.push(`  only on the second: ${p}`);
  lines.push(`streak: ${streak(history)} consecutive identical commits (target ${STREAK_TARGET})`);
  return lines;
}
