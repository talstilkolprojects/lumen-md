#!/usr/bin/env node
/**
 * `npm run hosts:parity` (plan W6.9): Vercel and Cloudflare Pages serve the
 * same headers and routes (scripts/lib/hostParity.mjs).
 *
 *   node scripts/host-parity.mjs                 the checked-in configs (public/_headers,
 *                                                deploy/vercel.base.json) on public/ + the built files
 *   node scripts/host-parity.mjs --dist dist     a real build: dist/_headers with its endpoint
 *                                                origins, the real file list (pages:deploy runs this)
 *   node scripts/host-parity.mjs --live https://lumen-md.vercel.app https://lumen-md.pages.dev
 *                                                the two deployed origins, over the network
 *   --json                                       the report as JSON
 *
 * Exit 1 when a probe differs and the difference is not in ACCEPTED.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listFiles } from "./pages-check.mjs";
import { NOT_FOUND_DIRS } from "./lib/pagesLimits.mjs";
import { BUILT_FILES, PROBES, compareConfigs, liveProbe } from "./lib/hostParity.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function configReport({ root = ROOT, dist } = {}) {
  const vercelBase = JSON.parse(readFileSync(join(root, "deploy/vercel.base.json"), "utf8"));
  if (dist) {
    const files = listFiles(dist).map((f) => f.path);
    const extra = join(dist, ".csp-connect-extra");
    const origins = existsSync(extra) ? readFileSync(extra, "utf8").split(/\s+/).filter(Boolean) : [];
    const pagesExtra = NOT_FOUND_DIRS.map((d) => `${d}/404.html`).filter((f) => !files.includes(f));
    // The real chunk names replace the samples' AbC123 ones.
    const entry = files.find((f) => /^assets\/index-[\w-]+\.js$/.test(f));
    const probes = PROBES.filter(([p]) => !p.includes("AbC123") || (entry && p === "/assets/index-AbC123.js")).map(([p, w]) =>
      p === "/assets/index-AbC123.js" && entry ? [`/${entry}`, w] : [p, w],
    );
    return compareConfigs({ vercelBase, headersText: readFileSync(join(dist, "_headers"), "utf8"), files: files.filter((f) => !pagesExtra.includes(f)), pagesExtra, origins, probes });
  }
  const files = [...new Set([...listFiles(join(root, "public")).map((f) => f.path), ...BUILT_FILES])];
  return compareConfigs({
    vercelBase,
    headersText: readFileSync(join(root, "public/_headers"), "utf8"),
    files,
    pagesExtra: NOT_FOUND_DIRS.map((d) => `${d}/404.html`),
  });
}

export function format(report, labels = ["vercel", "pages"]) {
  const lines = [];
  for (const r of report.results) {
    const mark = r.same ? "✓" : r.accepted ? "≈" : "✗";
    const route = r.b.hops.length > 1 ? ` (${labels[1]}: ${r.b.hops.join(" → ")})` : "";
    lines.push(`${mark} ${r.path}  ${r.a.status}/${r.b.status}  ${r.why}${route}`);
    for (const d of r.diffs) lines.push(`    ${d}`);
    if (r.accepted) lines.push(`    accepted: ${r.accepted}`);
  }
  lines.push(`host-parity: ${report.same}/${report.results.length} the same, ${report.accepted} accepted difference(s), ${report.failed} failing`);
  return lines.join("\n");
}

async function main(argv) {
  const json = argv.includes("--json");
  const live = argv.indexOf("--live");
  let report;
  let labels = ["vercel", "pages"];
  if (live >= 0) {
    const [a, b] = argv.slice(live + 1, live + 3);
    if (!a || !b) {
      console.error("usage: host-parity.mjs --live <origin A> <origin B>");
      return 2;
    }
    const html = await (await fetch(a)).text();
    const entry = html.match(/\/assets\/index-[\w-]+\.js/)?.[0];
    const probes = PROBES.filter(([p]) => !p.includes("AbC123")).concat(entry ? [[entry, "the entry chunk"]] : []);
    report = await liveProbe(a, b, { probes });
    labels = [new URL(a).host, new URL(b).host];
  } else {
    const at = argv.indexOf("--dist");
    report = configReport({ dist: at >= 0 ? resolve(argv[at + 1]) : undefined });
  }
  if (json) console.log(JSON.stringify({ ...report, results: report.results.map(({ a, b, ...r }) => ({ ...r, status: [a.status, b.status], hops: [a.hops, b.hops] })) }, null, 2));
  else console.log(format(report, labels));
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
