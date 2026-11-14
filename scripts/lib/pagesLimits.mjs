/**
 * Plan W4.27: does dist/ fit Cloudflare Pages' Free plan? (the second host,
 * deployed by Direct Upload: `npm run pages:deploy`). Limits as published at
 * developers.cloudflare.com/pages/platform/limits (checked 12.11.2026):
 *   20,000 files per site, 25 MiB per file, 100 rules in _headers,
 *   2,000 static + 100 dynamic rules in _redirects.
 * And two the parser enforces silently (workers-sdk parseHeaders.ts /
 * parseRedirects.ts, plan W6.9): a _headers line over 2,000 characters and
 * a _redirects line over 1,000 are skipped, with the deploy still succeeding.
 * A top-level 404.html turns the single-page fallback off (every deep link
 * would answer 404), so it is a problem too.
 * Pure: takes the file list and the two rule files' text.
 */
export const LIMITS = { files: 20_000, fileBytes: 25 * 1024 * 1024, headerRules: 100, redirects: 2_100, headerLine: 2_000, redirectLine: 1_000 };

/**
 * Folders that answer a missing file with 404, as on Vercel, whose SPA
 * rewrite skips assets/ (deploy/vercel.base.json). Cloudflare Pages serves the
 * nearest 404.html up the tree and only then falls back to index.html, so a
 * 404.html inside the folder does it: a stale chunk after a deploy is a 404,
 * not the app's HTML with status 200 (which the browser would refuse as a
 * script with a MIME error the service worker cannot recover from).
 */
export const NOT_FOUND_DIRS = ["assets"];
export const NOT_FOUND_PAGE = "<!doctype html><meta charset=utf-8><title>404</title><p>Not found.\n";

function longLines(text, limit, file) {
  const out = [];
  String(text ?? "").split(/\r?\n/).forEach((line, i) => {
    if (line.length > limit) out.push(`${file}:${i + 1} is ${line.length} characters: Cloudflare skips lines over ${limit}`);
  });
  return out;
}

/** Rules in a `_headers` file: each unindented, non-comment line is a URL pattern that starts a rule. */
export function headerRuleCount(text) {
  return String(text ?? "").split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#") && !/^\s/.test(l)).length;
}

export function redirectRuleCount(text) {
  return String(text ?? "").split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#")).length;
}

/**
 * files: [{ path, bytes }] (POSIX paths relative to dist/)
 * → { problems: string[], oversize: [{ path, bytes }], totalBytes }
 */
export function pagesProblems(files, headersText, redirectsText, limits = LIMITS) {
  const problems = [];
  if (files.length > limits.files) problems.push(`${files.length} files: Cloudflare Pages allows ${limits.files}`);
  const oversize = files.filter((f) => f.bytes > limits.fileBytes).sort((a, b) => b.bytes - a.bytes);
  for (const f of oversize) problems.push(`${f.path} is ${(f.bytes / 1024 / 1024).toFixed(1)} MiB: over the ${limits.fileBytes / 1024 / 1024} MiB limit per file`);
  const h = headerRuleCount(headersText);
  if (h > limits.headerRules) problems.push(`_headers has ${h} rules: the limit is ${limits.headerRules}`);
  const r = redirectRuleCount(redirectsText);
  if (r > limits.redirects) problems.push(`_redirects has ${r} rules: the limit is ${limits.redirects}`);
  problems.push(...longLines(headersText, limits.headerLine, "_headers"), ...longLines(redirectsText, limits.redirectLine, "_redirects"));
  if (files.some((f) => f.path === "404.html")) problems.push("404.html at the top level turns Cloudflare's single-page fallback off: deep links would answer 404");
  return { problems, oversize, totalBytes: files.reduce((s, f) => s + f.bytes, 0) };
}

/** The runtime a too-large file belongs to, for the message (dist/ruby/… → live-ruby). */
export function runtimeOf(path) {
  const top = path.split("/")[0];
  return { ruby: "live-ruby blocks (ruby.wasm)", pyodide: "live-python blocks (Pyodide)", ort: "on-device models (ONNX Runtime)", tesseract: "OCR (tesseract.js)", vad: "dictation voice detection" }[top] ?? null;
}
