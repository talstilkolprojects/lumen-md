/**
 * What a JavaScript chunk is made of (plan W1.36: the Excalidraw core chunk).
 *
 * Two views of one file:
 * - **modules**: esbuild's unminified output (Excalidraw's own dist/dev
 *   build) marks every module it inlines with a `// <path>` comment line.
 *   The bytes between two marks are that module's. They are summed per npm
 *   package (the path's last `node_modules/<name>` or `node_modules/@s/<name>`),
 *   so the biggest packages and any package inlined from two places (two
 *   copies, possibly two versions) stand out. Bytes before the first mark
 *   and modules outside any node_modules are the package's own code.
 * - **blobs**: inline payloads a minifier cannot shrink, in any build:
 *   `data:` URIs, and long base64 runs in string literals (an embedded wasm
 *   or font is the usual cause).
 *
 * Gzip sizes are per part, each gzipped on its own: they add up to more
 * than the file's gzip size, so read them as a ranking, and the file's
 * own `gzipKb` as the number the budget compares.
 */
import { gzipSync } from "node:zlib";

const KB = 1024;
const gz = (s) => gzipSync(Buffer.from(s, "utf8"), { level: 9 }).length;
const kb = (n) => Math.round((n / KB) * 10) / 10;

/** esbuild's module mark: a whole line `// path/to/file.ext`. */
const MARK = /^\/\/ ((?:\.\.?\/)*[\w@.\-+/]+\.(?:m?[jt]sx?|c?js|json|css|wasm))$/;

/** The npm package a module path belongs to, or "" for the chunk's own code. */
export function packageOf(modulePath) {
  const i = modulePath.lastIndexOf("node_modules/");
  if (i < 0) return "";
  const parts = modulePath.slice(i + "node_modules/".length).split("/");
  return parts[0].startsWith("@") && parts[1] ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** The node_modules folder a module was inlined from (to tell copies apart). */
function installOf(modulePath) {
  const name = packageOf(modulePath);
  if (!name) return "";
  const i = modulePath.lastIndexOf("node_modules/");
  return modulePath.slice(0, i + "node_modules/".length + name.length).replace(/^(?:\.\.?\/)+/, "");
}

/** Module regions by esbuild's `// path` marks; [] when the file has none (a minified build). */
export function moduleRegions(text) {
  const lines = text.split("\n");
  const regions = [];
  let cur = { path: "", start: 0, bytes: 0, text: [] };
  for (const line of lines) {
    const m = MARK.exec(line.trim());
    if (m) {
      if (cur.text.length) regions.push(cur);
      cur = { path: m[1], bytes: 0, text: [] };
    }
    cur.text.push(line);
    cur.bytes += Buffer.byteLength(line, "utf8") + 1;
  }
  if (cur.text.length) regions.push(cur);
  if (!regions.some((r) => r.path)) return [];
  return regions.map((r) => ({ path: r.path, bytes: r.bytes, text: r.text.join("\n") }));
}

/** Inline payloads: data: URIs and base64 runs of at least `minBytes`. */
export function inlineBlobs(text, minBytes = 4 * KB) {
  const out = [];
  const seen = new Set();
  const dataUri = /data:([\w.+-]+\/[\w.+-]+)?(?:;[\w=-]+)*;base64,([A-Za-z0-9+/]+=*)/g;
  for (let m; (m = dataUri.exec(text)); ) {
    if (m[2].length < minBytes) continue;
    out.push({ kind: "data-uri", mime: m[1] || "?", at: m.index, bytes: m[0].length, decodedBytes: Math.floor((m[2].length * 3) / 4) });
    seen.add(m.index + m[0].length - m[2].length);
  }
  const run = /[A-Za-z0-9+/]{256,}={0,2}/g;
  for (let m; (m = run.exec(text)); ) {
    if (m[0].length < minBytes || seen.has(m.index)) continue;
    // Real base64 mixes cases and digits; a long identifier-ish run does not.
    if (!/[0-9]/.test(m[0]) || !/[A-Z]/.test(m[0]) || !/[a-z]/.test(m[0])) continue;
    const head = Buffer.from(m[0].slice(0, 8), "base64");
    const mime = head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d ? "application/wasm" : head.toString("latin1", 0, 4) === "wOF2" ? "font/woff2" : "?";
    out.push({ kind: "base64", mime, at: m.index, bytes: m[0].length, decodedBytes: Math.floor((m[0].length * 3) / 4) });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** The anatomy of one chunk's text. */
export function anatomy(text, { top = 25, minBlobBytes = 4 * KB } = {}) {
  const bytes = Buffer.byteLength(text, "utf8");
  const regions = moduleRegions(text);
  const byPkg = new Map();
  for (const r of regions) {
    const name = packageOf(r.path) || "(own code)";
    const e = byPkg.get(name) ?? { name, bytes: 0, modules: 0, installs: new Set(), parts: [] };
    e.bytes += r.bytes;
    e.modules += 1;
    if (r.path && packageOf(r.path)) e.installs.add(installOf(r.path));
    e.parts.push(r.text);
    byPkg.set(name, e);
  }
  const packages = [...byPkg.values()]
    .map((e) => ({ name: e.name, kb: kb(e.bytes), gzipKb: kb(gz(e.parts.join("\n"))), share: Math.round((e.bytes / bytes) * 1000) / 10, modules: e.modules, installs: [...e.installs].sort() }))
    .sort((a, b) => b.kb - a.kb);
  const blobs = inlineBlobs(text, minBlobBytes).map((b) => ({ ...b, kb: kb(b.bytes), decodedKb: kb(b.decodedBytes) }));
  return {
    kb: kb(bytes),
    gzipKb: kb(gz(text)),
    marked: regions.length > 0,
    packages: packages.slice(0, top),
    morePackages: Math.max(0, packages.length - top),
    duplicates: packages.filter((p) => p.installs.length > 1).map((p) => ({ name: p.name, installs: p.installs })),
    blobs,
    blobKb: kb(blobs.reduce((n, b) => n + b.bytes, 0)),
  };
}

/** Plain-text report lines for one file. */
export function reportLines(file, a) {
  const out = [`${file}: ${a.kb} KB raw, ${a.gzipKb} KB gzip`];
  if (!a.marked) out.push("  no esbuild module marks (a minified build): run it on the same chunk in dist/dev for the per-package view");
  else {
    out.push("  packages (raw KB, own-gzip KB, share of raw, modules):");
    for (const p of a.packages) out.push(`    ${p.kb.toFixed(1).padStart(8)} ${p.gzipKb.toFixed(1).padStart(7)} ${`${p.share}%`.padStart(6)} ${String(p.modules).padStart(4)}  ${p.name}`);
    if (a.morePackages) out.push(`    … ${a.morePackages} more`);
    for (const d of a.duplicates) out.push(`  duplicate: ${d.name} inlined from ${d.installs.join(" and ")}`);
  }
  if (a.blobs.length) {
    out.push(`  inline blobs: ${a.blobs.length}, ${a.blobKb} KB raw`);
    for (const b of a.blobs.slice(0, 10)) out.push(`    ${b.kb.toFixed(1).padStart(8)} KB ${b.kind} ${b.mime} at ${b.at} (${b.decodedKb} KB decoded)`);
  } else out.push("  inline blobs: none");
  return out;
}
