#!/usr/bin/env node
/**
 * Plan W4.4 / 15.18: scan built JavaScript for secrets — the live
 * deployments, a local dist/, or files saved from a deployment.
 *
 *   npm run secrets:scan-live                       # Vercel: production + the 3 latest READY previews
 *   node scripts/secrets-scan-live.mjs --url https://lumen-md.vercel.app [--url …]
 *   node scripts/secrets-scan-live.mjs --dir dist   # a local build (also a Vercel gate)
 *   node scripts/secrets-scan-live.mjs --files <label> a.js b.js …   # files saved from a deployment
 *   node scripts/secrets-scan-live.mjs --self-test  # plants tokens in a temporary build and finds them
 *
 * Options: --report <file.md>, --json <file.json>.
 *
 * Vercel mode needs VERCEL_TOKEN, and VERCEL_PROJECT_ID / VERCEL_TEAM_ID
 * (or --project / --team, or .vercel/project.json). It reads the project's
 * environment-variable NAMES (never decrypts a value) and checks the VITE_*
 * ones against security/vite-env-allowlist.json, then crawls each
 * deployment from its index.html through every chunk it references.
 * Protected previews take VERCEL_AUTOMATION_BYPASS_SECRET.
 *
 * Exit 1 on any secret-level finding or VITE_* name not on the allowlist,
 * 2 on a usage or network error, 0 otherwise. Reports mask every value.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assetRefs, mergeScans, scanText } from "./lib/liveSecrets.mjs";
import { checkViteEnv, loadAllowlist } from "./lib/viteEnvAllowlist.mjs";

const TEXT = /\.(m?[jt]sx?|cjs|css|html|json|txt|webmanifest|svg|md)$/i;
const MAX_FILES = 3000;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (TEXT.test(name)) yield p;
  }
}

/** Scan every text file under `dir`. */
export function scanDir(dir, label = dir, allowlist = loadAllowlist()) {
  const scans = [];
  let bytes = 0;
  for (const file of walk(dir)) {
    const text = readFileSync(file, "utf8");
    bytes += text.length;
    scans.push(scanText(relative(dir, file), text, allowlist));
  }
  return { label, files: scans.length, bytes, ...mergeScans(scans) };
}

/** Scan files saved from a deployment (e.g. fetched by another tool). */
export function scanFiles(label, paths, allowlist = loadAllowlist()) {
  const scans = [];
  let bytes = 0;
  for (const p of paths) {
    const text = readFileSync(p, "utf8");
    bytes += text.length;
    scans.push(scanText(p.split("/").pop(), text, allowlist));
  }
  return { label, files: scans.length, bytes, ...mergeScans(scans) };
}

/** Crawl a deployment from `/` through every referenced chunk, and scan it. */
export async function scanUrl(base, { label = base, headers = {}, fetchImpl = fetch, allowlist = loadAllowlist() } = {}) {
  const origin = new URL(base).origin;
  const queue = ["/"];
  const done = new Set();
  const scans = [];
  const errors = [];
  let bytes = 0;
  while (queue.length && done.size < MAX_FILES) {
    const path = queue.shift();
    if (done.has(path)) continue;
    done.add(path);
    let text;
    try {
      const res = await fetchImpl(origin + path, { headers, redirect: "follow" });
      if (!res.ok) {
        errors.push(`${path}: HTTP ${res.status}`);
        continue;
      }
      text = await res.text();
    } catch (e) {
      errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    bytes += text.length;
    scans.push(scanText(path, text, allowlist));
    for (const ref of assetRefs(text)) if (!done.has(ref) && ref.endsWith(".js")) queue.push(ref);
  }
  return { label, url: origin, files: scans.length, bytes, errors, ...mergeScans(scans) };
}

async function vercelApi(path, token) {
  const res = await fetch(`https://api.vercel.com${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Vercel API ${path.split("?")[0]}: HTTP ${res.status}`);
  return res.json();
}

/**
 * The project's environment-variable names and targets. The API returns
 * encrypted values for most types; they are dropped here unread.
 */
export async function vercelEnvNames({ token, project, team }) {
  const q = team ? `?teamId=${encodeURIComponent(team)}` : "";
  const body = await vercelApi(`/v10/projects/${encodeURIComponent(project)}/env${q}`, token);
  return (body.envs ?? []).map((e) => ({ name: e.key, target: e.target ?? [] }));
}

/** Production (newest READY) and the `previews` newest READY previews. */
export async function vercelTargets({ token, project, team, previews = 3 }) {
  const q = new URLSearchParams({ projectId: project, limit: "50", state: "READY" });
  if (team) q.set("teamId", team);
  const body = await vercelApi(`/v6/deployments?${q}`, token);
  const list = (body.deployments ?? []).sort((a, b) => b.created - a.created);
  const prod = list.find((d) => d.target === "production");
  const pre = list.filter((d) => d.target !== "production").slice(0, previews);
  return [...(prod ? [{ ...prod, kind: "production" }] : []), ...pre.map((d) => ({ ...d, kind: "preview" }))].map((d) => ({
    label: `${d.kind} ${d.uid ?? d.id} (${d.meta?.githubCommitRef ?? "?"} @${(d.meta?.githubCommitSha ?? "").slice(0, 9)})`,
    url: `https://${d.url}`,
  }));
}

/** Whether a scan result fails: a secret-level finding. */
export const failing = (result) => result.findings.some((f) => f.level === "secret");

/** Markdown report of one run. */
export function renderReport({ generatedAt, targets, env }) {
  const lines = [`# Live secret scan — ${generatedAt}`, ""];
  if (env) {
    lines.push("## Environment variables (names only, values never read)", "");
    lines.push(env.names.length ? `${env.names.length} set: ${env.names.map((n) => n.name).join(", ")}` : "None set.");
    lines.push(`VITE_* not on the allowlist: ${env.disallowed.length ? env.disallowed.join(", ") : "none"}.`, "");
  }
  for (const t of targets) {
    const secrets = t.findings.filter((f) => f.level === "secret");
    const review = t.findings.filter((f) => f.level === "review");
    lines.push(`## ${t.label}`, "");
    if (t.url) lines.push(`URL: ${t.url}`);
    lines.push(`Files scanned: ${t.files} (${Math.round(t.bytes / 1024)} KB). Secrets: **${secrets.length}**. For review: ${review.length}.`);
    if (t.errors?.length) lines.push(`Fetch errors: ${t.errors.length} (${t.errors.slice(0, 5).join("; ")})`);
    if (t.viteEnv.length) {
      lines.push("", "Inlined VITE_* names:", "");
      for (const v of t.viteEnv) lines.push(`- ${v.name}: ${v.set ? "set" : "empty"}, ${v.allowed ? "on the allowlist" : "**not on the allowlist**"}`);
    }
    if (secrets.length || review.length) {
      lines.push("", "| level | kind | file | value (masked) | context |", "|---|---|---|---|---|");
      for (const f of [...secrets, ...review]) {
        lines.push(`| ${f.level} | ${f.kind} | ${f.file} | ${f.value} | \`${f.context.replace(/[|`]/g, "")}\` |`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Tokens built at run time, so this file holds none. */
function plantedTokens() {
  const rep = (c, n) => c.repeat(n);
  return {
    "openai-key": "sk-" + "proj-" + rep("A1b2", 8),
    "anthropic-key": "sk-" + "ant-" + "api03-" + rep("Zz9_", 8),
    "github-token": "gh" + "p_" + rep("a1B2c3", 6),
    "google-api-key": "AI" + "za" + "Sy" + rep("D3", 16) + "x",
    jwt:
      Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url") +
      "." +
      Buffer.from('{"role":"service_role","iss":"planted"}').toString("base64url") +
      "." +
      rep("s1g", 8),
    "vite-unlisted": "planted-vite-value-" + rep("q", 12),
  };
}

/** Plant one token of each kind in a temporary build and check each is found. */
export function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "lumen-secrets-selftest-"));
  try {
    const t = plantedTokens();
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), '<script type="module" src="/assets/app-x.js"></script>');
    writeFileSync(
      join(dir, "assets", "app-x.js"),
      `const a=\`${t["openai-key"]}\`,b="${t["anthropic-key"]}",c='${t["github-token"]}',d="${t["google-api-key"]}",e="${t.jwt}";` +
        `const env={BASE_URL:\`/\`,MODE:\`production\`,VITE_SUPABASE_URL:\`https://x.supabase.co\`,VITE_PLANTED_TOKEN:\`${t["vite-unlisted"]}\`};`,
    );
    const result = scanDir(dir, "self-test");
    const found = new Set(result.findings.filter((f) => f.level === "secret").map((f) => f.kind));
    const missing = Object.keys(t).filter((k) => !found.has(k));
    const leaked = result.findings.some((f) => Object.values(t).some((v) => f.value.includes(v) || f.context.includes(v)));
    return { ok: missing.length === 0 && !leaked, missing, leaked, found: [...found].sort() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function args(argv) {
  const out = { urls: [], files: null, dir: null, report: null, json: null, selfTest: false, project: null, team: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.urls.push(argv[++i]);
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--files") {
      const label = argv[++i];
      const paths = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) paths.push(argv[++i]);
      out.files = { label, paths };
    } else if (a === "--report") out.report = argv[++i];
    else if (a === "--json") out.json = argv[++i];
    else if (a === "--project") out.project = argv[++i];
    else if (a === "--team") out.team = argv[++i];
    else if (a === "--self-test") out.selfTest = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function vercelScope(opts) {
  let project = opts.project ?? process.env.VERCEL_PROJECT_ID;
  let team = opts.team ?? process.env.VERCEL_TEAM_ID ?? process.env.VERCEL_ORG_ID;
  if ((!project || !team) && existsSync(".vercel/project.json")) {
    const p = JSON.parse(readFileSync(".vercel/project.json", "utf8"));
    project ??= p.projectId;
    team ??= p.orgId;
  }
  return { project, team };
}

async function main(argv) {
  const opts = args(argv);
  if (opts.selfTest) {
    const r = selfTest();
    if (!r.ok) {
      console.error(`✗ self-test: missed ${r.missing.join(", ") || "nothing"}${r.leaked ? "; a report carried an unmasked value" : ""}`);
      return 1;
    }
    console.log(`✓ self-test: every planted token found (${r.found.join(", ")}), all masked in the report`);
    return 0;
  }
  const allowlist = loadAllowlist();
  const targets = [];
  let env = null;
  if (opts.dir) {
    const dir = resolve(opts.dir);
    if (!existsSync(dir)) {
      console.error(`${dir} does not exist: build first.`);
      return 2;
    }
    targets.push(scanDir(dir, `local build ${relative(process.cwd(), dir) || dir}`, allowlist));
  } else if (opts.files) {
    targets.push(scanFiles(opts.files.label, opts.files.paths, allowlist));
  } else {
    const headers = {};
    if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    let urls = opts.urls.map((u) => ({ label: u, url: u }));
    if (!urls.length) {
      const token = process.env.VERCEL_TOKEN;
      const { project, team } = vercelScope(opts);
      if (!token || !project) {
        console.error("Vercel mode needs VERCEL_TOKEN and VERCEL_PROJECT_ID (or --project); or pass --url / --dir / --files.");
        return 2;
      }
      const names = await vercelEnvNames({ token, project, team });
      const vite = Object.fromEntries(names.filter((n) => n.name.startsWith("VITE_")).map((n) => [n.name, "set"]));
      env = { names, ...checkViteEnv(vite, allowlist) };
      urls = await vercelTargets({ token, project, team });
    }
    for (const u of urls) targets.push(await scanUrl(u.url, { label: u.label, headers, allowlist }));
  }
  const run = { generatedAt: new Date().toISOString(), targets, env };
  if (opts.report) writeFileSync(opts.report, renderReport(run));
  if (opts.json) writeFileSync(opts.json, JSON.stringify(run, null, 2));
  let bad = env?.disallowed.length ?? 0;
  for (const t of targets) {
    const s = t.findings.filter((f) => f.level === "secret");
    const r = t.findings.length - s.length;
    console.log(`${s.length ? "✗" : "✓"} ${t.label}: ${t.files} files, ${s.length} secret(s), ${r} for review`);
    for (const f of s) console.error(`  ${f.kind} in ${f.file}: ${f.value}`);
    if (s.length) bad++;
  }
  if (env?.disallowed.length) console.error(`✗ VITE_* set in Vercel and not on the allowlist: ${env.disallowed.join(", ")}`);
  return bad ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    },
  );
}
