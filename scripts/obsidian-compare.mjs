#!/usr/bin/env node
/**
 * Lumen's Bases against the real Obsidian (plan W6.34). The owner's check,
 * on a Mac with Obsidian 1.15 or later — see docs: project/obsidian-check.
 *
 *   npm run obsidian:compare -- prepare <vault>   write one probe .base per view, beside each .base
 *                                                 (and install the plugin into <vault>/.obsidian/plugins)
 *   … then in Obsidian: enable "Lumen compare", run "Lumen compare: run every probe"
 *   npm run obsidian:compare -- diff <vault>      Lumen's rows vs Obsidian's, per view; exit 1 on a difference
 *   npm run obsidian:compare -- clean <vault>     remove the probes and the results
 *
 * Lumen's side runs the app's own engine (src/views/bases) over the files on
 * disk, with their real sizes and times, as Obsidian does.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { diffMarkdown, diffResults, isProbe, lumenResults, probeBases, readResult, RESULTS_DIR } from "../src/views/bases/compare.ts";

const [cmd, vault, ...rest] = process.argv.slice(2);
if (!["prepare", "diff", "clean"].includes(cmd ?? "") || !vault) {
  console.error("usage: npm run obsidian:compare -- prepare|diff|clean <vault folder> [--out report.md]");
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".obsidian" || e.name === ".git" || e.name === ".trash" || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}
const read = (p) => readFileSync(join(vault, p), "utf8");
const bases = () => walk(vault).filter((p) => p.endsWith(".base")).map((p) => ({ path: p, text: read(p) }));

if (cmd === "prepare") {
  const { probes, skipped } = probeBases(bases());
  for (const p of probes) writeFileSync(join(vault, p.path), p.text);
  mkdirSync(join(vault, RESULTS_DIR), { recursive: true });
  writeFileSync(join(vault, "_lumen-compare", "probes.json"), JSON.stringify(probes.map(({ text: _t, ...p }) => p), null, 2) + "\n");
  const plugin = join(vault, ".obsidian", "plugins", "lumen-compare");
  mkdirSync(plugin, { recursive: true });
  for (const f of ["manifest.json", "main.js"]) copyFileSync(join(here, "..", "tools", "obsidian-lumen-compare", f), join(plugin, f));
  console.log(`${probes.length} probes written; plugin installed in .obsidian/plugins/lumen-compare`);
  for (const s of skipped) console.log(`skipped ${s}`);
} else if (cmd === "diff") {
  const all = walk(vault);
  const probeTexts = all.filter(isProbe).map((p) => ({ path: p, text: read(p) }));
  const index = JSON.parse(read("_lumen-compare/probes.json"));
  const probes = index.map((p) => ({ ...p, text: probeTexts.find((x) => x.path === p.path)?.text ?? "" }));
  const files = all.filter((p) => !p.startsWith("_lumen-compare/")).map((p) => {
    const st = statSync(join(vault, p));
    return { path: p, text: /\.(md|base)$/.test(p) ? read(p) : null, size: st.size, mtime: st.mtime, ctime: st.birthtime };
  });
  const { results, errors } = lumenResults(probes, files);
  const dir = join(vault, RESULTS_DIR);
  const obsidian = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "open-check.json").map((n) => readResult(readFileSync(join(dir, n), "utf8"))).filter(Boolean) : [];
  const d = diffResults(probes, results, obsidian);
  let md = diffMarkdown(d);
  if (errors.length) md += `\n## Lumen errors\n\n${errors.map((e) => `- ${e}`).join("\n")}\n`;
  const open = join(dir, "open-check.json");
  if (existsSync(open)) {
    const o = JSON.parse(readFileSync(open, "utf8"));
    const bad = o.filter((x) => !x.ok);
    md += `\n## Opened in Obsidian without a warning: ${o.length - bad.length}/${o.length}\n\n${bad.map((x) => `- ${x.path}: ${x.view}`).join("\n")}\n`;
  }
  const out = rest.includes("--out") ? rest[rest.indexOf("--out") + 1] : null;
  if (out) writeFileSync(out, md);
  else process.stdout.write(md);
  process.exit(d.lines.some((l) => l.status === "rows" || l.status === "missing") ? 1 : 0);
} else {
  for (const p of walk(vault).filter(isProbe)) rmSync(join(vault, p));
  rmSync(join(vault, "_lumen-compare"), { recursive: true, force: true });
  rmSync(join(vault, ".obsidian", "plugins", "lumen-compare"), { recursive: true, force: true });
  console.log("probes, results and the plugin removed");
}
