/**
 * The plugin registry as a site of its own (plan W6.35): static files for
 * Cloudflare Pages (the second host, #484/#518), built from the registry the
 * app ships (public/plugins/examples: index.json + scan.json).
 *
 *   v1/index.json                         every plugin, every version that passed its scan:
 *                                         its capabilities, scan grade and findings, and the
 *                                         SHA-256 and size of each file
 *   v1/plugins/<id>/<version>/<file>      the files themselves, never rewritten (immutable)
 *   SHA256SUMS                            `sha256sum -c` format, every served file but itself
 *   _headers                              nosniff, CORS for reads, code served as text/plain
 *   index.html                            a bilingual list (Hebrew first), no scripts
 *
 * A version whose scan failed is left out, as the gallery leaves it out.
 * `verifySite()` is what a mirror or a client runs: it recomputes every hash
 * and re-scans every version's code, so a host that changed a file, or lists
 * a version the scan would refuse, is caught.
 */
import { createHash } from "node:crypto";

export const SITE_SCHEMA = 1;
/** Cloudflare Pages limits (developers.cloudflare.com/pages/platform/limits, /configuration/headers). */
export const PAGES_LIMITS = { files: 20_000, fileBytes: 25 * 1024 * 1024, headerRules: 100, headerLineChars: 2_000 };

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const HEADERS = `# Built by scripts/registry-site.mjs (plan W6.35). Lines stay under 2,000 characters (Pages skips longer ones).
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Access-Control-Allow-Origin: *
  Access-Control-Allow-Methods: GET, HEAD
  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
  Cache-Control: public, max-age=300
/v1/plugins/*
  Content-Type: text/plain; charset=utf-8
  Cache-Control: public, max-age=31536000, immutable
/v1/index.json
  Cache-Control: no-cache
/SHA256SUMS
  Content-Type: text/plain; charset=utf-8
  Cache-Control: no-cache
`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Build the site in memory. `source` = { index, scan, read(path, file) → Buffer|string }
 * (path = the version's folder in public/plugins/examples). Returns { files: Map<path, Buffer>, index, skipped }.
 */
export function buildSite({ index, scan, read, commit = null }) {
  const files = new Map();
  const skipped = [];
  const plugins = [];
  for (const p of index.plugins) {
    const versions = [];
    for (const v of p.versions) {
      const r = scan.results.find((x) => x.id === p.id && x.version === v.version);
      if (!r || !r.passed) {
        skipped.push(`${p.id}@${v.version}: ${r ? "failed its scan" : "not scanned"}`);
        continue;
      }
      if (!SAFE_SEGMENT.test(p.id) || !SAFE_SEGMENT.test(v.version)) throw new Error(`unsafe id or version for a path: ${p.id}@${v.version}`);
      const manifestText = String(read(v.path, "lumen-plugin.json"));
      const manifest = JSON.parse(manifestText);
      const names = ["lumen-plugin.json", manifest.main, ...(manifest.ui ? [manifest.ui] : [])];
      const listed = {};
      for (const name of names) {
        if (!SAFE_SEGMENT.test(name)) throw new Error(`unsafe file name in ${p.id}@${v.version}: ${name}`);
        const buf = Buffer.from(read(v.path, name));
        files.set(`v1/plugins/${p.id}/${v.version}/${name}`, buf);
        listed[name] = { sha256: sha256(buf), bytes: buf.length };
      }
      if (listed[manifest.main].sha256 !== v.sha256) throw new Error(`${p.id}@${v.version}: main's SHA-256 is not the one index.json lists (run node scripts/build-plugin-registry.mjs)`);
      versions.push({
        version: v.version,
        url: `plugins/${p.id}/${v.version}/`,
        main: manifest.main,
        sha256: v.sha256,
        files: listed,
        license: manifest.license,
        capabilities: manifest.capabilities ?? [],
        scan: { scanner: scan.scanner, passed: true, grade: r.grade, score: r.score, findings: r.findings },
      });
    }
    if (!versions.length) continue;
    const latest = versions[versions.length - 1];
    const m = JSON.parse(String(files.get(`v1/plugins/${p.id}/${latest.version}/lumen-plugin.json`)));
    plugins.push({ id: p.id, name: m.name, description: m.description ?? "", author: m.author ?? "", latest: latest.version, versions });
  }
  const siteIndex = { schema: SITE_SCHEMA, about: "Lumen's static plugin registry (plan W6.35). Every version listed passed the registry scan; verify with: npm run registry:verify -- <this site's URL>.", source: commit, plugins };
  files.set("v1/index.json", Buffer.from(JSON.stringify(siteIndex, null, 2) + "\n"));
  files.set("_headers", Buffer.from(HEADERS));
  files.set("index.html", Buffer.from(page(plugins)));
  // _headers is read by Pages, not served, so it is not in the sums a client checks.
  const sums = [...files.keys()].filter((k) => k !== "_headers").sort().map((k) => `${sha256(files.get(k))}  ${k}`).join("\n") + "\n";
  files.set("SHA256SUMS", Buffer.from(sums));
  return { files, index: siteIndex, skipped };
}

function page(plugins) {
  const rows = plugins
    .map((p) => `<tr><td><b>${esc(p.name)}</b><br><code>${esc(p.id)}</code></td><td>${esc(p.latest)}</td><td dir="auto">${esc(p.description)}</td><td>${esc(p.versions[p.versions.length - 1].scan.grade)}</td><td><code>${esc(p.versions[p.versions.length - 1].sha256.slice(0, 16))}…</code></td></tr>`)
    .join("\n");
  return `<!doctype html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Lumen — רישום התוספים · Plugin registry</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:16px;max-width:60rem}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ccc;padding:6px;text-align:start;vertical-align:top}code{font-size:.85em}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}</style></head>
<body>
<h1>רישום התוספים של Lumen</h1>
<p>כל גרסה כאן עברה את סריקת הבטיחות. הקוד מוגש כטקסט, וכל קובץ רשום עם ה-SHA-256 שלו ב-<a href="v1/index.json">v1/index.json</a> וב-<a href="SHA256SUMS">SHA256SUMS</a>. מתקינים מתוך Lumen: גלריית התוספים ← תוספים בארגז חול.</p>
<p lang="en" dir="ltr">Every version here passed the safety scan. Code is served as text, and every file is listed with its SHA-256 in <a href="v1/index.json">v1/index.json</a> and <a href="SHA256SUMS">SHA256SUMS</a>. Install from inside Lumen: Plugin Gallery → Sandboxed plugins.</p>
<table><thead><tr><th>תוסף · Plugin</th><th>גרסה</th><th>תיאור</th><th>ציון</th><th>SHA-256</th></tr></thead>
<tbody>
${rows}
</tbody></table>
</body></html>
`;
}

/** The Pages limits a site must stay within; returns the problems (empty = fits). */
export function pagesProblems(files) {
  const out = [];
  if (files.size > PAGES_LIMITS.files) out.push(`${files.size} files > ${PAGES_LIMITS.files}`);
  for (const [k, v] of files) if (v.length > PAGES_LIMITS.fileBytes) out.push(`${k}: ${v.length} bytes > 25 MiB`);
  const headers = String(files.get("_headers") ?? "");
  const rules = headers.split("\n").filter((l) => l.startsWith("/")).length;
  if (rules > PAGES_LIMITS.headerRules) out.push(`_headers: ${rules} rules > ${PAGES_LIMITS.headerRules}`);
  for (const l of headers.split("\n")) if (l.length > PAGES_LIMITS.headerLineChars) out.push(`_headers: a line of ${l.length} characters`);
  return out;
}

/**
 * Check a built or hosted site. `get(path)` → Promise<Buffer|null>. `scanVersion({manifest, main, ui})` → the scan result.
 * Returns { ok, problems, versions } — every file's hash, SHA256SUMS, and a fresh scan of every listed version.
 */
export async function verifySite({ get, scanVersion }) {
  const problems = [];
  const raw = await get("v1/index.json");
  if (!raw) return { ok: false, problems: ["v1/index.json is missing"], versions: 0 };
  const index = JSON.parse(String(raw));
  if (index.schema !== SITE_SCHEMA) problems.push(`schema ${index.schema}, expected ${SITE_SCHEMA}`);
  let versions = 0;
  for (const p of index.plugins ?? []) {
    for (const v of p.versions ?? []) {
      versions++;
      const at = `v1/plugins/${p.id}/${v.version}/`;
      const texts = {};
      for (const [name, want] of Object.entries(v.files ?? {})) {
        const buf = await get(at + name);
        if (!buf) {
          problems.push(`${at}${name} is missing`);
          continue;
        }
        if (sha256(buf) !== want.sha256 || buf.length !== want.bytes) problems.push(`${at}${name}: SHA-256 or size differs from v1/index.json`);
        texts[name] = String(buf);
      }
      if (v.files?.[v.main]?.sha256 !== v.sha256) problems.push(`${p.id}@${v.version}: the listed sha256 is not main's`);
      const manifestText = texts["lumen-plugin.json"];
      if (manifestText === undefined || texts[v.main] === undefined) continue;
      const manifest = JSON.parse(manifestText);
      const r = await scanVersion({ manifest: manifestText, main: texts[v.main], ...(manifest.ui && texts[manifest.ui] !== undefined ? { ui: texts[manifest.ui] } : {}) });
      if (!r.passed) problems.push(`${p.id}@${v.version}: fails the scan here (${r.findings.map((f) => f.rule).join(", ")})`);
      if (r.id !== p.id || r.version !== v.version) problems.push(`${p.id}@${v.version}: the manifest says ${r.id}@${r.version}`);
    }
  }
  const sums = await get("SHA256SUMS");
  if (!sums) problems.push("SHA256SUMS is missing");
  else
    for (const line of String(sums).split("\n").filter(Boolean)) {
      const [hash, path] = line.split(/\s+/);
      const buf = await get(path);
      if (!buf) problems.push(`SHA256SUMS lists ${path}, which is missing`);
      else if (sha256(buf) !== hash) problems.push(`${path}: differs from SHA256SUMS`);
    }
  return { ok: problems.length === 0, problems, versions };
}
