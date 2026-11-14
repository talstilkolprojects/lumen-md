#!/usr/bin/env node
/**
 * `npm run live:meta` (plan W6.2): after every production deploy, check that
 * the live site's metadata (canonical, Open Graph, Twitter, JSON-LD,
 * robots.txt, sitemap.xml) points only at lumen-md.vercel.app and never at
 * the domain that is not ours (scripts/lib/liveMeta.mjs).
 *
 *   npm run live:meta                                  # the production site
 *   npm run live:meta -- --url https://<preview>.vercel.app
 *   npm run live:meta -- --dir dist                    # a build, before it is deployed
 *   npm run live:meta -- --self-test                   # also prove the check catches planted references
 *   npm run live:meta -- --json out.json
 *
 * Fetches with Node's fetch, and with curl when fetch can't (curl honours
 * HTTPS_PROXY). The nightly (scripts/nightly/run.mjs, kind "triage") runs it
 * with --self-test. Exit 1 when the check or the self-test fails, with an
 * ALERT block on stderr.
 *
 * Every deploy path runs it too (audit W10.C29):
 *   - vercel-build.mjs: the `live:meta` gate checks dist/ — the exact files
 *     Vercel then deploys — on production and preview builds. A failure
 *     fails the build, so nothing is deployed and the commit status is red.
 *   - pages-deploy.sh: dist/ before the upload, the deployment URL after it.
 *   - release.mjs deploy-beta: the beta's deployment URL after the deploy.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkLiveMeta, OUR_HOST, PAGES, selfTest } from "./lib/liveMeta.mjs";

export function parseArgs(argv) {
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  return { url: (opt("--url") ?? `https://${OUR_HOST}`).replace(/\/+$/, ""), dir: opt("--dir"), json: opt("--json"), selfTest: argv.includes("--self-test") };
}

const pathOf = (name) => (name === "index.html" ? "/" : `/${name}`);

async function fetchOne(url) {
  try {
    const r = await fetch(url, { redirect: "follow", headers: { "cache-control": "no-cache" } });
    return { status: r.status, text: await r.text(), via: "fetch" };
  } catch (e) {
    const c = spawnSync("curl", ["-sS", "-L", "--max-time", "30", "-H", "cache-control: no-cache", "-w", "\n%{http_code}", url], { encoding: "utf8" });
    if (c.status !== 0) return { status: 0, text: "", via: "curl", error: `${e.message}; curl: ${(c.stderr || "").trim()}` };
    const i = c.stdout.lastIndexOf("\n");
    return { status: Number(c.stdout.slice(i + 1)), text: c.stdout.slice(0, i), via: "curl" };
  }
}

export async function loadPages(opts) {
  const pages = {};
  for (const name of PAGES) {
    if (opts.dir) {
      const f = join(resolve(opts.dir), name);
      if (existsSync(f)) pages[name] = { status: 200, text: readFileSync(f, "utf8"), source: f };
    } else pages[name] = { ...(await fetchOne(opts.url + pathOf(name))), source: opts.url + pathOf(name) };
  }
  return pages;
}

/**
 * Run the check (and the self-test when asked) → { ok, lines }. The deploy
 * paths call this after a deploy (scripts/release.mjs deploy-beta) or run
 * the CLI (scripts/pages-deploy.sh, the vercel-build gate on dist/).
 */
export async function liveMetaReport(opts) {
  const pages = await loadPages(opts);
  const r = checkLiveMeta(pages);
  for (const p of Object.values(pages)) if (p.error) r.problems.unshift(`${p.source}: ${p.error}`);
  const missed = opts.selfTest ? selfTest() : [];
  const ok = r.ok && !missed.length;
  const lines = [`live:meta ${opts.dir ? opts.dir : opts.url} — ${r.checked.length} URLs checked, ${r.problems.length} problem${r.problems.length === 1 ? "" : "s"}`];
  for (const c of r.checked) lines.push(`  ${c.page} ${c.where}: ${c.url}`);
  for (const p of r.problems) lines.push(`  ✗ ${p}`);
  if (opts.selfTest) lines.push(missed.length ? missed.map((m) => `  ✗ self-test ${m}`).join("\n") : "  ✓ self-test: every planted foreign reference was caught");
  lines.push(ok ? "live:meta: passed" : "live:meta: FAILED");
  return { ok, lines, problems: r.problems, checked: r.checked, missed };
}

/** The alert a failed check after a deploy prints (stderr), naming what to do. */
export function liveMetaAlert(target, problems) {
  return [
    `✗ ALERT live:meta: the deployment at ${target} names a host that is not ${OUR_HOST}.`,
    ...problems.slice(0, 20).map((p) => `  ${p}`),
    "  Roll back or redeploy a fixed build, then run `npm run live:meta -- --url <deployment>` again.",
  ].join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const r = await liveMetaReport(opts);
  console.log(r.lines.join("\n"));
  if (opts.json) writeFileSync(opts.json, JSON.stringify({ target: opts.dir ?? opts.url, at: new Date().toISOString(), ok: r.ok, problems: r.problems, checked: r.checked, selfTest: opts.selfTest ? { missed: r.missed } : null }, null, 2) + "\n");
  if (!r.ok) console.error(liveMetaAlert(opts.dir ?? opts.url, r.problems));
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
