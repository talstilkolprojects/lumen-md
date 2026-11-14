#!/usr/bin/env node
/**
 * `npm run pages:check` (plan W4.27): check dist/ against Cloudflare Pages'
 * Free-plan limits before a Direct Upload (scripts/pages-deploy.sh).
 *
 *   node scripts/pages-check.mjs                  report; exit 1 on a problem
 *   node scripts/pages-check.mjs --dist <dir>     another build folder
 *   node scripts/pages-check.mjs --drop-oversize  remove files over 25 MiB from dist/
 *                                                 and list them in dist/pages-dropped.json
 *   node scripts/pages-check.mjs --prepare        --drop-oversize, and write the 404.html
 *                                                 pages of NOT_FOUND_DIRS (pages:deploy)
 *
 * A dropped file is a runtime the Cloudflare copy then lacks: its block says the
 * runtime is not installed, like the Docker image's `slim` variant. Everything
 * else is byte-for-byte the build the other hosts serve.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import { NOT_FOUND_DIRS, NOT_FOUND_PAGE, pagesProblems, runtimeOf } from "./lib/pagesLimits.mjs";

export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push({ path: relative(dir, p).split("\\").join("/"), bytes: st.size });
    }
  };
  walk(dir);
  return out;
}

function main() {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const at = process.argv.indexOf("--dist");
  const dist = at > 0 ? resolve(process.argv[at + 1]) : join(root, "dist");
  if (!existsSync(join(dist, "index.html"))) {
    console.error("pages:check: dist/ is not built (npm run build first)");
    process.exit(2);
  }
  const prepare = process.argv.includes("--prepare");
  const drop = prepare || process.argv.includes("--drop-oversize");
  if (prepare) {
    for (const dir of NOT_FOUND_DIRS) {
      mkdirSync(join(dist, dir), { recursive: true });
      writeFileSync(join(dist, dir, "404.html"), NOT_FOUND_PAGE);
      console.log(`pages:check: wrote ${dir}/404.html (a missing file there answers 404, as on Vercel)`);
    }
  }
  const read = (f) => (existsSync(join(dist, f)) ? readFileSync(join(dist, f), "utf8") : "");
  const files = listFiles(dist);
  const r = pagesProblems(files, read("_headers"), read("_redirects"));
  console.log(`pages:check: ${files.length} files, ${(r.totalBytes / 1e6).toFixed(1)} MB in dist/`);
  const others = r.problems.filter((p) => !r.oversize.some((f) => p.startsWith(f.path + " ")));
  if (drop && r.oversize.length) {
    for (const f of r.oversize) rmSync(join(dist, f.path));
    const dropped = r.oversize.map((f) => ({ ...f, runtime: runtimeOf(f.path) }));
    writeFileSync(join(dist, "pages-dropped.json"), JSON.stringify({ reason: "Cloudflare Pages: 25 MiB per file", dropped }, null, 2) + "\n");
    for (const f of dropped) console.log(`  dropped ${f.path} (${(f.bytes / 1024 / 1024).toFixed(1)} MiB)${f.runtime ? ` — ${f.runtime} are unavailable on this copy` : ""}`);
  }
  const failed = drop ? others : r.problems;
  for (const p of failed) console.log(`  ✗ ${p}`);
  console.log(failed.length ? "pages:check: does not fit Cloudflare Pages" : "pages:check: fits Cloudflare Pages (Free)");
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
