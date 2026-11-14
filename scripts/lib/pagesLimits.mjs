/**
 * Plan W4.27: does dist/ fit Cloudflare Pages' Free plan? (the second host,
 * deployed by Direct Upload: `npm run pages:deploy`). Limits as published at
 * developers.cloudflare.com/pages/platform/limits (checked 12.11.2026):
 *   20,000 files per site, 25 MiB per file, 100 rules in _headers,
 *   2,000 static + 100 dynamic rules in _redirects.
 * Pure: takes the file list and the two rule files' text.
 */
export const LIMITS = { files: 20_000, fileBytes: 25 * 1024 * 1024, headerRules: 100, redirects: 2_100 };

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
  return { problems, oversize, totalBytes: files.reduce((s, f) => s + f.bytes, 0) };
}

/** The runtime a too-large file belongs to, for the message (dist/ruby/… → live-ruby). */
export function runtimeOf(path) {
  const top = path.split("/")[0];
  return { ruby: "live-ruby blocks (ruby.wasm)", pyodide: "live-python blocks (Pyodide)", ort: "on-device models (ONNX Runtime)", tesseract: "OCR (tesseract.js)", vad: "dictation voice detection" }[top] ?? null;
}
